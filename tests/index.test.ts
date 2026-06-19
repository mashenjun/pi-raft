import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piRaftExtension from "../extensions/index";
import type { ActiveState } from "../extensions/state-machine";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

interface Harness {
  appended: Array<{ type: "custom"; customType: string; data: unknown }>;
  notifications: Array<{ message: string; type?: string }>;
  emit(eventName: string, event: Record<string, unknown>): Promise<any>;
}

let originalHome: string | undefined;
let tempRoot: string;
let testCwd: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  tempRoot = mkdtempSync(join(tmpdir(), "pi-raft-"));
  testCwd = join(tempRoot, "cwd");
  mkdirSync(testCwd, { recursive: true });
  process.env.HOME = join(tempRoot, "home");
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

function createHarness(initialEntries: any[] = []): Harness {
  const handlers: Record<string, Handler[]> = {};
  const entries = [...initialEntries];
  const appended: Harness["appended"] = [];
  const notifications: Harness["notifications"] = [];

  const pi = {
    on(eventName: string, handler: Handler) {
      handlers[eventName] ??= [];
      handlers[eventName].push(handler);
    },
    appendEntry(customType: string, data: unknown) {
      const entry = { type: "custom" as const, customType, data };
      appended.push(entry);
      entries.push(entry);
    },
  } as unknown as ExtensionAPI;

  piRaftExtension(pi);

  const ctx = {
    cwd: testCwd,
    sessionManager: {
      getEntries: () => entries,
    },
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
  };

  return {
    appended,
    notifications,
    async emit(eventName: string, event: Record<string, unknown>): Promise<any> {
      for (const handler of handlers[eventName] ?? []) {
        const result = await handler(event, ctx);
        if (result) return result;
      }
      return undefined;
    },
  };
}

function bash(command: string): Record<string, unknown> {
  return {
    type: "tool_call",
    toolCallId: `bash:${command}`,
    toolName: "bash",
    input: { command },
  };
}

function write(content: string): Record<string, unknown> {
  return {
    type: "tool_call",
    toolCallId: `write:${content}`,
    toolName: "write",
    input: { path: "test.ts", content },
  };
}

function edit(newText: string): Record<string, unknown> {
  return {
    type: "tool_call",
    toolCallId: `edit:${newText}`,
    toolName: "edit",
    input: {
      path: "test.ts",
      edits: [{ oldText: "old", newText }],
    },
  };
}

function latestState(harness: Harness): ActiveState {
  return harness.appended[harness.appended.length - 1].data as ActiveState;
}

async function reachClaimed(harness: Harness): Promise<void> {
  expect(await harness.emit("tool_call", bash("raft msg read --channel general"))).toBeUndefined();
  expect(await harness.emit("tool_call", bash("raft task claim 42"))).toBeUndefined();
}

async function reachInReview(harness: Harness): Promise<void> {
  await reachClaimed(harness);
  expect(
    await harness.emit("tool_call", bash("raft task update --number 42 --status in_review")),
  ).toBeUndefined();
}

