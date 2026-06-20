import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { loadPiRaftConfig } from "./config";
import type { PiRaftConfig } from "./config";
import { scanCredentials } from "./credential-scanner";
import {
  detectDuplicateCommand,
  parseRaftCommands,
} from "./raft-parser";
import { createStateMachine } from "./state-machine";
import type { ActiveState, RaftAction, SlockState, StateMachine } from "./state-machine";
import { buildSlockContext } from "./context-builder";

export default function (pi: ExtensionAPI): void {
  const sm = createStateMachine();

  function persistState(): void {
    pi.appendEntry("pi-raft-state", sm.snapshot());
  }

  pi.on("session_start", (_event, ctx) => {
    let latest: ActiveState | null = null;

    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== "pi-raft-state") continue;
      const data = (entry as { data?: ActiveState }).data;
      if (data && typeof data.currentState === "string") {
        latest = data;
      }
    }

    if (latest) {
      sm.restore(latest);
      console.log(`[pi-raft] restored state: ${latest.currentState}`);
    }
  });

  pi.on("session_shutdown", () => {
    persistState();
  });

  pi.on("tool_call", async (event, ctx) => {
    const config = loadConfigForContext(ctx);

    if (event.toolName === "bash") {
      const command = getBashCommand(event.input);
      if (!command) {
        return;
      }

      const credentialMatch = scanCredentials(command, config.credentialPatterns);
      if (credentialMatch) {
        return handleViolation(
          config,
          ctx,
          `Blocked: Credential detected: '${credentialMatch}'. Remove it before posting.`,
        );
      }

      const raftCommands = parseRaftCommands(command, {
        raftCommand: config.raftCommand,
      });
      if (raftCommands.length > config.maxRaftCommandsPerCall) {
        const reason = detectDuplicateCommand(raftCommands)
          ? "Duplicate raft command detected."
          : "Multiple raft commands in one call. Split them into separate calls.";
        return handleViolation(
          config,
          ctx,
          buildBlockMessage(
            reason,
            sm.snapshot().currentState,
          ),
        );
      }

      const raftActions = raftCommands.map(toRaftAction);
      const shellMutation = detectShellMutation(command);
      if (shellMutation) {
        const canWrite = sm.canWrite();
        if (!canWrite.allowed) {
          return handleViolation(
            config,
            ctx,
            buildBlockMessage(
              `${shellMutation} requires a claimed active task. ${canWrite.reason ?? ""}`.trim(),
              sm.snapshot().currentState,
            ),
          );
        }
        if (raftActionsClearWriteGate(raftActions, sm)) {
          return handleViolation(
            config,
            ctx,
            buildBlockMessage(
              `${shellMutation} cannot be combined with a raft command that clears the active claim. ` +
                "Split the raft command and shell mutation into separate calls.",
              sm.snapshot().currentState,
            ),
          );
        }
      }

      if (raftActions.length > 0) {
        for (const action of raftActions) {
          const before = sm.snapshot();
          const result = sm.transition(action);

          if (!result.allowed) {
            return handleViolation(
              config,
              ctx,
              buildBlockMessage(result.reason, before.currentState),
            );
          }

          if (result.changed !== false) {
            persistState();

            const after = sm.snapshot();
            console.log(
              `[pi-raft] state ${before.currentState} -> ${after.currentState}` +
                (after.taskId ? ` | task: ${after.taskId}` : ""),
            );
          }
        }

        return;
      }

      return;
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const mutationText = getMutationText(event.toolName, event.input);
      const credentialMatch = scanCredentials(mutationText, config.credentialPatterns);
      if (credentialMatch) {
        return handleViolation(
          config,
          ctx,
          `Blocked: Credential detected: '${credentialMatch}'. Remove it before writing.`,
        );
      }

      const canWrite = sm.canWrite();
      if (!canWrite.allowed) {
        return handleViolation(
          config,
          ctx,
          buildBlockMessage(
            canWrite.reason ?? "must claim a task first (raft task claim <task-id>)",
            sm.snapshot().currentState,
          ),
        );
      }

      return;
    }

    return;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const config = loadConfigForContext(ctx);
    if (resetStaleActiveStateForPrompt(event, sm)) {
      persistState();
    }

    if (!config.injectContext) {
      return;
    }

    const context = buildSlockContext(sm.snapshot(), config.contextVerbosity);
    return {
      systemPrompt: event.systemPrompt + "\n\n" + context,
    };
  });
}

function getBashCommand(input: unknown): string {
  if (!input || typeof input !== "object") {
    return "";
  }

  const maybeCommand = (input as { command?: unknown }).command;
  return typeof maybeCommand === "string" ? maybeCommand : "";
}

