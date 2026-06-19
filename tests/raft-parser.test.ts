import { describe, it, expect } from "vitest";
import { parseRaftCommands, hasChainingOperators, detectDuplicateCommand } from "../extensions/raft-parser";

describe("parseRaftCommands", () => {
  it("parses single raft command with args", () => {
    const result = parseRaftCommands("raft msg read --channel general");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ noun: "msg", verb: "read" });
    expect(result[0].args.channel).toBe("general");
  });

  it("parses raft task claim with number", () => {
    const result = parseRaftCommands("raft task claim --number 42");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ noun: "task", verb: "claim" });
    expect(result[0].args.number).toBe("42");
  });

  it("parses positional raft task claim id", () => {
    const result = parseRaftCommands("raft task claim 42");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ noun: "task", verb: "claim" });
    expect(result[0].args["0"]).toBe("42");
  });

  it("parses raft task status inspection command", () => {
    const result = parseRaftCommands("raft task status --help");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ noun: "task", verb: "status" });
    expect(result[0].args.help).toBe("true");
  });

  it("parses raft msg post command", () => {
    const result = parseRaftCommands("raft msg post --channel general --thread ts_123 \"hello world\"");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ noun: "msg", verb: "post" });
    expect(result[0].args.channel).toBe("general");
    expect(result[0].args.thread).toBe("ts_123");
    expect(result[0].args["0"]).toBe("hello world");
  });

  it("returns empty array for non-raft commands", () => {
    expect(parseRaftCommands("echo hello")).toHaveLength(0);
    expect(parseRaftCommands("find . -name '*.ts'")).toHaveLength(0);
  });

  it("supports a configured raft command name", () => {
    const result = parseRaftCommands("slock-raft msg read --channel general", {
      raftCommand: "slock-raft",
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ noun: "msg", verb: "read" });
  });

  it("returns empty when raft appears inside quoted string", () => {
    expect(parseRaftCommands('echo "use raft to connect"')).toHaveLength(0);
    expect(parseRaftCommands("echo 'run: raft msg read'")).toHaveLength(0);
  });

  it("splits chained commands with &&", () => {
    const result = parseRaftCommands("raft msg read && raft task claim 42");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ noun: "msg", verb: "read" });
    expect(result[1]).toMatchObject({ noun: "task", verb: "claim" });
  });

  it("splits chained commands with ;", () => {
    const result = parseRaftCommands("raft task claim 8; raft task update --number 8 --status in_review");
    expect(result).toHaveLength(2);
  });

  it("splits chained commands with ||", () => {
    const result = parseRaftCommands("raft msg read || echo failed");
    // "echo failed" is not a raft command, so only 1 ParsedCommand
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ noun: "msg", verb: "read" });
  });

  it("handles real-world F1 example", () => {
    const result = parseRaftCommands(
      "raft task claim --number 8 && raft task update --number 8 --status in_review"
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ noun: "task", verb: "claim" });
    expect(result[1]).toMatchObject({ noun: "task", verb: "update" });
    expect(result[1].args.status).toBe("in_review");
  });

  it("ignores non-raft segments in chained command", () => {
    const result = parseRaftCommands("raft msg read && echo done && raft task claim 42");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ noun: "msg", verb: "read" });
    expect(result[1]).toMatchObject({ noun: "task", verb: "claim" });
  });

  it("preserves rawSegment for each command", () => {
    const result = parseRaftCommands("raft task claim --number 14 && raft task update --number 14 --status in_review");
    expect(result[0].rawSegment).toContain("raft task claim");
    expect(result[1].rawSegment).toContain("raft task update");
  });
});

describe("hasChainingOperators", () => {
  it("detects && operator", () => {
    expect(hasChainingOperators("raft msg read && raft task claim")).toBe(true);
  });

  it("detects ; operator", () => {
    expect(hasChainingOperators("raft msg read; raft task claim")).toBe(true);
  });

  it("detects || operator", () => {
    expect(hasChainingOperators("raft msg read || echo fail")).toBe(true);
  });

  it("returns false for single command", () => {
    expect(hasChainingOperators("raft msg read --channel general")).toBe(false);
  });

  it("returns false for echo command", () => {
    expect(hasChainingOperators("echo hello")).toBe(false);
  });

  it("ignores && inside quoted strings", () => {
    expect(hasChainingOperators("echo 'use raft && run'")).toBe(false);
  });
});

describe("normalization: raft message → raft msg", () => {
  it("normalizes raft message read to noun=msg verb=read", () => {
    const result = parseRaftCommands("raft message read --channel #pi-raft");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ noun: "msg", verb: "read" });
    expect(result[0].args.channel).toBe("#pi-raft");
  });

  it("normalizes raft message send to noun=msg verb=post", () => {
    const result = parseRaftCommands('raft message send --target "#pi-raft" "hello"');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ noun: "msg", verb: "post" });
    expect(result[0].args.target).toBe("#pi-raft");
  });

  it("normalizes raft message check", () => {
    const result = parseRaftCommands("raft message check");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ noun: "msg", verb: "check" });
  });

  it("preserves original rawSegment after normalization", () => {
    const result = parseRaftCommands("raft message read --channel #general");
    expect(result[0].rawSegment).toContain("raft message read");
  });

  it("chained raft message commands still detected", () => {
    const result = parseRaftCommands("raft message read && raft task claim 42");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ noun: "msg", verb: "read" });
    expect(result[1]).toMatchObject({ noun: "task", verb: "claim" });
  });

  it("parses raft message send with target and payload", () => {
    const result = parseRaftCommands('raft message send --target "#general" "hello"');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ noun: "msg", verb: "post" });
    expect(result[0].args.target).toBe("#general");
  });

  it("existing raft msg read still works unchanged", () => {
    const result = parseRaftCommands("raft msg read --channel general");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ noun: "msg", verb: "read" });
  });

  it("rejects unknown noun after normalization", () => {
    const result = parseRaftCommands("raft channel join #pi-raft");
    expect(result).toHaveLength(0);
  });
});

describe("detectDuplicateCommand", () => {
  it("detects identical commands with same args", () => {
    const cmds = parseRaftCommands(
      "raft task update --number 14 --status in_review && raft task update --number 14 --status in_review"
    );
    expect(detectDuplicateCommand(cmds)).toBe(true);
  });

  it("returns false for different commands", () => {
    const cmds = parseRaftCommands("raft msg read && raft task claim 42");
    expect(detectDuplicateCommand(cmds)).toBe(false);
  });

  it("returns false for single command", () => {
    const cmds = parseRaftCommands("raft msg read");
    expect(detectDuplicateCommand(cmds)).toBe(false);
  });

  it("returns false for empty array", () => {
    expect(detectDuplicateCommand([])).toBe(false);
  });
});
