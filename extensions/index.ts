import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scanCredentials } from "./credential-scanner";
import {
  detectDuplicateCommand,
  hasChainingOperators,
  parseRaftCommands,
} from "./raft-parser";
import { createStateMachine } from "./state-machine";
import type { ActiveState, RaftAction, SlockState } from "./state-machine";
import { buildSlockContext } from "./context-builder";

const sm = createStateMachine();

export default function (pi: ExtensionAPI): void {
  function persistState(): void {
    pi.appendEntry("pi-raft-state", sm.snapshot());
  }

  pi.on("session_start", (_event, ctx) => {
    let latest: ActiveState | null = null;

    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== "pi-raft-state") continue;
      const data = (entry as { data?: ActiveState }).data;
      if (data && typeof data.currentState === "string") {
        latest = data;
      }
    }

    if (latest) {
      sm.restore(latest);
      console.log(`[pi-raft] restored state: ${latest.currentState}`);
    }
  });

  pi.on("session_shutdown", () => {
    persistState();
  });

  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName === "bash") {
      const command = getBashCommand(event.input);
      if (!command) {
        return;
      }

      if (hasChainingOperators(command)) {
        return blockToolCall(
          buildBlockMessage(
            "Multiple raft commands chained in one call. Split them into separate calls.",
            sm.snapshot().currentState,
          ),
        );
      }

      const raftCommands = parseRaftCommands(command);
      if (raftCommands.length > 0) {
        if (detectDuplicateCommand(raftCommands)) {
          return blockToolCall(
            buildBlockMessage(
              "Duplicate raft command detected.",
              sm.snapshot().currentState,
            ),
          );
        }

        for (const parsed of raftCommands) {
          const before = sm.snapshot();
          const result = sm.transition(toRaftAction(parsed));

          if (!result.allowed) {
            return blockToolCall(buildBlockMessage(result.reason, before.currentState));
          }

          persistState();

          const after = sm.snapshot();
          console.log(
            `[pi-raft] state ${before.currentState} -> ${after.currentState}` +
              (after.taskId ? ` | task: ${after.taskId}` : ""),
          );
        }

        return;
      }

      const credentialMatch = scanCredentials(command);
      if (credentialMatch) {
        return blockToolCall(
          `Blocked: Credential detected: '${credentialMatch}'. Remove it before posting.`,
        );
      }

      return;
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const canWrite = sm.canWrite();
      if (!canWrite.allowed) {
        return blockToolCall(
          buildBlockMessage(
            canWrite.reason ?? "must claim a task first (raft task claim <task-id>)",
            sm.snapshot().currentState,
          ),
        );
      }

      return;
    }

    return;
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    const context = buildSlockContext(sm.snapshot());
    return {
      systemPrompt: event.systemPrompt + "\n\n" + context,
    };
  });
}

function getBashCommand(input: unknown): string {
  if (!input || typeof input !== "object") {
    return "";
  }

  const maybeCommand = (input as { command?: unknown }).command;
  return typeof maybeCommand === "string" ? maybeCommand : "";
}

function toRaftAction(parsed: {
  noun: RaftAction["noun"];
  verb: string;
  args: Record<string, string>;
}): RaftAction {
  return {
    noun: parsed.noun,
    verb: parsed.verb,
    args: parsed.args,
  };
}

function blockToolCall(reason: string): { block: true; reason: string } {
  return {
    block: true,
    reason,
  };
}

function buildBlockMessage(reason: string, currentState: SlockState): string {
  const lines = [`Blocked: ${reason}`, `Current state: ${currentState}`];

  if (currentState === "IDLE") {
    lines.push(
      "→ Next: raft msg read --channel <channel>",
      "→ Then: raft task claim <task-id>",
    );
  } else if (currentState === "MESSAGES_READ") {
    lines.push(
      "→ Next: raft task claim <task-id>",
      "→ Then: raft task status in_review <task-id>",
    );
  } else if (currentState === "TASK_CLAIMED") {
    lines.push(
      "→ Next: raft task status in_review <task-id>",
      '→ Then: raft msg post --channel <channel> --thread <ts> "your reply"',
    );
  } else if (currentState === "IN_REVIEW") {
    lines.push(
      '→ Next: raft msg post --channel <channel> --thread <ts> "your reply"',
      "→ Then: raft msg read --channel <channel>",
    );
  } else if (currentState === "DONE") {
    lines.push(
      "→ Next: raft msg read --channel <channel>",
      "→ Then: raft task claim <task-id>",
    );
  }

  return lines.join("\n");
}