function loadConfigForContext(ctx: ExtensionContext): PiRaftConfig {
  const result = loadPiRaftConfig({ cwd: ctx.cwd });
  for (const warning of result.warnings) {
    console.warn(`[pi-raft] config warning: ${warning}`);
  }
  return result.config;
}

function getMutationText(toolName: string, input: unknown): string {
  if (!input || typeof input !== "object") {
    return "";
  }

  if (toolName === "write") {
    const content = (input as { content?: unknown }).content;
    return typeof content === "string" ? content : "";
  }

  const edits = (input as { edits?: unknown }).edits;
  if (!Array.isArray(edits)) {
    return "";
  }

  return edits
    .map((edit) => {
      if (!edit || typeof edit !== "object") {
        return "";
      }
      const newText = (edit as { newText?: unknown }).newText;
      return typeof newText === "string" ? newText : "";
    })
    .join("\n");
}

function toRaftAction(parsed: {
  noun: RaftAction["noun"];
  verb: string;
  args: Record<string, string>;
}): RaftAction {
  return {
    noun: parsed.noun,
    verb: parsed.verb,
    args: parsed.args,
  };
}

function raftActionsClearWriteGate(actions: RaftAction[], sm: StateMachine): boolean {
  if (actions.length === 0) {
    return false;
  }

  const preview = createStateMachine(sm.snapshot());
  for (const action of actions) {
    const result = preview.transition(action);
    if (!result.allowed) {
      return false;
    }
    if (!preview.canWrite().allowed) {
      return true;
    }
  }

  return false;
}

function blockToolCall(reason: string): { block: true; reason: string } {
  return {
    block: true,
    reason,
  };
}

function handleViolation(
  config: PiRaftConfig,
  ctx: ExtensionContext,
  reason: string,
): ToolCallEventResult | undefined {
  if (config.strictMode) {
    return blockToolCall(reason);
  }

  ctx.ui.notify(toWarningMessage(reason), "warning");
  return undefined;
}

function toWarningMessage(reason: string): string {
  if (reason.startsWith("Blocked:")) {
    return `Warning: ${reason.slice("Blocked:".length).trim()}`;
  }
  return `Warning: ${reason}`;
}

function buildBlockMessage(reason: string, currentState: SlockState): string {
  const lines = [`Blocked: ${reason}`, `Current state: ${currentState}`];

  if (currentState === "IDLE") {
    lines.push(
      "→ Next: raft msg read --channel <channel>",
      "→ Then: raft task claim <task-id>",
    );
  } else if (currentState === "MESSAGES_READ") {
    lines.push(
      "→ Next: raft task claim <task-id>",
      "→ Then: raft task update --number <task-id> --status in_review",
    );
  } else if (currentState === "TASK_CLAIMED") {
    lines.push(
      "→ Next: raft task update --number <task-id> --status in_review",
      '→ Then: raft msg post --channel <channel> --thread <ts> "your reply"',
    );
  } else if (currentState === "IN_REVIEW") {
    lines.push(
      '→ Next: raft msg post --channel <channel> --thread <ts> "your reply"',
      "→ Then: raft msg read --channel <channel>",
    );
  } else if (currentState === "DONE") {
    lines.push(
      "→ Next: raft msg read --channel <channel>",
      "→ Then: raft task claim <task-id>",
    );
  }

  return lines.join("\n");
}

function resetStaleActiveStateForPrompt(
  event: { prompt?: unknown },
  sm: StateMachine,
): boolean {
  const state = sm.snapshot();
  const hasActiveTaskContext = state.currentState === "TASK_CLAIMED" ||
    state.currentState === "IN_REVIEW" ||
    (state.currentState === "DONE" && state.taskId !== null);
  if (!hasActiveTaskContext) {
    return false;
  }

  const prompt = typeof event.prompt === "string" ? event.prompt : "";
  if (!prompt.trim() || isContinuationPrompt(prompt, state)) {
    return false;
  }

  sm.reset();
  console.log(
    `[pi-raft] reset stale ${state.currentState}` +
      (state.taskId ? ` task: ${state.taskId}` : "") +
      " for fresh prompt",
  );
  return true;
}

function isContinuationPrompt(prompt: string, state: ActiveState): boolean {
  const text = prompt.toLowerCase();
  if (hasFreshWorkIntent(text, state.taskId)) {
    return false;
  }
  if (state.currentState === "DONE" && state.taskId && isApprovalCompletionPrompt(text)) {
    return true;
  }
  if (/\b(continue|resume|keep working|carry on|same task)\b/.test(text)) {
    return true;
  }
  if (/\b(nothing to do|just stop)\b/.test(text)) {
    return true;
  }
  if (state.taskId && mentionsTaskId(text, state.taskId)) {
    return true;
  }
  return false;
}