describe("pi-raft extension integration", () => {
  it("allows the F1 happy path from IDLE to DONE", async () => {
    const harness = createHarness();

    const earlyWrite = await harness.emit("tool_call", write("console.log('early');"));
    expect(earlyWrite).toMatchObject({ block: true });
    expect(earlyWrite.reason).toContain("msg read");

    expect(await harness.emit("tool_call", bash("raft msg read --channel general"))).toBeUndefined();
    expect(latestState(harness).currentState).toBe("MESSAGES_READ");

    expect(await harness.emit("tool_call", bash("raft task claim 42"))).toBeUndefined();
    expect(latestState(harness)).toMatchObject({
      currentState: "TASK_CLAIMED",
      taskId: "42",
    });

    expect(
      await harness.emit("tool_call", bash("raft task update --number 42 --status in_review")),
    ).toBeUndefined();
    expect(latestState(harness).currentState).toBe("IN_REVIEW");

    expect(await harness.emit("tool_call", write("console.log('hello');"))).toBeUndefined();

    expect(
      await harness.emit(
        "tool_call",
        bash('raft msg post --channel general --thread ts_abc "done"'),
      ),
    ).toBeUndefined();
    expect(latestState(harness).currentState).toBe("DONE");
  });

  it("blocks credential-bearing raft posts before state transition", async () => {
    const harness = createHarness();
    await reachInReview(harness);
    const appendCount = harness.appended.length;

    const result = await harness.emit(
      "tool_call",
      bash('raft msg post --channel general --thread ts_abc "token=abc123"'),
    );

    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain("Credential detected");
    expect(harness.appended).toHaveLength(appendCount);
    expect(latestState(harness).currentState).toBe("IN_REVIEW");
  });

  it("blocks credentials in write and edit content", async () => {
    const harness = createHarness();
    await reachClaimed(harness);

    const writeResult = await harness.emit("tool_call", write("API_KEY=secret-value"));
    expect(writeResult).toMatchObject({ block: true });
    expect(writeResult.reason).toContain("Credential detected");

    const editResult = await harness.emit("tool_call", edit("const token = 'slock_secret_abc123';"));
    expect(editResult).toMatchObject({ block: true });
    expect(editResult.reason).toContain("Credential detected");
  });

  it("warns instead of blocking when strictMode is false", async () => {
    mkdirSync(join(testCwd, ".pi"), { recursive: true });
    writeFileSync(join(testCwd, ".pi", "pi-raft.json"), '{"strictMode":false}');
    const harness = createHarness();

    const result = await harness.emit("tool_call", write("console.log('early');"));

    expect(result).toBeUndefined();
    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0]).toMatchObject({ type: "warning" });
    expect(harness.notifications[0].message).toContain("msg read");
  });

  it("allows non-raft chained shell commands", async () => {
    const harness = createHarness();

    expect(await harness.emit("tool_call", bash("echo hello && echo done"))).toBeUndefined();
    expect(harness.appended).toHaveLength(0);
  });

  it("blocks shell file redirection before the claim gate", async () => {
    const harness = createHarness();

    expect(await harness.emit("tool_call", bash('echo "claim gate check"'))).toBeUndefined();
    const result = await harness.emit(
      "tool_call",
      bash('echo "claim gate check" > /tmp/pi-raft-direct-write-check.txt'),
    );

    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain("shell file redirection");
    expect(result.reason).toContain("msg read");
    expect(harness.appended).toHaveLength(0);
  });

  it("blocks raft commands with shell mutations before the claim gate", async () => {
    const harness = createHarness();

    const chainedResult = await harness.emit(
      "tool_call",
      bash("raft msg read --channel general && echo data > file.txt"),
    );
    expect(chainedResult).toMatchObject({ block: true });
    expect(chainedResult.reason).toContain("shell file redirection");
    expect(chainedResult.reason).toContain("msg read");
    expect(harness.appended).toHaveLength(0);

    const redirectedResult = await harness.emit(
      "tool_call",
      bash("raft msg read --channel general > file.txt"),
    );
    expect(redirectedResult).toMatchObject({ block: true });
    expect(redirectedResult.reason).toContain("shell file redirection");
    expect(redirectedResult.reason).toContain("msg read");
    expect(harness.appended).toHaveLength(0);
  });

  it("blocks tee after a pipe before the claim gate", async () => {
    const harness = createHarness();

    for (const command of [
      "echo data | tee file.txt",
      "echo err |& tee file.txt",
      "echo ok & touch file.txt",
      "echo ok\n touch file.txt",
    ]) {
      const result = await harness.emit("tool_call", bash(command));
      expect(result).toMatchObject({ block: true });
      expect(result.reason).toContain("shell file mutation");
      expect(result.reason).toContain("msg read");
    }
    expect(harness.appended).toHaveLength(0);
  });

  it("blocks nested shell writes before the claim gate", async () => {
    const harness = createHarness();

    for (const command of [
      "bash -lc 'echo data > file.txt'",
      "bash --norc -c 'touch file.txt'",
      "env -i bash -lc 'touch file.txt'",
      "env -S 'touch file.txt'",
      'env --split-string=\'bash -lc "touch file.txt"\'',
      "sudo -u root bash -lc 'touch file.txt'",
      "sudo -D /tmp bash -lc 'touch file.txt'",
      "sudo --chdir /tmp bash -lc 'touch file.txt'",
    ]) {
      const result = await harness.emit("tool_call", bash(command));
      expect(result).toMatchObject({ block: true });
      expect(result.reason).toMatch(/shell file (redirection|mutation)/);
      expect(result.reason).toContain("msg read");
    }
    expect(harness.appended).toHaveLength(0);
  });

  it("blocks worktree-mutating git commands before the claim gate", async () => {
    const harness = createHarness();

    for (const command of [
      "git restore README.md",
      "git clean -fd",
      "git -C repo clean -fd",
      "git reset --hard",
      "git checkout -- README.md",
      "git checkout main",
      "git -C repo checkout main",
      "git switch feature",
    ]) {
      const result = await harness.emit("tool_call", bash(command));
      expect(result).toMatchObject({ block: true });
      expect(result.reason).toContain("shell file mutation");
      expect(result.reason).toContain("msg read");
    }
    expect(harness.appended).toHaveLength(0);
  });

  it("allows git clean dry-runs before the claim gate", async () => {
    const harness = createHarness();

    expect(await harness.emit("tool_call", bash("git clean -nd"))).toBeUndefined();
    expect(await harness.emit("tool_call", bash("git clean --dry-run -d"))).toBeUndefined();
    expect(await harness.emit("tool_call", bash("git -C repo clean -nd"))).toBeUndefined();
    expect(harness.appended).toHaveLength(0);
  });

  it("allows non-executing sudo modes before the claim gate", async () => {
    const harness = createHarness();

    expect(await harness.emit("tool_call", bash("sudo -l touch file.txt"))).toBeUndefined();
    expect(await harness.emit("tool_call", bash("sudo -v"))).toBeUndefined();
    expect(await harness.emit("tool_call", bash("sudo -K"))).toBeUndefined();
    expect(harness.appended).toHaveLength(0);

    const result = await harness.emit("tool_call", bash("sudo -u root touch file.txt"));
    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain("shell file mutation");
  });

  it("blocks tar extraction before the claim gate", async () => {
    const harness = createHarness();

    for (const command of [
      "tar -xzf archive.tgz",
      "tar xf archive.tar",
      "tar --get -f archive.tar",
    ]) {
      const result = await harness.emit("tool_call", bash(command));
      expect(result).toMatchObject({ block: true });
      expect(result.reason).toContain("shell file mutation");
      expect(result.reason).toContain("msg read");
    }
    expect(harness.appended).toHaveLength(0);
  });

  it("blocks shell mutations after raft commands that clear the active claim", async () => {
    const harness = createHarness();
    await reachInReview(harness);
    const appendCount = harness.appended.length;

    const result = await harness.emit(
      "tool_call",
      bash("raft msg read --channel general && echo data > file.txt"),
    );

    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain("clears the active claim");
    expect(harness.appended).toHaveLength(appendCount);
    expect(latestState(harness)).toMatchObject({
      currentState: "IN_REVIEW",
      taskId: "42",
    });

    const newlineResult = await harness.emit(
      "tool_call",
      bash("raft msg read --channel general\necho data > file.txt"),
    );

    expect(newlineResult).toMatchObject({ block: true });
    expect(newlineResult.reason).toContain("clears the active claim");
    expect(harness.appended).toHaveLength(appendCount);
    expect(latestState(harness)).toMatchObject({
      currentState: "IN_REVIEW",
      taskId: "42",
    });
  });

  it("blocks shell mutations after intermediate raft commands that clear the active claim", async () => {
    mkdirSync(join(testCwd, ".pi"), { recursive: true });
    writeFileSync(join(testCwd, ".pi", "pi-raft.json"), '{"maxRaftCommandsPerCall":3}');
    const harness = createHarness();
    await reachInReview(harness);
    const appendCount = harness.appended.length;

    const result = await harness.emit(
      "tool_call",
      bash("raft msg read --channel general && echo data > file.txt && raft task claim 43"),
    );

    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain("clears the active claim");
    expect(harness.appended).toHaveLength(appendCount);
    expect(latestState(harness)).toMatchObject({
      currentState: "IN_REVIEW",
      taskId: "42",
    });
  });

  it("allows shell file redirection after a task is claimed", async () => {
    const harness = createHarness();
    await reachClaimed(harness);

    expect(
      await harness.emit("tool_call", bash('echo "claim gate check" > "/tmp/pi-raft-direct-write-check.txt"')),
    ).toBeUndefined();
  });

  it("blocks multiple raft commands in one bash call", async () => {
    const harness = createHarness();

    const result = await harness.emit(
      "tool_call",
      bash("raft msg read && raft task claim 42"),
    );

    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain("Multiple raft commands");
    expect(harness.appended).toHaveLength(0);
  });

  it("does not advance state on raft task help commands", async () => {
    const harness = createHarness();
    await reachClaimed(harness);
    const appendCount = harness.appended.length;

    expect(await harness.emit("tool_call", bash("raft task status --help"))).toBeUndefined();
    expect(latestState(harness).currentState).toBe("TASK_CLAIMED");

    expect(await harness.emit("tool_call", bash("raft task update --help"))).toBeUndefined();
    expect(latestState(harness).currentState).toBe("TASK_CLAIMED");
    expect(harness.appended).toHaveLength(appendCount);
  });

  it("clears active state when messages are read during review", async () => {
    const harness = createHarness();
    await reachInReview(harness);

    expect(await harness.emit("tool_call", bash("raft msg read --channel general"))).toBeUndefined();

    expect(latestState(harness)).toMatchObject({
      currentState: "MESSAGES_READ",
      taskId: null,
      replyTarget: null,
    });

    const result = await harness.emit("tool_call", write("console.log('stale');"));
    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain("claim a task");
  });

  it("allows raft task list as a read-only no-op from IN_REVIEW", async () => {
    const harness = createHarness();
    await reachInReview(harness);
    const appendCount = harness.appended.length;

    expect(
      await harness.emit("tool_call", bash('raft task list --channel "#pi-raft"')),
    ).toBeUndefined();

    expect(latestState(harness)).toMatchObject({
      currentState: "IN_REVIEW",
      taskId: "42",
    });
    expect(harness.appended).toHaveLength(appendCount);
  });

  it("allows task completion and the next task claim after a fresh read", async () => {
    const harness = createHarness();
    await reachInReview(harness);

    expect(
      await harness.emit("tool_call", bash("raft task update --number 42 --status done")),
    ).toBeUndefined();
    expect(latestState(harness)).toMatchObject({
      currentState: "DONE",
      taskId: null,
      replyTarget: null,
    });

    const directClaim = await harness.emit("tool_call", bash("raft task claim 27"));
    expect(directClaim).toMatchObject({ block: true });
    expect(directClaim.reason).toContain("msg read");

    expect(await harness.emit("tool_call", bash("raft msg read --channel general"))).toBeUndefined();
    expect(latestState(harness).currentState).toBe("MESSAGES_READ");

    expect(await harness.emit("tool_call", bash("raft task claim 27"))).toBeUndefined();
    expect(latestState(harness)).toMatchObject({
      currentState: "TASK_CLAIMED",
      taskId: "27",
      replyTarget: null,
    });
  });

  it("blocks file edits after task completion until the next task is claimed", async () => {
    const harness = createHarness();
    await reachInReview(harness);

    expect(
      await harness.emit("tool_call", bash("raft task update --number 42 --status done")),
    ).toBeUndefined();

    const doneWrite = await harness.emit("tool_call", write("console.log('done');"));
    expect(doneWrite).toMatchObject({ block: true });
    expect(doneWrite.reason).toContain("msg read");

    expect(await harness.emit("tool_call", bash("raft msg read --channel general"))).toBeUndefined();
    const beforeClaimEdit = await harness.emit("tool_call", edit("console.log('before claim');"));
    expect(beforeClaimEdit).toMatchObject({ block: true });
    expect(beforeClaimEdit.reason).toContain("claim a task");

    expect(await harness.emit("tool_call", bash("raft task claim 27"))).toBeUndefined();
    expect(await harness.emit("tool_call", write("console.log('next');"))).toBeUndefined();
  });

  it("blocks task completion when the update number does not match the active task", async () => {
    const harness = createHarness();
    await reachInReview(harness);

    const result = await harness.emit(
      "tool_call",
      bash("raft task update --number 27 --status done"),
    );

    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain("active task is #42");
    expect(latestState(harness)).toMatchObject({
      currentState: "IN_REVIEW",
      taskId: "42",
    });
  });

  it("blocks in_review updates when the update number does not match the active task", async () => {
    const harness = createHarness();
    await reachClaimed(harness);

    const result = await harness.emit(
      "tool_call",
      bash("raft task update --number 27 --status in_review"),
    );

    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain("active task is #42");
    expect(latestState(harness)).toMatchObject({
      currentState: "TASK_CLAIMED",
      taskId: "42",
    });
  });

  it("blocks normalized raft message send before IN_REVIEW and stores its target when allowed", async () => {
    const harness = createHarness();
    await reachClaimed(harness);

    const blocked = await harness.emit(
      "tool_call",
      bash('raft message send --target "#pi-raft:a70a2306" "too early"'),
    );
    expect(blocked).toMatchObject({ block: true });
    expect(blocked.reason).toContain("in_review");

    expect(
      await harness.emit("tool_call", bash("raft task update --number 42 --status in_review")),
    ).toBeUndefined();
    expect(
      await harness.emit(
        "tool_call",
        bash('raft message send --target "#pi-raft:a70a2306" "done"'),
      ),
    ).toBeUndefined();

    expect(latestState(harness)).toMatchObject({
      currentState: "DONE",
      taskId: "42",
      replyTarget: {
        channel: "#pi-raft",
        threadTs: "a70a2306",
      },
    });
  });

  it("restores persisted state before injecting context", async () => {
    const harness = createHarness([
      {
        type: "custom",
        customType: "pi-raft-state",
        data: {
          currentState: "IN_REVIEW",
          taskId: "42",
          replyTarget: { channel: "general", threadTs: "ts_abc" },
        },
      },
    ]);

    await harness.emit("session_start", { type: "session_start", reason: "reload" });
    const result = await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "continue",
      systemPrompt: "base",
      systemPromptOptions: {},
    });

    expect(result.systemPrompt).toContain("base");
    expect(result.systemPrompt).toContain("[Slock] State: IN_REVIEW");
    expect(result.systemPrompt).toContain("Task: #42");
    expect(await harness.emit("tool_call", write("console.log('resume');"))).toBeUndefined();
  });

  it("resets stale active state for a fresh non-continuation prompt", async () => {
    const harness = createHarness([
      {
        type: "custom",
        customType: "pi-raft-state",
        data: {
          currentState: "IN_REVIEW",
          taskId: "33",
          replyTarget: null,
        },
      },
    ]);

    await harness.emit("session_start", { type: "session_start", reason: "reload" });
    const promptResult = await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "Direct write check: create /tmp/pi-raft-direct-write-check.txt directly; no need to claim.",
      systemPrompt: "base",
      systemPromptOptions: {},
    });

    expect(promptResult.systemPrompt).toContain("[Slock] State: IDLE");
    expect(latestState(harness)).toMatchObject({
      currentState: "IDLE",
      taskId: null,
      replyTarget: null,
    });

    const writeResult = await harness.emit(
      "tool_call",
      bash('echo "claim gate check" > /tmp/pi-raft-direct-write-check.txt'),
    );
    expect(writeResult).toMatchObject({ block: true });
    expect(writeResult.reason).toContain("msg read");
  });

  it("preserves post-reply approval prompts so the task can be marked done", async () => {
    const harness = createHarness([
      {
        type: "custom",
        customType: "pi-raft-state",
        data: {
          currentState: "DONE",
          taskId: "42",
          replyTarget: { channel: "general", threadTs: "ts_abc" },
        },
      },
    ]);

    await harness.emit("session_start", { type: "session_start", reason: "reload" });
    const promptResult = await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "Approved, mark done",
      systemPrompt: "base",
      systemPromptOptions: {},
    });
    expect(promptResult.systemPrompt).toContain("[Slock] State: DONE");
    expect(promptResult.systemPrompt).toContain("Task: #42");

    expect(
      await harness.emit("tool_call", bash("raft task update --number 42 --status done")),
    ).toBeUndefined();
    expect(latestState(harness)).toMatchObject({
      currentState: "DONE",
      taskId: null,
      replyTarget: null,
    });
  });

  it("preserves approval-only DONE prompts", async () => {
    for (const prompt of ["LGTM", "Looks good", "Approved"]) {
      const harness = createHarness([
        {
          type: "custom",
          customType: "pi-raft-state",
          data: {
            currentState: "DONE",
            taskId: "42",
            replyTarget: { channel: "general", threadTs: "ts_abc" },
          },
        },
      ]);

      await harness.emit("session_start", { type: "session_start", reason: "reload" });
      const promptResult = await harness.emit("before_agent_start", {
        type: "before_agent_start",
        prompt,
        systemPrompt: "base",
        systemPromptOptions: {},
      });

      expect(promptResult.systemPrompt).toContain("[Slock] State: DONE");
      expect(promptResult.systemPrompt).toContain("Task: #42");
    }
  });

  it("resets DONE state for fresh prompts containing completion verbs", async () => {
    const harness = createHarness([
      {
        type: "custom",
        customType: "pi-raft-state",
        data: {
          currentState: "DONE",
          taskId: "42",
          replyTarget: { channel: "general", threadTs: "ts_abc" },
        },
      },
    ]);

    await harness.emit("session_start", { type: "session_start", reason: "reload" });
    const promptResult = await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "Update README",
      systemPrompt: "base",
      systemPromptOptions: {},
    });

    expect(promptResult.systemPrompt).toContain("[Slock] State: IDLE");
    expect(latestState(harness)).toMatchObject({
      currentState: "IDLE",
      taskId: null,
      replyTarget: null,
    });
  });

  it("ignores unrelated bare issue numbers during same-task continuation", async () => {
    const harness = createHarness([
      {
        type: "custom",
        customType: "pi-raft-state",
        data: {
          currentState: "IN_REVIEW",
          taskId: "42",
          replyTarget: null,
        },
      },
    ]);

    await harness.emit("session_start", { type: "session_start", reason: "reload" });
    const promptResult = await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "Continue task #42 for GitHub issue #13.",
      systemPrompt: "base",
      systemPromptOptions: {},
    });

    expect(promptResult.systemPrompt).toContain("[Slock] State: IN_REVIEW");
    expect(promptResult.systemPrompt).toContain("Task: #42");
    expect(await harness.emit("tool_call", write("console.log('same task');"))).toBeUndefined();
  });

  it("resets stale state when a continuation prompt names a different bare task id", async () => {
    const harness = createHarness([
      {
        type: "custom",
        customType: "pi-raft-state",
        data: {
          currentState: "IN_REVIEW",
          taskId: "42",
          replyTarget: null,
        },
      },
    ]);

    await harness.emit("session_start", { type: "session_start", reason: "reload" });
    const promptResult = await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "Continue #43",
      systemPrompt: "base",
      systemPromptOptions: {},
    });

    expect(promptResult.systemPrompt).toContain("[Slock] State: IDLE");
    expect(latestState(harness)).toMatchObject({
      currentState: "IDLE",
      taskId: null,
      replyTarget: null,
    });

    const result = await harness.emit("tool_call", write("console.log('wrong task');"));
    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain("msg read");
  });

  it("resets stale state when a prompt mentions the old task but assigns a new task", async () => {
    const harness = createHarness([
      {
        type: "custom",
        customType: "pi-raft-state",
        data: {
          currentState: "IN_REVIEW",
          taskId: "42",
          replyTarget: null,
        },
      },
    ]);

    await harness.emit("session_start", { type: "session_start", reason: "reload" });
    const promptResult = await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "Stop work on task #42 and handle task #43.",
      systemPrompt: "base",
      systemPromptOptions: {},
    });

    expect(promptResult.systemPrompt).toContain("[Slock] State: IDLE");
    expect(latestState(harness)).toMatchObject({
      currentState: "IDLE",
      taskId: null,
      replyTarget: null,
    });
  });

  it("requires a task-id boundary before preserving stale state", async () => {
    const harness = createHarness([
      {
        type: "custom",
        customType: "pi-raft-state",
        data: {
          currentState: "IN_REVIEW",
          taskId: "4",
          replyTarget: null,
        },
      },
    ]);

    await harness.emit("session_start", { type: "session_start", reason: "reload" });
    const promptResult = await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "Task #43 needs a fresh fix.",
      systemPrompt: "base",
      systemPromptOptions: {},
    });

    expect(promptResult.systemPrompt).toContain("[Slock] State: IDLE");
    expect(latestState(harness)).toMatchObject({
      currentState: "IDLE",
      taskId: null,
      replyTarget: null,
    });
  });

  it("does not treat negated continuation wording as a continuation", async () => {
    const harness = createHarness([
      {
        type: "custom",
        customType: "pi-raft-state",
        data: {
          currentState: "IN_REVIEW",
          taskId: "42",
          replyTarget: null,
        },
      },
    ]);

    await harness.emit("session_start", { type: "session_start", reason: "reload" });
    const promptResult = await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "Do not continue the previous task; start the new ticket.",
      systemPrompt: "base",
      systemPromptOptions: {},
    });

    expect(promptResult.systemPrompt).toContain("[Slock] State: IDLE");
    expect(latestState(harness)).toMatchObject({
      currentState: "IDLE",
      taskId: null,
      replyTarget: null,
    });
  });

  it("blocks stale prior-task completion after claiming the next task", async () => {
    const harness = createHarness();
    expect(await harness.emit("tool_call", bash("raft msg read --channel general"))).toBeUndefined();
    expect(await harness.emit("tool_call", bash("raft task claim --number 29"))).toBeUndefined();
    expect(
      await harness.emit("tool_call", bash("raft task update --number 29 --status in_review")),
    ).toBeUndefined();

    await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "Task #30 needs a fresh fix.",
      systemPrompt: "base",
      systemPromptOptions: {},
    });
    expect(latestState(harness).currentState).toBe("IDLE");

    expect(await harness.emit("tool_call", bash("raft msg read --channel general"))).toBeUndefined();
    expect(await harness.emit("tool_call", bash("raft task claim --number 30"))).toBeUndefined();
    const result = await harness.emit(
      "tool_call",
      bash("raft task update --number 29 --status done --channel '#pi-raft'"),
    );

    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain("active task is #30");
    expect(latestState(harness)).toMatchObject({
      currentState: "TASK_CLAIMED",
      taskId: "30",
    });
  });

  it("blocks stale post-reply task completion after a fresh prompt", async () => {
    const harness = createHarness();
    await reachInReview(harness);
    expect(
      await harness.emit("tool_call", bash('raft message send --target "#pi-raft:a70a2306" "done"')),
    ).toBeUndefined();
    expect(latestState(harness)).toMatchObject({
      currentState: "DONE",
      taskId: "42",
    });

    await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "Task #43 needs a fresh fix.",
      systemPrompt: "base",
      systemPromptOptions: {},
    });
    expect(latestState(harness)).toMatchObject({
      currentState: "IDLE",
      taskId: null,
    });

    const result = await harness.emit(
      "tool_call",
      bash("raft task update --number 42 --status done --channel '#pi-raft'"),
    );

    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain("msg read");
  });

  it("respects context injection config", async () => {
    mkdirSync(join(testCwd, ".pi"), { recursive: true });
    writeFileSync(
      join(testCwd, ".pi", "pi-raft.json"),
      '{"injectContext":true,"contextVerbosity":"full"}',
    );
    const harness = createHarness();

    const result = await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "continue",
      systemPrompt: "base",
      systemPromptOptions: {},
    });

    expect(result.systemPrompt).toContain("Slock Workflow Status:");
  });

  it("can disable context injection", async () => {
    mkdirSync(join(testCwd, ".pi"), { recursive: true });
    writeFileSync(join(testCwd, ".pi", "pi-raft.json"), '{"injectContext":false}');
    const harness = createHarness();

    const result = await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "continue",
      systemPrompt: "base",
      systemPromptOptions: {},
    });

    expect(result).toBeUndefined();
  });
});
