import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { loadPiRaftConfig } from "./config";
import type { PiRaftConfig } from "./config";
import { scanCredentials } from "./credential-scanner";
import {
  detectDuplicateCommand,
  parseRaftCommands,
} from "./raft-parser";
import { createStateMachine } from "./state-machine";
import type { ActiveState, RaftAction, SlockState } from "./state-machine";
import { buildSlockContext } from "./context-builder";

export default function (pi: ExtensionAPI): void {
  const sm = createStateMachine();

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

  pi.on("tool_call", async (event, ctx) => {
    const config = loadConfigForContext(ctx);

    if (event.toolName === "bash") {
      const command = getBashCommand(event.input);
      if (!command) {
        return;
      }

      const credentialMatch = scanCredentials(command, config.credentialPatterns);
      if (credentialMatch) {
        return handleViolation(
          config,
          ctx,
          `Blocked: Credential detected: '${credentialMatch}'. Remove it before posting.`,
        );
      }

      const raftCommands = parseRaftCommands(command, {
        raftCommand: config.raftCommand,
      });
      if (raftCommands.length > config.maxRaftCommandsPerCall) {
        const reason = detectDuplicateCommand(raftCommands)
          ? "Duplicate raft command detected."
          : "Multiple raft commands in one call. Split them into separate calls.";
        return handleViolation(
          config,
          ctx,
          buildBlockMessage(
            reason,
            sm.snapshot().currentState,
          ),
        );
      }

      if (raftCommands.length > 0) {
        for (const parsed of raftCommands) {
          const before = sm.snapshot();
          const result = sm.transition(toRaftAction(parsed));

          if (!result.allowed) {
            return handleViolation(
              config,
              ctx,
              buildBlockMessage(result.reason, before.currentState),
            );
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

      return;
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const mutationText = getMutationText(event.toolName, event.input);
      const credentialMatch = scanCredentials(mutationText, config.credentialPatterns);
      if (credentialMatch) {
        return handleViolation(
          config,
          ctx,
          `Blocked: Credential detected: '${credentialMatch}'. Remove it before writing.`,
        );
      }

      const canWrite = sm.canWrite();
      if (!canWrite.allowed) {
        return handleViolation(
          config,
          ctx,
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

  pi.on("before_agent_start", async (event, ctx) => {
    const config = loadConfigForContext(ctx);
    if (!config.injectContext) {
      return;
    }

    const context = buildSlockContext(sm.snapshot(), config.contextVerbosity);
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

function loadConfigForContext(ctx: ExtensionContext): PiRaftConfig {
  const result = loadPiRaftConfig({ cwd: ctx.cwd });
  for (const warning of result.warnings) {
    console.warn(`[pi-raft] config warning: ${warning}`);
  }
  return result.config;
}

function getMutationText(toolName: string, input: unknown): string {
  if (!input || typeof input !== "object") {
    return "";
  }

  if (toolName === "write") {
    const content = (input as { content?: unknown }).content;
    return typeof content === "string" ? content : "";
  }

  const edits = (input as { edits?: unknown }).edits;
  if (!Array.isArray(edits)) {
    return "";
  }

  return edits
    .map((edit) => {
      if (!edit || typeof edit !== "object") {
        return "";
      }
      const newText = (edit as { newText?: unknown }).newText;
      return typeof newText === "string" ? newText : "";
    })
    .join("\n");
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

function handleViolation(
  config: PiRaftConfig,
  ctx: ExtensionContext,
  reason: string,
): ToolCallEventResult | undefined {
  if (config.strictMode) {
    return blockToolCall(reason);
  }

  ctx.ui.notify(toWarningMessage(reason), "warning");
  return undefined;
}

function toWarningMessage(reason: string): string {
  if (reason.startsWith("Blocked:")) {
    return `Warning: ${reason.slice("Blocked:".length).trim()}`;
  }
  return `Warning: ${reason}`;
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