function hasFreshWorkIntent(text: string, taskId: string | null): boolean {
  if (/\b(?:do not|don't|dont|never)\s+(?:continue|resume|keep working|carry on)\b/.test(text)) {
    return true;
  }
  if (taskId !== null && mentionsRejectedTaskId(text, taskId)) {
    return true;
  }
  if (/\b(?:start|begin|handle|work on|switch to|move to)\b.{0,40}\b(?:new|fresh|next|different|another)\b/.test(text)) {
    return true;
  }
  if (/\b(?:new|fresh|next|different|another)\b.{0,40}\b(?:task|ticket|issue|work)\b/.test(text)) {
    return true;
  }
  return taskId !== null && mentionsDifferentTaskId(text, taskId);
}

function mentionsRejectedTaskId(text: string, taskId: string): boolean {
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const oldTaskPattern = String.raw`(?:task\s*#?${escaped}|#${escaped})(?!\d)`;
  const negatedCompletionAction =
    String.raw`(?:do not|don't|dont|never|no longer)\s+` +
    String.raw`(?:complete|finish)\b`;
  const negatedActiveTaskAction =
    String.raw`(?:do not|don't|dont|never|no longer)\s+` +
    String.raw`(?:work\s+on|use|handle|continue|resume|keep\s+working\s+on|carry\s+on\s+with|claim)\b`;
  const rejectsCompletion =
    new RegExp(String.raw`\b${negatedCompletionAction}.{0,40}${oldTaskPattern}`).test(text) ||
    new RegExp(String.raw`${oldTaskPattern}.{0,40}\b${negatedCompletionAction}`).test(text);
  if (rejectsCompletion && !hasSameTaskContinuationIntent(text, oldTaskPattern)) {
    return true;
  }
  return new RegExp(String.raw`\b(?:ignore|stop|drop|abandon|discard|cancel)\b.{0,30}${oldTaskPattern}`)
    .test(text) ||
    new RegExp(String.raw`${oldTaskPattern}.{0,30}\b(?:ignore|stop|drop|abandon|discard|cancel)\b`)
      .test(text) ||
    new RegExp(String.raw`\b${negatedActiveTaskAction}.{0,40}${oldTaskPattern}`)
      .test(text);
}

function hasSameTaskContinuationIntent(text: string, oldTaskPattern: string): boolean {
  const sameTaskTail = String.raw`(?:\s+(?:(?:on\s+)?(?:it|this task|the task|current task|same task)|for\s+now|as\s+before|when\s+ready))?`;
  return /\bsame task\b/.test(text) ||
    new RegExp(String.raw`${oldTaskPattern}.{0,60}\b(?:continue(?:\s+working)?|resume|keep working|carry on)\b${sameTaskTail}(?:[.!?,;:]|$)`).test(text) ||
    new RegExp(String.raw`\b(?:continue|resume|keep working|carry on)\b.{0,40}${oldTaskPattern}`).test(text) ||
    /\b(?:continue|resume|keep working|carry on)\b.{0,40}\b(?:it|this task|the task|current task)\b/.test(text);
}

function isApprovalCompletionPrompt(text: string): boolean {
  return /\b(?:approved|approve|approval|looks good|lgtm|ok|okay)\b/.test(text) ||
    /\b(?:mark|set|update|close)\b.{0,30}\b(?:done|complete|completed|closed)\b/.test(text) ||
    /\b(?:complete|close)\s+(?:the\s+)?(?:task|ticket|issue|work)\b/.test(text);
}

function mentionsTaskId(text: string, taskId: string): boolean {
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:task\\s*#?${escaped}|#${escaped})(?!\\d)`).test(text);
}

function mentionsDifferentTaskId(text: string, taskId: string): boolean {
  const ids = new Set([...taskIdsMentioned(text), ...continuationBareTaskIdsMentioned(text)]);
  return [...ids].some((mentionedTaskId) => mentionedTaskId !== taskId);
}

function taskIdsMentioned(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(/\btask\s*#?(\d+)(?!\d)/g)) {
    ids.add(match[1]);
  }
  return [...ids];
}

function continuationBareTaskIdsMentioned(text: string): string[] {
  const ids = new Set<string>();
  const continuation = String.raw`\b(?:continue|resume|keep working|carry on|same task)\b`;
  const connector = String.raw`(?:on|with|for|task|ticket|issue|work|the|this|current|same|github|gh|pr)`;
  for (const match of text.matchAll(new RegExp(`${continuation}(?:\\s+${connector}){0,8}\\s*#(\\d+)(?!\\d)`, "g"))) {
    ids.add(match[1]);
  }
  return [...ids];
}

function detectShellMutation(command: string, depth = 0): string | null {
  if (depth < 3) {
    for (const substitutionCommand of shellSubstitutionCommands(command)) {
      const substitutionMutation = detectShellMutation(substitutionCommand, depth + 1);
      if (substitutionMutation) {
        return substitutionMutation;
      }
    }

    for (const splitStringCommand of envSplitStringCommands(command)) {
      const splitStringMutation = detectShellMutation(`env ${splitStringCommand}`, depth + 1);
      if (splitStringMutation) {
        return splitStringMutation;
      }
    }

    for (const nestedCommand of nestedShellCommands(command)) {
      const nestedMutation = detectShellMutation(nestedCommand, depth + 1);
      if (nestedMutation) {
        return nestedMutation;
      }
    }
  }

  if (hasFileOutputRedirection(command)) {
    return "shell file redirection";
  }

  for (const segment of splitShellSegments(command)) {
    if (isMutatingShellSegment(segment, depth)) {
      return "shell file mutation";
    }
  }

  return null;
}

function shellSubstitutionCommands(input: string): string[] {
  const commands: string[] = [];
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1] ?? "";

    if (ch === "\\" && !inSingle) {
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle) {
      continue;
    }

    if (ch === "$" && next === "(" && input[i + 2] !== "(") {
      const parsed = readParenthesized(input, i + 1);
      if (parsed) {
        commands.push(parsed.body);
        i = parsed.end;
      }
      continue;
    }
    if ((ch === "<" || ch === ">") && next === "(") {
      const parsed = readParenthesized(input, i + 1);
      if (parsed) {
        commands.push(parsed.body);
        i = parsed.end;
      }
      continue;
    }
    if (ch === "`") {
      const parsed = readBacktickSubstitution(input, i);
      if (parsed) {
        commands.push(parsed.body);
        i = parsed.end;
      }
    }
  }

  return commands;
}

