import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadPiRaftConfig } from "../extensions/config";
import { scanCredentials } from "../extensions/credential-scanner";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "pi-raft-config-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeJson(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

describe("loadPiRaftConfig", () => {
  it("returns defaults when no config files exist", () => {
    withTempDir((dir) => {
      const result = loadPiRaftConfig({
        cwd: join(dir, "cwd"),
        homeDir: join(dir, "home"),
      });

      expect(result.config).toMatchObject({
        raftCommand: DEFAULT_CONFIG.raftCommand,
        strictMode: true,
        maxRaftCommandsPerCall: 1,
        injectContext: true,
        contextVerbosity: "compact",
      });
      expect(result.config.credentialPatterns).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });
  });

  it("merges global and project-local config with local override", () => {
    withTempDir((dir) => {
      const homeDir = join(dir, "home");
      const cwd = join(dir, "cwd");
      writeJson(
        join(homeDir, ".pi", "agent", "pi-raft.json"),
        JSON.stringify({
          strictMode: false,
          maxRaftCommandsPerCall: 2,
          requiredStates: { beforeWrite: "MESSAGES_READ" },
        }),
      );
      writeJson(
        join(cwd, ".pi", "pi-raft.json"),
        JSON.stringify({
          strictMode: true,
          contextVerbosity: "full",
          requiredStates: { beforePost: "DONE" },
        }),
      );

      const result = loadPiRaftConfig({ cwd, homeDir });

      expect(result.config.strictMode).toBe(true);
      expect(result.config.maxRaftCommandsPerCall).toBe(2);
      expect(result.config.contextVerbosity).toBe("full");
      expect(result.config.requiredStates).toEqual({
        beforeWrite: "MESSAGES_READ",
        beforePost: "DONE",
      });
      expect(result.warnings).toHaveLength(0);
    });
  });

  it("compiles extra credential patterns", () => {
    withTempDir((dir) => {
      const cwd = join(dir, "cwd");
      const homeDir = join(dir, "home");
      writeJson(
        join(cwd, ".pi", "pi-raft.json"),
        JSON.stringify({ credentialPatterns: ["CUSTOM_SECRET_[0-9]+"] }),
      );

      const result = loadPiRaftConfig({ cwd, homeDir });

      expect(scanCredentials("CUSTOM_SECRET_123", result.config.credentialPatterns)).toBe(
        "CUSTOM_SECRET_123",
      );
    });
  });

  it("falls back to defaults for invalid values", () => {
    withTempDir((dir) => {
      const cwd = join(dir, "cwd");
      const homeDir = join(dir, "home");
      writeJson(
        join(cwd, ".pi", "pi-raft.json"),
        JSON.stringify({
          raftCommand: "",
          strictMode: "false",
          maxRaftCommandsPerCall: 0,
          injectContext: "yes",
          contextVerbosity: "verbose",
          requiredStates: { beforeWrite: "UNKNOWN" },
          credentialPatterns: ["[", 42],
        }),
      );

      const result = loadPiRaftConfig({ cwd, homeDir });

      expect(result.config).toMatchObject({
        raftCommand: "raft",
        strictMode: true,
        maxRaftCommandsPerCall: 1,
        injectContext: true,
        contextVerbosity: "compact",
      });
      expect(result.config.requiredStates.beforeWrite).toBe("TASK_CLAIMED");
      expect(result.config.credentialPatterns).toHaveLength(0);
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  it("ignores malformed JSON with a warning", () => {
    withTempDir((dir) => {
      const cwd = join(dir, "cwd");
      const homeDir = join(dir, "home");
      writeJson(join(cwd, ".pi", "pi-raft.json"), "{");

      const result = loadPiRaftConfig({ cwd, homeDir });

      expect(result.config.strictMode).toBe(true);
      expect(result.warnings.length).toBe(1);
    });
  });
});
