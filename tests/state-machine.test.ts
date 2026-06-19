import { describe, it, expect } from "vitest";
import { createStateMachine } from "../extensions/state-machine";

describe("StateMachine transitions", () => {
  describe("IDLE state", () => {
    it("allows raft msg read → MESSAGES_READ", () => {
      const sm = createStateMachine();
      const result = sm.transition({ noun: "msg", verb: "read", args: {} });
      expect(result.allowed).toBe(true);
      if (result.allowed) expect(result.newState).toBe("MESSAGES_READ");
    });

    it("blocks raft task claim from IDLE (F9)", () => {
      const sm = createStateMachine();
      const result = sm.transition({ noun: "task", verb: "claim", args: { number: "42" } });
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain("must read messages first");
      }
    });

    it("blocks raft msg post from IDLE", () => {
      const sm = createStateMachine();
      const result = sm.transition({ noun: "msg", verb: "post", args: {} });
      expect(result.allowed).toBe(false);
    });
  });

  describe("MESSAGES_READ state", () => {
    it("allows raft task claim → TASK_CLAIMED", () => {
      const sm = createStateMachine();
      sm.transition({ noun: "msg", verb: "read", args: {} });
      const result = sm.transition({ noun: "task", verb: "claim", args: { number: "42" } });
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.newState).toBe("TASK_CLAIMED");
        expect(sm.taskId).toBe("42");
      }
    });

    it("allows re-reading messages (stays in MESSAGES_READ)", () => {
      const sm = createStateMachine();
      sm.transition({ noun: "msg", verb: "read", args: {} });
      const result = sm.transition({ noun: "msg", verb: "read", args: {} });
      expect(result.allowed).toBe(true);
      if (result.allowed) expect(result.newState).toBe("MESSAGES_READ");
    });

    it("allows raft task status as a read-only no-op from MESSAGES_READ", () => {
      const sm = createStateMachine();
      sm.transition({ noun: "msg", verb: "read", args: {} });
      const result = sm.transition({ noun: "task", verb: "status", args: {} });
      expect(result.allowed).toBe(true);
      if (result.allowed) expect(result.newState).toBe("MESSAGES_READ");
    });
  });

  describe("TASK_CLAIMED state", () => {
    it("allows raft task update --status in_review → IN_REVIEW", () => {
      const sm = createStateMachine();
      sm.transition({ noun: "msg", verb: "read", args: {} });
      sm.transition({ noun: "task", verb: "claim", args: { number: "42" } });
      const result = sm.transition({
        noun: "task",
        verb: "update",
        args: { number: "42", status: "in_review" },
      });
      expect(result.allowed).toBe(true);
      if (result.allowed) expect(result.newState).toBe("IN_REVIEW");
    });

    it("does not move to IN_REVIEW for raft task status --help", () => {
      const sm = createStateMachine();
      sm.transition({ noun: "msg", verb: "read", args: {} });
      sm.transition({ noun: "task", verb: "claim", args: { number: "42" } });
      const result = sm.transition({ noun: "task", verb: "status", args: { help: "true" } });
      expect(result.allowed).toBe(true);
      if (result.allowed) expect(result.newState).toBe("TASK_CLAIMED");
      expect(sm.currentState).toBe("TASK_CLAIMED");
    });

    it("does not move to IN_REVIEW for raft task update --help", () => {
      const sm = createStateMachine();
      sm.transition({ noun: "msg", verb: "read", args: {} });
      sm.transition({ noun: "task", verb: "claim", args: { number: "42" } });
      const result = sm.transition({ noun: "task", verb: "update", args: { help: "true" } });
      expect(result.allowed).toBe(true);
      if (result.allowed) expect(result.newState).toBe("TASK_CLAIMED");
      expect(sm.currentState).toBe("TASK_CLAIMED");
    });

    it("blocks raft task update --status done from TASK_CLAIMED", () => {
      const sm = createStateMachine();
      sm.transition({ noun: "msg", verb: "read", args: {} });
      sm.transition({ noun: "task", verb: "claim", args: { number: "42" } });
      const result = sm.transition({
        noun: "task",
        verb: "update",
        args: { number: "42", status: "done" },
      });
      expect(result.allowed).toBe(false);
      expect(sm.currentState).toBe("TASK_CLAIMED");
    });

    it("blocks raft msg post from TASK_CLAIMED", () => {
      const sm = createStateMachine();
      sm.transition({ noun: "msg", verb: "read", args: {} });
      sm.transition({ noun: "task", verb: "claim", args: { number: "42" } });
      const result = sm.transition({ noun: "msg", verb: "post", args: {} });
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain("in_review");
      }
    });
  });

  describe("IN_REVIEW state", () => {
    it("allows raft msg post → DONE", () => {
      const sm = createStateMachine();
      sm.transition({ noun: "msg", verb: "read", args: {} });
      sm.transition({ noun: "task", verb: "claim", args: { number: "42" } });
      sm.transition({ noun: "task", verb: "update", args: { status: "in_review" } });
      const result = sm.transition({ noun: "msg", verb: "post", args: {} });
      expect(result.allowed).toBe(true);
      if (result.allowed) expect(result.newState).toBe("DONE");
    });

    it("stores reply target on post", () => {
      const sm = createStateMachine();
      sm.transition({ noun: "msg", verb: "read", args: {} });
      sm.transition({ noun: "task", verb: "claim", args: { number: "42" } });
      sm.transition({ noun: "task", verb: "update", args: { status: "in_review" } });
      sm.transition({
        noun: "msg",
        verb: "post",
        args: { channel: "general", thread: "ts_123" },
      });
      expect(sm.replyTarget).toEqual({ channel: "general", threadTs: "ts_123" });
    });
  });

  describe("DONE state", () => {
    it("allows raft msg read → IDLE (reset for next task)", () => {
      const sm = createStateMachine();
      sm.transition({ noun: "msg", verb: "read", args: {} });
      sm.transition({ noun: "task", verb: "claim", args: { number: "42" } });
      sm.transition({ noun: "task", verb: "update", args: { status: "in_review" } });
      sm.transition({ noun: "msg", verb: "post", args: {} });
      expect(sm.currentState).toBe("DONE");

      const result = sm.transition({ noun: "msg", verb: "read", args: {} });
      expect(result.allowed).toBe(true);
      if (result.allowed) expect(result.newState).toBe("IDLE");
      expect(sm.taskId).toBeNull();
      expect(sm.replyTarget).toBeNull();
    });
  });
});