function readParenthesized(input: string, openIndex: number): { body: string; end: number } | null {
  let depth = 1;
  let quote: "'" | '"' | null = null;

  for (let i = openIndex + 1; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < input.length) {
        i++;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\" && i + 1 < input.length) {
      i++;
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth--;
      if (depth === 0) {
        return { body: input.slice(openIndex + 1, i), end: i };
      }
    }
  }

  return null;
}

function readBacktickSubstitution(input: string, start: number): { body: string; end: number } | null {
  let body = "";
  for (let i = start + 1; i < input.length; i++) {
    const ch = input[i];
    if (ch === "\\" && i + 1 < input.length) {
      i++;
      body += input[i];
      continue;
    }
    if (ch === "`") {
      return { body, end: i };
    }
    body += ch;
  }
  return null;
}

function hasFileOutputRedirection(command: string): boolean {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) {
      continue;
    }

    const isAmpersandRedirect = ch === "&" && command[i + 1] === ">";
    const isOutputRedirect = ch === ">" && command[i - 1] !== "=";
    if (!isAmpersandRedirect && !isOutputRedirect) {
      continue;
    }

    const targetStart = skipRedirectOperator(command, i);
    const target = readRedirectTarget(command, targetStart);
    if (!target || target === "/dev/null" || /^&\d+$/.test(target)) {
      i = targetStart;
      continue;
    }

    return true;
  }

  return false;
}

function skipRedirectOperator(command: string, index: number): number {
  let i = index;
  if (command[i] === "&") {
    i++;
  }
  while (command[i] === ">") {
    i++;
  }
  while (i < command.length && /\s/.test(command[i])) {
    i++;
  }
  return i;
}

function readRedirectTarget(command: string, start: number): string {
  let i = start;
  let quote: "'" | '"' | null = null;
  let target = "";

  while (i < command.length) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        target += ch;
      }
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      break;
    }
    target += ch;
    i++;
  }

  return target;
}

function splitShellSegments(strippedCommand: string): string[] {
  return splitShellStages(strippedCommand);
}

function splitShellStages(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1] ?? "";

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
      if (ch === "|" && next === "&") {
        pushShellStage(segments, current);
        current = "";
        i++;
        continue;
      }
      if (ch === "&" && next === "&") {
        pushShellStage(segments, current);
        current = "";
        i++;
        continue;
      }
      if (ch === "|" && next === "|") {
        pushShellStage(segments, current);
        current = "";
        i++;
        continue;
      }
      if (ch === "|" || ch === ";") {
        pushShellStage(segments, current);
        current = "";
        continue;
      }
      if (ch === "\n" || ch === "\r" || (ch === "&" && command[i - 1] !== ">")) {
        pushShellStage(segments, current);
        current = "";
        continue;
      }
    }

    current += ch;
  }

  pushShellStage(segments, current);
  return segments;
}

