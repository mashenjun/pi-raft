import { describe, it, expect } from "vitest";
import { buildSlockContext } from "../extensions/context-builder";
import type { ActiveState } from "../extensions/state-machine";

function state(overrides: Partial<ActiveState> = {}): ActiveState {
  return {
    currentState: "IDLE",
    taskId: null,
    replyTarget: null,
    ...overrides,
  };
}

describe("buildSlockContext — compact", () => {
  it("formats IDLE state", () => {
    const ctx = buildSlockContext(state());
    expect(ctx).toContain("[Slock]");
    expect(ctx).toContain("State: IDLE");
    expect(ctx).toContain("raft msg read");
    expect(ctx).toContain("claim assigned review/analysis/investigation tasks");
  });

  it("formats TASK_CLAIMED with taskId", () => {
    const ctx = buildSlockContext(state({ currentState: "TASK_CLAIMED", taskId: "42" }));
    expect(ctx).toContain("State: TASK_CLAIMED");
    expect(ctx).toContain("Task: #42");
    expect(ctx).toContain("raft task update");
    expect(ctx).toContain("--status in_review");
  });

  it("formats DONE state", () => {
    const ctx = buildSlockContext(state({ currentState: "DONE", taskId: "99" }));
    expect(ctx).toContain("State: DONE");
    expect(ctx).toContain("Task: #99");
    expect(ctx).toContain("raft msg read");
  });

  it("compact is single line", () => {
    const ctx = buildSlockContext(state({ currentState: "MESSAGES_READ" }));
    expect(ctx.split("\n")).toHaveLength(1);
  });
});

describe("buildSlockContext — full", () => {
  it("formats with multi-line structure", () => {
    const ctx = buildSlockContext(
      state({ currentState: "IN_REVIEW", taskId: "7", replyTarget: { channel: "#pi-raft", threadTs: "ts_001" } }),
      "full",
    );
    expect(ctx).toContain("Slock Workflow Status:");
    expect(ctx).toContain("State: IN_REVIEW");
    expect(ctx).toContain("Task: #7");
    expect(ctx).toContain("Reply to: #pi-raft");
    expect(ctx).toContain("Thread: ts_001");
    expect(ctx).toContain("review, analysis, and investigation work requires a task claim");
    expect(ctx).toContain("Reference: /skill:pi-raft");
  });

  it("includes reminder for TASK_CLAIMED", () => {
    const ctx = buildSlockContext(state({ currentState: "TASK_CLAIMED" }), "full");
    expect(ctx).toContain("in_review before posting");
  });

  it("includes reminder for IN_REVIEW", () => {
    const ctx = buildSlockContext(state({ currentState: "IN_REVIEW" }), "full");
    expect(ctx).toContain("correct thread");
  });

  it("omits reply target when null", () => {
    const ctx = buildSlockContext(state({ currentState: "IN_REVIEW" }), "full");
    expect(ctx).not.toContain("Reply to:");
  });
});
