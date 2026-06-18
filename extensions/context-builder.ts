import type { ActiveState, SlockState } from "./state-machine";

export type ContextVerbosity = "compact" | "full";

export function buildSlockContext(
  state: ActiveState,
  verbosity: ContextVerbosity = "compact",
): string {
  if (verbosity === "compact") {
    return buildCompact(state);
  }
  return buildFull(state);
}

function buildCompact(state: ActiveState): string {
  const parts: string[] = ["[Slock]"];

  parts.push(`State: ${state.currentState}`);

  if (state.taskId) {
    parts.push(`| Task: #${state.taskId}`);
  }

  const hint = nextActionHint(state.currentState);
  if (hint) {
    parts.push(`| Next: ${hint}`);
  }

  return parts.join(" ");
}

function buildFull(state: ActiveState): string {
  const lines: string[] = [
    "Slock Workflow Status:",
    `  State: ${state.currentState}`,
  ];

  if (state.taskId) {
    lines.push(`  Task: #${state.taskId}`);
  }

  if (state.replyTarget) {
    lines.push(`  Reply to: ${state.replyTarget.channel}`);
    if (state.replyTarget.threadTs) {
      lines.push(`  Thread: ${state.replyTarget.threadTs}`);
    }
  }

  const hint = nextActionHint(state.currentState);
  if (hint) {
    lines.push("");
    lines.push(`Next expected action: ${hint}`);
  }

  const reminder = stateReminder(state.currentState);
  if (reminder) {
    lines.push(reminder);
  }

  lines.push("");
  lines.push("Reference: /skill:pi-raft");

  return lines.join("\n");
}

function nextActionHint(state: SlockState): string | null {
  switch (state) {
    case "IDLE":
      return "raft msg read --channel <channel>";
    case "MESSAGES_READ":
      return "raft task claim <task-id>";
    case "TASK_CLAIMED":
      return "raft task status in_review <task-id>";
    case "IN_REVIEW":
      return 'raft msg post --channel <channel> --thread <ts> "your reply"';
    case "DONE":
      return "raft msg read --channel <channel> (next task)";
  }
}

function stateReminder(state: SlockState): string | null {
  switch (state) {
    case "TASK_CLAIMED":
      return "Reminder: Mark task status as in_review before posting your reply.";
    case "IN_REVIEW":
      return "Reminder: Post your reply in the correct thread when done.";
    default:
      return null;
  }
}