function pushShellStage(segments: string[], segment: string): void {
  const trimmed = segment.trim();
  if (trimmed) {
    segments.push(trimmed);
  }
}

function nestedShellCommands(command: string): string[] {
  const nestedCommands: string[] = [];
  for (const stage of splitShellStages(command)) {
    const words = shellWords(stage);
    let i = executableWordIndex(words);
    if (i === -1 || !isShellExecutable(words[i])) {
      continue;
    }

    const payloadIndex = shellCommandPayloadIndex(words, i + 1);
    if (payloadIndex !== -1 && words[payloadIndex]) {
      nestedCommands.push(words[payloadIndex]);
    }
  }
  return nestedCommands;
}

function shellCommandPayloadIndex(words: string[], start: number): number {
  let i = start;
  while (i < words.length) {
    const word = words[i];
    if (word === "--") {
      i++;
      continue;
    }
    if (word === "-c" || /^-[^-]\S*c\S*$/.test(word)) {
      return i + 1;
    }
    if (word.startsWith("--")) {
      i++;
      continue;
    }
    if (word.startsWith("-")) {
      i++;
      continue;
    }
    return -1;
  }
  return -1;
}

function executableWordIndex(words: string[]): number {
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (commandBaseName(word) === "sudo") {
      const next = skipSudoPrefix(words, i + 1);
      if (next === -1) {
        return -1;
      }
      i = next;
      continue;
    }
    if (commandBaseName(word) === "env") {
      i = skipEnvPrefix(words, i + 1);
      continue;
    }
    if (commandBaseName(word) === "command") {
      const next = skipCommandPrefix(words, i + 1);
      if (next === -1) {
        return -1;
      }
      i = next;
      continue;
    }
    return i;
  }
  return -1;
}

function skipCommandPrefix(words: string[], start: number): number {
  let i = start;
  while (i < words.length) {
    const word = words[i];
    if (word === "--") {
      return i + 1;
    }
    if (word === "-v" || word === "-V") {
      return -1;
    }
    if (word === "-p") {
      i++;
      continue;
    }
    return i;
  }
  return -1;
}

function skipSudoPrefix(words: string[], start: number): number {
  let i = start;
  while (i < words.length) {
    const word = words[i];
    if (word === "--") {
      return i + 1;
    }
    if (!word.startsWith("-") || word === "-") {
      return i;
    }
    if (sudoOptionStopsExecution(word)) {
      return -1;
    }

    i = skipSudoOption(words, i);
  }
  return i;
}

function sudoOptionStopsExecution(word: string): boolean {
  if (word.startsWith("--")) {
    const option = word.split("=", 1)[0];
    return /^(?:--(?:list|validate|remove-timestamp|version|help))$/.test(option);
  }
  if (!/^-[^-]\S*$/.test(word)) {
    return false;
  }
  const chars = word.slice(1);
  for (let pos = 0; pos < chars.length; pos++) {
    const option = chars[pos];
    if ("lvKV".includes(option)) {
      return true;
    }
    if (sudoShortOptionNeedsValue(option)) {
      return false;
    }
  }
  return false;
}

function skipSudoOption(words: string[], index: number): number {
  const word = words[index];
  if (word.startsWith("--")) {
    const option = word.split("=", 1)[0];
    const hasInlineValue = word.includes("=");
    let next = index + 1;
    if (sudoLongOptionNeedsValue(option) && !hasInlineValue && next < words.length) {
      next++;
    }
    return next;
  }

  if (/^-[^-]\S*$/.test(word)) {
    const chars = word.slice(1);
    for (let pos = 0; pos < chars.length; pos++) {
      if (sudoShortOptionNeedsValue(chars[pos])) {
        return pos < chars.length - 1 ? index + 1 : Math.min(index + 2, words.length);
      }
    }
  }

  return index + 1;
}

function sudoLongOptionNeedsValue(option: string): boolean {
  return /^(?:--(?:user|group|host|prompt|close-from|command-timeout|type|role|other-user|chdir|chroot))$/
    .test(option);
}

function sudoShortOptionNeedsValue(option: string): boolean {
  return "ughpCTrUDR".includes(option);
}

function skipEnvPrefix(words: string[], start: number): number {
  let i = start;
  while (i < words.length) {
    const word = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      i++;
      continue;
    }
    if (word === "--") {
      return i + 1;
    }
    if (!word.startsWith("-") || word === "-") {
      return i;
    }

    i = skipEnvOption(words, i);
  }
  return i;
}

