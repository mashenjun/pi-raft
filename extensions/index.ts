import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseRaftCommands, hasChainingOperators, detectDuplicateCommand } from "./raft-parser";
import { createStateMachine } from "./state-machine";
import type { RaftAction } from "./state-machine";
import { scanCredentials } from "./credential-scanner";

export default function (pi: ExtensionAPI): void {
  const sm = createStateMachine();

  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName === "bash") {
      const cmd: string = (event.input as { command?: string }).command ?? "";
      if (!cmd) return;

      // P7: chained raft commands via &&, ;, ||
      if (hasChainingOperators(cmd)) {
        return {
          block: true,
          reason:
            "Multiple raft commands chained in one call. Split them into separate calls.\n" +
            `Current state: ${sm.currentState}`,
        };
      }

      const raftCommands = parseRaftCommands(cmd);

      if (raftCommands.length > 0) {
        // P11: duplicate raft command in same call
        if (detectDuplicateCommand(raftCommands)) {
          return {
            block: true,
            reason:
              "Duplicate raft command detected in the same call.\n" +
              `Current state: ${sm.currentState}`,
          };
        }

        if (raftCommands.length > 1) {
          return {
            block: true,
            reason:
              "Multiple raft commands in one call. Run each raft command separately.\n" +
              `Current state: ${sm.currentState}`,
          };
        }

        const parsed = raftCommands[0];
        const action: RaftAction = {
          noun: parsed.noun,
          verb: parsed.verb,
          args: parsed.args,
        };

        const result = sm.transition(action);
        if (result.allowed) {
          console.log(
            `[pi-raft] ${result.newState}` +
              (result.taskId ? ` | task: #${result.taskId}` : ""),
          );
          return;
        }

        return {
          block: true,
          reason: buildBlockMessage(result.reason, sm.currentState),
        };
      }

      // P6: scan bash for credential patterns
      const credMatch = scanCredentials(cmd);
      if (credMatch) {
        return {
          block: true,
          reason: `Credential detected: "${credMatch}". Remove it before executing.`,
        };
      }

      return;
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      // P6: scan file content for credentials
      const { content, oldString, newString } = event.input as {
        content?: string;
        oldString?: string;
        newString?: string;
      };
      const textToScan = content ?? oldString ?? newString ?? "";

      if (textToScan) {
        const credMatch = scanCredentials(textToScan);
        if (credMatch) {
          return {
            block: true,
            reason: `Credential detected in file content: "${credMatch}". Remove it before writing.`,
          };
        }
      }

      // P2: must have claimed a task before writing files
      const canWrite = sm.canWrite();
      if (!canWrite.allowed) {
        return {
          block: true,
          reason: buildBlockMessage(
            canWrite.reason ?? "write requires a claimed task",
            sm.currentState,
          ),
        };
      }

      return;
    }

    return;
  });

  // TODO Group D: session_start hook
  // TODO Group E: before_agent_start hook
}

function buildBlockMessage(reason: string, currentState: string): string {
  const lines = [
    `Blocked: ${reason}`,
    `Current state: ${currentState}`,
  ];

  if (currentState === "IDLE") {
    lines.push(
      "\u2192 Next: raft msg read --channel <channel>",
      "\u2192 Then: raft task claim <task-id>",
    );
  } else if (currentState === "MESSAGES_READ") {
    lines.push(
      "\u2192 Next: raft task claim <task-id>",
      "\u2192 Then: raft task status in_review <task-id>",
    );
  } else if (currentState === "TASK_CLAIMED") {
    lines.push(
      "\u2192 Next: raft task status in_review <task-id>",
      "\u2192 Then: write your changes",
    );
  } else if (currentState === "IN_REVIEW") {
    lines.push(
      '\u2192 Next: raft msg post --channel <channel> --thread <ts> "your reply"',
    );
  } else if (currentState === "DONE") {
    lines.push(
      "\u2192 Next: raft msg read --channel <channel> (start next task)",
    );
  }

  return lines.join("\n");
}
