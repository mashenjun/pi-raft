import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piRaftExtension from "../extensions/index";
import type { ActiveState } from "../extensions/state-machine";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

interface Harness {
  appended: Array<{ type: "custom"; customType: string; data: unknown }>;
  emit(eventName: string, event: Record<string, unknown>): Promise<any>;
}

function createHarness(initialEntries: any[] = []): Harness {
  const handlers: Record<string, Handler[]> = {};
  const entries = [...initialEntries];
  const appended: Harness["appended"] = [];

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
    sessionManager: {
      getEntries: () => entries,
    },
  };

  return {
    appended,
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
    await harness.emit("tool_call", bash("raft task status in_review 42")),
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
      await harness.emit("tool_call", bash("raft task status in_review 42")),
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

  it("allows non-raft chained shell commands", async () => {
    const harness = createHarness();

    expect(await harness.emit("tool_call", bash("echo hello && echo done"))).toBeUndefined();
    expect(harness.appended).toHaveLength(0);
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
});
