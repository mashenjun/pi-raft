export interface ParsedCommand {
  noun: "msg" | "task";
  verb: string;
  args: Record<string, string>;
  rawSegment: string;
}

/**
 * Split a bash command string by shell chaining operators (&&, ;, ||),
 * respecting shell quoting rules (single quotes, double quotes).
 */
function splitCommandsPreservingQuotes(input: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1] ?? "";

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    if (!inSingle && !inDouble) {
      if (ch === "&" && next === "&") {
        segments.push(current.trim());
        current = "";
        i++; // skip second &
        continue;
      }
      if (ch === "|" && next === "|") {
        segments.push(current.trim());
        current = "";
        i++; // skip second |
        continue;
      }
      if (ch === ";") {
        segments.push(current.trim());
        current = "";
        continue;
      }
    }

    current += ch;
  }

  const last = current.trim();
  if (last.length > 0) segments.push(last);

  return segments;
}

const RAFT_COMMAND_RE = /^\s*raft\s+(\w+)\s+(\w+)(.*)$/;

function parseSegmentArgs(rawArgs: string): Record<string, string> {
  const args: Record<string, string> = {};
  let i = 0;
  while (i < rawArgs.length) {
    // Skip leading whitespace
    while (i < rawArgs.length && /\s/.test(rawArgs[i])) i++;
    if (i >= rawArgs.length) break;

    // Check for --flag value
    if (rawArgs[i] === "-" && rawArgs[i + 1] === "-") {
      i += 2;
      let key = "";
      while (i < rawArgs.length && !/\s/.test(rawArgs[i]) && rawArgs[i] !== "=") {
        key += rawArgs[i];
        i++;
      }
      if (rawArgs[i] === "=") {
        // Already in key=value form in raw text — just record known keys
        args[key] = "true";
        while (i < rawArgs.length && !/\s/.test(rawArgs[i])) i++;
      } else {
        // Space-separated value
        while (i < rawArgs.length && /\s/.test(rawArgs[i])) i++;
        let value = "";
        while (i < rawArgs.length && !/\s/.test(rawArgs[i])) {
          value += rawArgs[i];
          i++;
        }
        args[key] = value || "true";
      }
      continue;
    }

    // Positional argument — skip it
    while (i < rawArgs.length && !/\s/.test(rawArgs[i])) i++;
  }
  return args;
}

function matchRaftCommand(segment: string): ParsedCommand | null {
  const match = segment.match(RAFT_COMMAND_RE);
  if (!match) return null;

  const noun = match[1] as "msg" | "task";
  if (noun !== "msg" && noun !== "task") return null;

  return {
    noun,
    verb: match[2],
    args: parseSegmentArgs(match[3] ?? ""),
    rawSegment: segment,
  };
}

export function parseRaftCommands(bashCommand: string): ParsedCommand[] {
  const segments = splitCommandsPreservingQuotes(bashCommand);
  return segments.map(matchRaftCommand).filter((c): c is ParsedCommand => c !== null);
}

export function hasChainingOperators(bashCommand: string): boolean {
  // Strip quoted strings first, then check for && or ; outside quotes
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < bashCommand.length; i++) {
    const ch = bashCommand[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (!inSingle && !inDouble) {
      if (ch === "&" && bashCommand[i + 1] === "&") return true;
      if (ch === "|" && bashCommand[i + 1] === "|") return true;
      if (ch === ";") return true;
    }
  }
  return false;
}

export function detectDuplicateCommand(commands: ParsedCommand[]): boolean {
  if (commands.length < 2) return false;
  for (let i = 0; i < commands.length; i++) {
    for (let j = i + 1; j < commands.length; j++) {
      if (commands[i].noun === commands[j].noun &&
          commands[i].verb === commands[j].verb &&
          JSON.stringify(commands[i].args) === JSON.stringify(commands[j].args)) {
        return true;
      }
    }
  }
  return false;
}
