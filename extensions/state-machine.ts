export type SlockState = "IDLE" | "MESSAGES_READ" | "TASK_CLAIMED" | "IN_REVIEW" | "DONE";

export interface RaftAction {
  noun: "msg" | "task";
  verb: string;
  args: Record<string, string>;
}

export type TransitionResult =
  | { allowed: true; newState: SlockState; taskId?: string; changed?: boolean }
  | { allowed: false; reason: string };

export interface ActiveState {
  currentState: SlockState;
  taskId: string | null;
  replyTarget: { channel: string; threadTs?: string } | null;
}

export interface StateMachine {
  currentState: SlockState;
  taskId: string | null;
  replyTarget: { channel: string; threadTs?: string } | null;

  transition(action: RaftAction): TransitionResult;
  canWrite(): { allowed: boolean; reason?: string };
  restore(state: ActiveState): void;
  reset(): void;
  snapshot(): ActiveState;
}

export function createStateMachine(initial?: ActiveState): StateMachine {
  let state: ActiveState = initial ?? {
    currentState: "IDLE",
    taskId: null,
    replyTarget: null,
  };

  const sm: StateMachine = {
    get currentState() { return state.currentState; },
    get taskId() { return state.taskId; },
    get replyTarget() { return state.replyTarget; },

    transition(action: RaftAction): TransitionResult {
      if (isReadOnlyAction(action)) {
        return {
          allowed: true,
          newState: state.currentState,
          taskId: state.taskId ?? undefined,
          changed: false,
        };
      }

      const nextState = nextStateFor(state.currentState, action);
      if (nextState) {
        state.currentState = nextState;

        if (action.noun === "task" && action.verb === "claim") {
          state.taskId = action.args.number ?? action.args["0"] ?? null;
        }
        if (action.noun === "msg" && action.verb === "post") {
          state.replyTarget = {
            channel: action.args.channel ?? "",
            threadTs: action.args.thread,
          };
        }
        if (nextState === "IDLE") {
          state.taskId = null;
          state.replyTarget = null;
        }

        return { allowed: true, newState: state.currentState, taskId: state.taskId ?? undefined };
      }

      return {
        allowed: false,
        reason: buildBlockReason(state.currentState, action),
      };
    },

    canWrite() {
      if (state.currentState === "IDLE") {
        return { allowed: false, reason: "must read messages first (raft msg read)" };
      }
      if (state.currentState === "MESSAGES_READ") {
        return { allowed: false, reason: "must claim a task first (raft task claim <id>)" };
      }
      return { allowed: true };
    },

    restore(s: ActiveState) {
      state = { ...s };
    },

    reset() {
      state = { currentState: "IDLE", taskId: null, replyTarget: null };
    },

    snapshot(): ActiveState {
      return { ...state };
    },
  };

  return sm;
}

function nextStateFor(currentState: SlockState, action: RaftAction): SlockState | null {
  switch (currentState) {
    case "IDLE":
      if (isMsgRead(action)) return "MESSAGES_READ";
      return null;
    case "MESSAGES_READ":
      if (isMsgRead(action)) return "MESSAGES_READ";
      if (isTaskClaim(action)) return "TASK_CLAIMED";
      return null;
    case "TASK_CLAIMED":
      if (isMsgRead(action)) return "TASK_CLAIMED";
      if (isTaskUpdateInReview(action)) return "IN_REVIEW";
      return null;
    case "IN_REVIEW":
      if (isMsgRead(action)) return "IN_REVIEW";
      if (isTaskUpdateInReview(action)) return "IN_REVIEW";
      if (isMsgPost(action)) return "DONE";
      return null;
    case "DONE":
      if (isMsgRead(action)) return "IDLE";
      return null;
  }
}

function isMsgRead(action: RaftAction): boolean {
  return action.noun === "msg" && action.verb === "read";
}

function isMsgPost(action: RaftAction): boolean {
  return action.noun === "msg" && action.verb === "post";
}

function isTaskClaim(action: RaftAction): boolean {
  return action.noun === "task" && action.verb === "claim";
}

function isTaskUpdateInReview(action: RaftAction): boolean {
  return action.noun === "task" &&
    action.verb === "update" &&
    action.args.status === "in_review";
}

function isReadOnlyAction(action: RaftAction): boolean {
  if (action.args.help === "true") return true;
  return action.noun === "task" && action.verb === "status";
}

function buildBlockReason(currentState: SlockState, action: RaftAction): string {
  if (currentState === "IDLE") {
    return `must read messages first (raft msg read) before ${action.noun} ${action.verb}`;
  }
  if (currentState === "MESSAGES_READ" && action.noun === "task") {
    return "must claim a task first (raft task claim <id>)";
  }
  if (currentState === "TASK_CLAIMED" && action.noun === "msg" && action.verb === "post") {
    return "must set task status to in_review before posting (raft task update --status in_review)";
  }
  return `invalid transition from ${currentState}: ${action.noun} ${action.verb}`;
}
