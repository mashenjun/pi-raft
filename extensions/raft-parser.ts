export interface ParsedCommand {
  noun: "msg" | "task";
  verb: string;
  args: Record<string, string>;
  rawSegment: string;
}

export interface ParseRaftCommandsOptions {
  raftCommand?: string;
}

/**
 * Split a bash command string by shell chaining operators (&&, ;, ||,
 * unescaped newline), respecting shell quoting rules.
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

    if (!inSingle && ch === "\\" && (next === "\n" || next === "\r")) {
      if (next === "\r" && input[i + 2] === "\n") i += 2;
      else i++;
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
      if (ch === "\n" || ch === "\r") {
        segments.push(current.trim());
        current = "";
        if (ch === "\r" && next === "\n") i++;
        continue;
      }
    }

    current += ch;
  }

  const last = current.trim();
  if (last.length > 0) segments.push(last);

  return segments;
}

function parseSegmentArgs(rawArgs: string): Record<string, string> {
  const args: Record<string, string> = {};
  let i = 0;
  let positionalIndex = 0;

  const normalizeValue = (value: string): string => {
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        return value.slice(1, -1);
      }
    }
    return value;
  };

  const readToken = (start: number): { value: string; next: number } => {
    let j = start;
    let value = "";
    let quote: "'" | '"' | null = null;

    while (j < rawArgs.length && /\s/.test(rawArgs[j])) j++;

    while (j < rawArgs.length) {
      const ch = rawArgs[j];
      if (quote) {
        value += ch;
        if (ch === quote) quote = null;
        j++;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        value += ch;
        j++;
        continue;
      }
      if (/\s/.test(ch)) break;
      value += ch;
      j++;
    }

    return { value, next: j };
  };

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
        i++;
        const token = readToken(i);
        args[key] = normalizeValue(token.value || "true");
        i = token.next;
      } else {
        // Space-separated value
        const token = readToken(i);
        args[key] = normalizeValue(token.value || "true");
        i = token.next;
      }
      continue;
    }

    const token = readToken(i);
    if (token.value) {
      args[String(positionalIndex)] = normalizeValue(token.value);
      positionalIndex++;
    }
    i = token.next;
  }
  return args;
}

function matchRaftCommand(
  segment: string,
  raftCommand = "raft",
): ParsedCommand | null {
  const match = segment.match(
    new RegExp(`^\\s*${escapeRegExp(raftCommand)}\\s+(\\w+)\\s+(\\w+)(.*)$`),
  );
  if (!match) return null;

  let noun = match[1];
  let verb = match[2];

  if (noun === "message") noun = "msg";
  if (noun !== "msg" && noun !== "task") return null;

  if (noun === "msg" && match[2] === "send") verb = "post";

  return {
    noun: noun as "msg" | "task",
    verb,
    args: parseSegmentArgs(match[3] ?? ""),
    rawSegment: segment,
  };
}

export function parseRaftCommands(
  bashCommand: string,
  options: ParseRaftCommandsOptions = {},
): ParsedCommand[] {
  const segments = splitCommandsPreservingQuotes(bashCommand);
  return segments
    .map((segment) => matchRaftCommand(segment, options.raftCommand))
    .filter((c): c is ParsedCommand => c !== null);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasChainingOperators(bashCommand: string): boolean {
  // Strip quoted strings first, then check for chaining separators outside quotes.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < bashCommand.length; i++) {
    const ch = bashCommand[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (!inSingle && ch === "\\" && (bashCommand[i + 1] === "\n" || bashCommand[i + 1] === "\r")) {
      if (bashCommand[i + 1] === "\r" && bashCommand[i + 2] === "\n") i += 2;
      else i++;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (ch === "&" && bashCommand[i + 1] === "&") return true;
      if (ch === "|" && bashCommand[i + 1] === "|") return true;
      if (ch === ";") return true;
      if (ch === "\n" || ch === "\r") return true;
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