function skipEnvOption(words: string[], index: number): number {
  const word = words[index];
  if (word.startsWith("--")) {
    const option = word.split("=", 1)[0];
    const hasInlineValue = word.includes("=");
    let next = index + 1;
    if (envLongOptionNeedsValue(option) && !hasInlineValue && next < words.length) {
      next++;
    }
    return next;
  }

  if (/^-[^-]\S*$/.test(word)) {
    const chars = word.slice(1);
    for (let pos = 0; pos < chars.length; pos++) {
      if (envShortOptionNeedsValue(chars[pos])) {
        return pos < chars.length - 1 ? index + 1 : Math.min(index + 2, words.length);
      }
    }
  }

  return index + 1;
}

function envLongOptionNeedsValue(option: string): boolean {
  return /^(?:--(?:unset|chdir|split-string|argv0|block-signal|default-signal|ignore-signal))$/
    .test(option);
}

function envShortOptionNeedsValue(option: string): boolean {
  return "uCS".includes(option);
}

function envSplitStringCommands(command: string): string[] {
  const payloads: string[] = [];
  for (const stage of splitShellStages(command)) {
    const words = shellWords(stage);
    const envIndex = envWordIndex(words);
    if (envIndex === -1) {
      continue;
    }
    collectEnvSplitStringPayloads(words, envIndex + 1, payloads);
  }
  return payloads;
}

function envWordIndex(words: string[]): number {
  let i = 0;
  while (i < words.length) {
    if (commandBaseName(words[i]) === "command") {
      const next = skipCommandPrefix(words, i + 1);
      if (next === -1) return -1;
      i = next;
      continue;
    }
    if (commandBaseName(words[i]) === "sudo") {
      const next = skipSudoPrefix(words, i + 1);
      if (next === -1) return -1;
      i = next;
      continue;
    }
    return commandBaseName(words[i]) === "env" ? i : -1;
  }
  return -1;
}

function collectEnvSplitStringPayloads(words: string[], start: number, payloads: string[]): void {
  let i = start;
  while (i < words.length) {
    const word = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      i++;
      continue;
    }
    if (word === "--") {
      return;
    }
    if (!word.startsWith("-") || word === "-") {
      return;
    }

    if (word === "-S" || word === "--split-string") {
      if (i + 1 < words.length) {
        payloads.push(envSplitCommand(words[i + 1], words.slice(i + 2)));
      }
      return;
    }
    if (word.startsWith("--split-string=")) {
      payloads.push(envSplitCommand(word.slice("--split-string=".length), words.slice(i + 1)));
      return;
    }
    if (/^-[^-]\S*$/.test(word)) {
      const chars = word.slice(1);
      for (let pos = 0; pos < chars.length; pos++) {
        const char = chars[pos];
        if (char === "S") {
          const attachedPayload = chars.slice(pos + 1);
          if (attachedPayload !== "") {
            payloads.push(envSplitCommand(attachedPayload, words.slice(i + 1)));
          } else if (i + 1 < words.length) {
            payloads.push(envSplitCommand(words[i + 1], words.slice(i + 2)));
          }
          return;
        }
        if (envShortOptionNeedsValue(char)) {
          return;
        }
      }
    }

    i = skipEnvOption(words, i);
  }
}

function envSplitCommand(payload: string, remainingWords: string[]): string {
  return ["env", payload, ...remainingWords.map(shellQuoteWord)].join(" ");
}

function shellQuoteWord(word: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(word)) {
    return word;
  }
  return `'${word.replace(/'/g, "'\\''")}'`;
}

function isShellExecutable(word: string): boolean {
  return /^(?:bash|sh|zsh)$/.test(commandBaseName(word));
}

