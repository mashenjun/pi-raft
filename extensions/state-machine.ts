export type SlockState = "IDLE" | "MESSAGES_READ" | "TASK_CLAIMED" | "IN_REVIEW" | "DONE";

export interface RaftAction {
  noun: "msg" | "task";
  verb: string;
  args: Record<string, string>;
}

export type TransitionResult =
  | { allowed: true; newState: SlockState; taskId?: string }
  | { allowed: false; reason: string };

interface ActiveState {
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

const VALID_TRANSITIONS: Record<
  SlockState,
  { noun: string; verb: string; nextState: SlockState }[]
> = {
  IDLE: [
    { noun: "msg", verb: "read", nextState: "MESSAGES_READ" },
  ],
  MESSAGES_READ: [
    { noun: "msg", verb: "read", nextState: "MESSAGES_READ" },
    { noun: "task", verb: "claim", nextState: "TASK_CLAIMED" },
  ],
  TASK_CLAIMED: [
    { noun: "msg", verb: "read", nextState: "TASK_CLAIMED" },
    { noun: "task", verb: "status", nextState: "IN_REVIEW" },
  ],
  IN_REVIEW: [
    { noun: "msg", verb: "read", nextState: "IN_REVIEW" },
    { noun: "task", verb: "status", nextState: "IN_REVIEW" },
    { noun: "msg", verb: "post", nextState: "DONE" },
  ],
  DONE: [
    { noun: "msg", verb: "read", nextState: "IDLE" },
    { noun: "task", verb: "status", nextState: "DONE" },
  ],
};

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
      const allowed = VALID_TRANSITIONS[state.currentState];

      for (const t of allowed) {
        if (t.noun === action.noun && t.verb === action.verb) {
          const prev = state.currentState;
          state.currentState = t.nextState;

          if (action.noun === "task" && action.verb === "claim") {
            state.taskId = action.args.number ?? action.args["0"] ?? null;
          }
          if (action.noun === "msg" && action.verb === "post") {
            state.replyTarget = {
              channel: action.args.channel ?? "",
              threadTs: action.args.thread,
            };
          }
          if (t.nextState === "IDLE") {
            state.taskId = null;
            state.replyTarget = null;
          }

          return { allowed: true, newState: state.currentState, taskId: state.taskId ?? undefined };
        }
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

function buildBlockReason(currentState: SlockState, action: RaftAction): string {
  if (currentState === "IDLE") {
    return `must read messages first (raft msg read) before ${action.noun} ${action.verb}`;
  }
  if (currentState === "MESSAGES_READ" && action.noun === "task" && action.verb === "status") {
    return "must claim a task first (raft task claim <id>)";
  }
  if (currentState === "TASK_CLAIMED" && action.noun === "msg" && action.verb === "post") {
    return "must set task status to in_review before posting (raft task status in_review)";
  }
  return `invalid transition from ${currentState}: ${action.noun} ${action.verb}`;
}
