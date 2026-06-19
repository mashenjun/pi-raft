import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ContextVerbosity } from "./context-builder";
import type { SlockState } from "./state-machine";

export interface RequiredStatesConfig {
  beforeWrite: SlockState;
  beforePost: SlockState;
}

export interface PiRaftConfig {
  raftCommand: string;
  strictMode: boolean;
  requiredStates: RequiredStatesConfig;
  credentialPatterns: RegExp[];
  maxRaftCommandsPerCall: number;
  injectContext: boolean;
  contextVerbosity: ContextVerbosity;
}

interface RawPiRaftConfig {
  raftCommand?: unknown;
  strictMode?: unknown;
  requiredStates?: {
    beforeWrite?: unknown;
    beforePost?: unknown;
  };
  credentialPatterns?: unknown;
  maxRaftCommandsPerCall?: unknown;
  injectContext?: unknown;
  contextVerbosity?: unknown;
}

export interface LoadPiRaftConfigOptions {
  cwd?: string;
  homeDir?: string;
  globalPath?: string;
  localPath?: string;
}

export interface LoadPiRaftConfigResult {
  config: PiRaftConfig;
  warnings: string[];
}

const SLOCK_STATES: SlockState[] = [
  "IDLE",
  "MESSAGES_READ",
  "TASK_CLAIMED",
  "IN_REVIEW",
  "DONE",
];

export const DEFAULT_CONFIG: PiRaftConfig = {
  raftCommand: "raft",
  strictMode: true,
  requiredStates: {
    beforeWrite: "TASK_CLAIMED",
    beforePost: "IN_REVIEW",
  },
  credentialPatterns: [],
  maxRaftCommandsPerCall: 1,
  injectContext: true,
  contextVerbosity: "compact",
};

export function loadPiRaftConfig(
  options: LoadPiRaftConfigOptions = {},
): LoadPiRaftConfigResult {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? process.env.HOME ?? homedir();
  const globalPath = options.globalPath ?? join(homeDir, ".pi", "agent", "pi-raft.json");
  const localPath = options.localPath ?? join(cwd, ".pi", "pi-raft.json");
  const warnings: string[] = [];

  const globalConfig = readRawConfig(globalPath, warnings);
  const localConfig = readRawConfig(localPath, warnings);
  const merged = mergeRawConfig(globalConfig, localConfig);

  return {
    config: normalizeConfig(merged, warnings),
    warnings,
  };
}

function readRawConfig(path: string, warnings: string[]): RawPiRaftConfig {
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as RawPiRaftConfig;
    }
    warnings.push(`${path}: expected a JSON object`);
  } catch (error) {
    warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {};
}

function mergeRawConfig(
  base: RawPiRaftConfig,
  override: RawPiRaftConfig,
): RawPiRaftConfig {
  return {
    ...base,
    ...override,
    requiredStates: {
      ...(base.requiredStates ?? {}),
      ...(override.requiredStates ?? {}),
    },
  };
}

function normalizeConfig(raw: RawPiRaftConfig, warnings: string[]): PiRaftConfig {
  return {
    raftCommand: stringValue(raw.raftCommand, DEFAULT_CONFIG.raftCommand, "raftCommand", warnings),
    strictMode: booleanValue(raw.strictMode, DEFAULT_CONFIG.strictMode, "strictMode", warnings),
    requiredStates: {
      beforeWrite: stateValue(
        raw.requiredStates?.beforeWrite,
        DEFAULT_CONFIG.requiredStates.beforeWrite,
        "requiredStates.beforeWrite",
        warnings,
      ),
      beforePost: stateValue(
        raw.requiredStates?.beforePost,
        DEFAULT_CONFIG.requiredStates.beforePost,
        "requiredStates.beforePost",
        warnings,
      ),
    },
    credentialPatterns: regexArrayValue(raw.credentialPatterns, warnings),
    maxRaftCommandsPerCall: positiveIntegerValue(
      raw.maxRaftCommandsPerCall,
      DEFAULT_CONFIG.maxRaftCommandsPerCall,
      "maxRaftCommandsPerCall",
      warnings,
    ),
    injectContext: booleanValue(raw.injectContext, DEFAULT_CONFIG.injectContext, "injectContext", warnings),
    contextVerbosity: contextVerbosityValue(raw.contextVerbosity, warnings),
  };
}

function stringValue(
  value: unknown,
  fallback: string,
  field: string,
  warnings: string[],
): string {
  if (value === undefined) return fallback;
  if (typeof value === "string" && value.trim()) return value.trim();
  warnings.push(`${field}: expected a non-empty string`);
  return fallback;
}

function booleanValue(
  value: unknown,
  fallback: boolean,
  field: string,
  warnings: string[],
): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  warnings.push(`${field}: expected a boolean`);
  return fallback;
}

function stateValue(
  value: unknown,
  fallback: SlockState,
  field: string,
  warnings: string[],
): SlockState {
  if (value === undefined) return fallback;
  if (typeof value === "string" && SLOCK_STATES.includes(value as SlockState)) {
    return value as SlockState;
  }
  warnings.push(`${field}: expected one of ${SLOCK_STATES.join(", ")}`);
  return fallback;
}

function regexArrayValue(value: unknown, warnings: string[]): RegExp[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push("credentialPatterns: expected an array of regex strings");
    return [];
  }

  const patterns: RegExp[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      warnings.push("credentialPatterns: ignored non-string pattern");
      continue;
    }
    try {
      patterns.push(new RegExp(item, "g"));
    } catch (error) {
      warnings.push(`credentialPatterns: invalid regex '${item}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return patterns;
}

function positiveIntegerValue(
  value: unknown,
  fallback: number,
  field: string,
  warnings: string[],
): number {
  if (value === undefined) return fallback;
  if (Number.isInteger(value) && (value as number) > 0) return value as number;
  warnings.push(`${field}: expected a positive integer`);
  return fallback;
}

function contextVerbosityValue(value: unknown, warnings: string[]): ContextVerbosity {
  if (value === undefined) return DEFAULT_CONFIG.contextVerbosity;
  if (value === "compact" || value === "full") return value;
  warnings.push("contextVerbosity: expected 'compact' or 'full'");
  return DEFAULT_CONFIG.contextVerbosity;
}