describe("canWrite", () => {
  it("blocks writes from IDLE", () => {
    const sm = createStateMachine();
    const result = sm.canWrite();
    expect(result.allowed).toBe(false);
  });

  it("blocks writes from MESSAGES_READ", () => {
    const sm = createStateMachine();
    sm.transition({ noun: "msg", verb: "read", args: {} });
    const result = sm.canWrite();
    expect(result.allowed).toBe(false);
  });

  it("allows writes from TASK_CLAIMED", () => {
    const sm = createStateMachine();
    sm.transition({ noun: "msg", verb: "read", args: {} });
    sm.transition({ noun: "task", verb: "claim", args: { number: "42" } });
    const result = sm.canWrite();
    expect(result.allowed).toBe(true);
  });

  it("allows writes from IN_REVIEW", () => {
    const sm = createStateMachine();
    sm.transition({ noun: "msg", verb: "read", args: {} });
    sm.transition({ noun: "task", verb: "claim", args: { number: "42" } });
    sm.transition({ noun: "task", verb: "update", args: { status: "in_review" } });
    const result = sm.canWrite();
    expect(result.allowed).toBe(true);
  });
});

describe("restore and snapshot", () => {
  it("restores a previously snapshotted state", () => {
    const sm = createStateMachine();
    sm.transition({ noun: "msg", verb: "read", args: {} });
    sm.transition({ noun: "task", verb: "claim", args: { number: "42" } });
    const snap = sm.snapshot();

    const sm2 = createStateMachine();
    sm2.restore(snap);
    expect(sm2.currentState).toBe("TASK_CLAIMED");
    expect(sm2.taskId).toBe("42");
    expect(sm2.canWrite().allowed).toBe(true);
  });

  it("reset clears all state", () => {
    const sm = createStateMachine();
    sm.transition({ noun: "msg", verb: "read", args: {} });
    sm.transition({ noun: "task", verb: "claim", args: { number: "42" } });
    sm.reset();
    expect(sm.currentState).toBe("IDLE");
    expect(sm.taskId).toBeNull();
  });
});
