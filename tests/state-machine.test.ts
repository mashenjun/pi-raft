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
    it("allows raft task list as a read-only no-op", () => {
      const sm = createStateMachine();
      sm.transition({ noun: "msg", verb: "read", args: {} });
      sm.transition({ noun: "task", verb: "claim", args: { number: "42" } });
      sm.transition({ noun: "task", verb: "update", args: { status: "in_review" } });

      const result = sm.transition({ noun: "task", verb: "list", args: {} });

      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.newState).toBe("IN_REVIEW");
        expect(result.changed).toBe(false);
      }
      expect(sm.taskId).toBe("42");
    });

    it("allows raft task update --status done → DONE and clears active task", () => {
      const sm = createStateMachine();
      sm.transition({ noun: "msg", verb: "read", args: {} });
      sm.transition({ noun: "task", verb: "claim", args: { number: "42" } });
      sm.transition({ noun: "task", verb: "update", args: { status: "in_review" } });

      const result = sm.transition({
        noun: "task",
        verb: "update",
        args: { number: "42", status: "done" },
      });

      expect(result.allowed).toBe(true);
      if (result.allowed) expect(result.newState).toBe("DONE");
      expect(sm.taskId).toBeNull();
      expect(sm.replyTarget).toBeNull();
    });

    it("blocks raft task update --status done for a different active task", () => {
      const sm = createStateMachine();
      sm.transition({ noun: "msg", verb: "read", args: {} });
      sm.transition({ noun: "task", verb: "claim", args: { number: "42" } });
      sm.transition({ noun: "task", verb: "update", args: { status: "in_review" } });

      const result = sm.transition({
        noun: "task",
        verb: "update",
        args: { number: "27", status: "done" },
      });

      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toContain("active task is #42");
      expect(sm.currentState).toBe("IN_REVIEW");
      expect(sm.taskId).toBe("42");
    });

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
    it("allows raft msg read → MESSAGES_READ and clears stale task context", () => {
      const sm = createStateMachine();
      sm.transition({ noun: "msg", verb: "read", args: {} });
      sm.transition({ noun: "task", verb: "claim", args: { number: "42" } });
      sm.transition({ noun: "task", verb: "update", args: { status: "in_review" } });
      sm.transition({ noun: "msg", verb: "post", args: {} });
      expect(sm.currentState).toBe("DONE");

      const result = sm.transition({ noun: "msg", verb: "read", args: {} });
      expect(result.allowed).toBe(true);
      if (result.allowed) expect(result.newState).toBe("MESSAGES_READ");
      expect(sm.taskId).toBeNull();
      expect(sm.replyTarget).toBeNull();
    });

    it("allows claiming a fresh task after completion and a new message read", () => {
      const sm = createStateMachine();
      sm.transition({ noun: "msg", verb: "read", args: {} });
      sm.transition({ noun: "task", verb: "claim", args: { number: "42" } });
      sm.transition({ noun: "task", verb: "update", args: { status: "in_review" } });
      sm.transition({ noun: "task", verb: "update", args: { status: "done" } });
      sm.transition({ noun: "msg", verb: "read", args: {} });

      const result = sm.transition({ noun: "task", verb: "claim", args: { number: "27" } });

      expect(result.allowed).toBe(true);
      if (result.allowed) expect(result.newState).toBe("TASK_CLAIMED");
      expect(sm.taskId).toBe("27");
      expect(sm.replyTarget).toBeNull();
    });

    it("blocks direct task claim before reading fresh messages", () => {
      const sm = createStateMachine();
      sm.transition({ noun: "msg", verb: "read", args: {} });
      sm.transition({ noun: "task", verb: "claim", args: { number: "42" } });
      sm.transition({ noun: "task", verb: "update", args: { status: "in_review" } });
      sm.transition({ noun: "task", verb: "update", args: { status: "done" } });

      const result = sm.transition({ noun: "task", verb: "claim", args: { number: "27" } });

      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toContain("msg read");
    });

    it("allows raft task update --status done after a reply post", () => {
      const sm = createStateMachine();
      sm.transition({ noun: "msg", verb: "read", args: {} });
      sm.transition({ noun: "task", verb: "claim", args: { number: "42" } });
      sm.transition({ noun: "task", verb: "update", args: { status: "in_review" } });
      sm.transition({ noun: "msg", verb: "post", args: { channel: "general", thread: "ts_123" } });

      const result = sm.transition({
        noun: "task",
        verb: "update",
        args: { number: "42", status: "done" },
      });

      expect(result.allowed).toBe(true);
      if (result.allowed) expect(result.newState).toBe("DONE");
      expect(sm.taskId).toBeNull();
      expect(sm.replyTarget).toBeNull();
    });
  });

  it("allows task list as a read-only no-op from every state", () => {
    const sm = createStateMachine();

    expect(sm.transition({ noun: "task", verb: "list", args: {} })).toMatchObject({
      allowed: true,
      newState: "IDLE",
      changed: false,
    });

    sm.transition({ noun: "msg", verb: "read", args: {} });
    expect(sm.transition({ noun: "task", verb: "list", args: {} })).toMatchObject({
      allowed: true,
      newState: "MESSAGES_READ",
      changed: false,
    });

    sm.transition({ noun: "task", verb: "claim", args: { number: "42" } });
    expect(sm.transition({ noun: "task", verb: "list", args: {} })).toMatchObject({
      allowed: true,
      newState: "TASK_CLAIMED",
      changed: false,
    });

    sm.transition({ noun: "task", verb: "update", args: { status: "in_review" } });
    expect(sm.transition({ noun: "task", verb: "list", args: {} })).toMatchObject({
      allowed: true,
      newState: "IN_REVIEW",
      changed: false,
    });

    sm.transition({ noun: "task", verb: "update", args: { status: "done" } });
    expect(sm.transition({ noun: "task", verb: "list", args: {} })).toMatchObject({
      allowed: true,
      newState: "DONE",
      changed: false,
    });
  });

  it("allows raft msg check as a read-only no-op", () => {
    const sm = createStateMachine();
    sm.transition({ noun: "msg", verb: "read", args: {} });
    sm.transition({ noun: "task", verb: "claim", args: { number: "42" } });

    const result = sm.transition({ noun: "msg", verb: "check", args: {} });

    expect(result).toMatchObject({
      allowed: true,
      newState: "TASK_CLAIMED",
      changed: false,
    });
    expect(sm.taskId).toBe("42");
  });

  it("specifies raft msg post behavior from each state", () => {
    let sm = createStateMachine();
    expect(sm.transition({ noun: "msg", verb: "post", args: {} }).allowed).toBe(false);

    sm = createStateMachine();
    sm.transition({ noun: "msg", verb: "read", args: {} });
    expect(sm.transition({ noun: "msg", verb: "post", args: {} }).allowed).toBe(false);

    sm.transition({ noun: "task", verb: "claim", args: { number: "42" } });
    expect(sm.transition({ noun: "msg", verb: "post", args: {} }).allowed).toBe(false);

    sm.transition({ noun: "task", verb: "update", args: { status: "in_review" } });
    expect(sm.transition({ noun: "msg", verb: "post", args: {} })).toMatchObject({
      allowed: true,
      newState: "DONE",
    });

    expect(sm.transition({ noun: "msg", verb: "post", args: {} }).allowed).toBe(false);
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

  it("blocks writes from DONE until the next task cycle", () => {
    const sm = createStateMachine();
    sm.transition({ noun: "msg", verb: "read", args: {} });
    sm.transition({ noun: "task", verb: "claim", args: { number: "42" } });
    sm.transition({ noun: "task", verb: "update", args: { status: "in_review" } });
    sm.transition({ noun: "task", verb: "update", args: { status: "done" } });

    const result = sm.canWrite();

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("msg read");
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