function commandBaseName(word: string): string {
  return word.replace(/^.*\//, "");
}

function shellWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (quote === '"' && ch === "\\" && i + 1 < input.length) {
        i++;
        current += input[i];
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (current) {
    words.push(current);
  }
  return words;
}

function isMutatingShellSegment(segment: string, depth = 0): boolean {
  const words = shellWords(segment);
  const commandIndex = executableWordIndex(words);
  const normalized = commandIndex === -1
    ? ""
    : [commandBaseName(words[commandIndex]), ...words.slice(commandIndex + 1)].join(" ");
  return isSudoEditSegment(segment) ||
    /^(?:touch|mkdir|mv|cp|rm|chmod|chown|install|tee)\b/.test(normalized) ||
    isSedInPlaceSegment(normalized) ||
    /^perl\s+-[A-Za-z]*i[A-Za-z]*\b/.test(normalized) ||
    isMutatingGitSegment(normalized) ||
    isMutatingPackageManagerSegment(normalized) ||
    isTarExtractionSegment(normalized) ||
    isPatchSegment(normalized) ||
    isMutatingFindSegment(normalized, depth) ||
    /^unzip\b/.test(normalized);
}

function isSudoEditSegment(segment: string): boolean {
  const words = shellWords(segment);
  let i = 0;
  while (i < words.length) {
    if (commandBaseName(words[i]) === "command") {
      const next = skipCommandPrefix(words, i + 1);
      if (next === -1) return false;
      i = next;
      continue;
    }
    if (commandBaseName(words[i]) === "env") {
      i = skipEnvPrefix(words, i + 1);
      continue;
    }
    break;
  }
  if (i >= words.length) {
    return false;
  }
  if (commandBaseName(words[i]) === "sudoedit") {
    return !words.slice(i + 1).some(isHelpOption);
  }
  if (commandBaseName(words[i]) !== "sudo") {
    return false;
  }

  i++;
  while (i < words.length) {
    const word = words[i];
    if (word === "--") {
      return false;
    }
    if (!word.startsWith("-") || word === "-") {
      return commandBaseName(word) === "sudoedit" && !words.slice(i + 1).some(isHelpOption);
    }
    if (word === "--edit" || word.startsWith("--edit=")) {
      return true;
    }
    if (word.startsWith("--")) {
      i = skipSudoOption(words, i);
      continue;
    }
    if (sudoShortOptionHasEditMode(word)) {
      return true;
    }
    i = skipSudoOption(words, i);
  }
  return false;
}

function sudoShortOptionHasEditMode(word: string): boolean {
  if (!/^-[^-]\S*$/.test(word)) {
    return false;
  }
  const chars = word.slice(1);
  for (let pos = 0; pos < chars.length; pos++) {
    const option = chars[pos];
    if (option === "e") {
      return true;
    }
    if (sudoShortOptionNeedsValue(option)) {
      return false;
    }
  }
  return false;
}

function isSedInPlaceSegment(segment: string): boolean {
  const words = shellWords(segment);
  if (commandBaseName(words[0] ?? "") !== "sed") {
    return false;
  }
  for (const word of words.slice(1)) {
    if (word === "--") {
      return false;
    }
    if (word === "--in-place" || word.startsWith("--in-place=")) {
      return true;
    }
    if (/^-[^-]\S*$/.test(word) && word.slice(1).includes("i")) {
      return true;
    }
  }
  return false;
}

function isMutatingGitSegment(segment: string): boolean {
  const words = shellWords(segment);
  if (words[0] !== "git" || words.length < 2) {
    return false;
  }

  const subcommandIndex = gitSubcommandIndex(words);
  if (subcommandIndex === -1) {
    return false;
  }

  const subcommand = words[subcommandIndex];
  if (subcommand === "apply" || subcommand === "checkout-index" || subcommand === "restore") {
    return true;
  }
  if (subcommand === "rm" || subcommand === "mv") {
    const args = words.slice(subcommandIndex + 1);
    const optionArgs = gitOptionArgsBeforePathspec(args);
    return !optionArgs.some(isGitDryRunOption) && !optionArgs.some(isHelpOption);
  }
  if (subcommand === "clean") {
    return !words.slice(subcommandIndex + 1).some(isGitDryRunOption);
  }
  if (subcommand === "reset") {
    return words.slice(subcommandIndex + 1).includes("--hard");
  }
  if (subcommand === "checkout") {
    return words.length > subcommandIndex + 1 && !words.slice(subcommandIndex + 1).some(isHelpOption);
  }
  if (subcommand === "switch") {
    return words.length > subcommandIndex + 1 && !words.slice(subcommandIndex + 1).some(isHelpOption);
  }
  return false;
}

function gitOptionArgsBeforePathspec(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      break;
    }
    result.push(arg);
    if (gitPathspecOptionNeedsValue(arg) && !arg.includes("=") && i + 1 < args.length) {
      i++;
    }
  }
  return result;
}

function gitPathspecOptionNeedsValue(option: string): boolean {
  const canonical = "--pathspec-from-file";
  return option === canonical ||
    (option.length >= "--pathspec-fr".length && canonical.startsWith(option));
}

function gitSubcommandIndex(words: string[]): number {
  let i = 1;
  while (i < words.length) {
    const word = words[i];
    if (word === "--") {
      return i + 1 < words.length ? i + 1 : -1;
    }
    if (!word.startsWith("-") || word === "-") {
      return i;
    }
    if (/^-[Cc].+/.test(word)) {
      i++;
      continue;
    }

    const option = word.split("=", 1)[0];
    const hasInlineValue = word.includes("=");
    i++;
    if (gitGlobalOptionNeedsValue(option) && !hasInlineValue && i < words.length) {
      i++;
    }
  }
  return -1;
}

function gitGlobalOptionNeedsValue(option: string): boolean {
  return /^(?:-[Cc]|--(?:git-dir|work-tree|namespace|config-env|super-prefix))$/.test(option);
}

function isGitDryRunOption(word: string): boolean {
  return word === "--dry-run" || word.startsWith("--dry-run=") ||
    (/^-[A-Za-z]+$/.test(word) && word.includes("n"));
}

function isHelpOption(word: string): boolean {
  return word === "--help" || word === "-h";
}

function isMutatingPackageManagerSegment(segment: string): boolean {
  const words = shellWords(segment);
  const executable = commandBaseName(words[0] ?? "");
  if (!/^(?:npm|pnpm|bun|yarn)$/.test(executable) || words.length < 2) {
    return false;
  }
  if (hasPackageDryRunOption(executable, words.slice(1))) {
    return false;
  }
  if (executable === "npm") {
    return /^(?:install|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall|ci|add|remove|rm|r|uninstall|unlink|un|update|up|upgrade|udpate|link|ln)$/
      .test(words[1]);
  }
  return /^(?:install|i|ci|add|remove|rm|uninstall|update|up)$/.test(words[1]);
}

function hasPackageDryRunOption(executable: string, args: string[]): boolean {
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === "--") {
      break;
    }
    if (word === "--no-dry-run") {
      dryRun = false;
      continue;
    }
    if (word.startsWith("--no-dry-run=")) {
      dryRun = executable !== "bun" && noDryRunOptionValueMeansDryRun(word);
      continue;
    }
    if (word === "--dry-run") {
      if (i + 1 < args.length && isFalseOptionValue(args[i + 1])) {
        i++;
        dryRun = false;
        continue;
      }
      dryRun = true;
      continue;
    }
    if (isPackageDryRunOption(word)) {
      dryRun = true;
      continue;
    }
    if (isPackageNoDryRunOption(word)) {
      dryRun = false;
    }
  }
  return dryRun;
}

function noDryRunOptionValueMeansDryRun(word: string): boolean {
  const value = word.slice("--no-dry-run=".length).toLowerCase();
  return isFalseOptionValue(value);
}

function isPackageDryRunOption(word: string): boolean {
  if (!word.startsWith("--dry-run=")) {
    return false;
  }
  const value = word.slice("--dry-run=".length).toLowerCase();
  return value === "" || value === "true" || value === "1" || value === "yes" || value === "on";
}

function isPackageNoDryRunOption(word: string): boolean {
  if (!word.startsWith("--dry-run=")) {
    return false;
  }
  const value = word.slice("--dry-run=".length).toLowerCase();
  return isFalseOptionValue(value);
}

function isFalseOptionValue(word: string): boolean {
  const value = word.toLowerCase();
  return value === "false" || value === "0" || value === "no" || value === "off";
}

function isPatchSegment(segment: string): boolean {
  const words = shellWords(segment);
  if (commandBaseName(words[0] ?? "") !== "patch") {
    return false;
  }
  return !words.slice(1).some((word) => isHelpOption(word) || word === "--version" || word === "--dry-run");
}

function isMutatingFindSegment(segment: string, depth: number): boolean {
  const words = shellWords(segment);
  if (commandBaseName(words[0] ?? "") !== "find") {
    return false;
  }
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (/^-f(?:ls|print|print0|printf)$/.test(word) || word === "-delete") {
      return true;
    }
    if (word === "-exec" || word === "-execdir" || word === "-ok" || word === "-okdir") {
      const payload: string[] = [];
      i++;
      while (i < words.length && !isFindExecTerminator(words[i])) {
        payload.push(words[i]);
        i++;
      }
      if (payload.length > 0 && depth < 3 && detectShellMutation(payload.join(" "), depth + 1)) {
        return true;
      }
    }
  }
  return false;
}

function isFindExecTerminator(word: string): boolean {
  return word === ";" || word === "\\;" || word === "+";
}

function isTarExtractionSegment(segment: string): boolean {
  const words = shellWords(segment);
  if (words.length < 2 || !/^(?:tar|bsdtar)$/.test(words[0])) {
    return false;
  }
  return words.slice(1).some((word) => {
    if (word === "--extract" || word.startsWith("--extract=") ||
      word === "--get" || word.startsWith("--get=")) {
      return true;
    }
    if (word.startsWith("-")) {
      return word.slice(1).includes("x");
    }
    return /^[A-Za-z]*x[A-Za-z]*$/.test(word);
  });
}
