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
  if (/\b(?:start|begin|handle|work on|switch to|move to)\b.{0,40}\b(?:new|fresh|next|different|another)\b/.test(text)) {
    return true;
  }
  if (/\b(?:new|fresh|next|different|another)\b.{0,40}\b(?:task|ticket|issue|work)\b/.test(text)) {
    return true;
  }
  return taskId !== null && mentionsDifferentTaskId(text, taskId);
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
  for (const match of text.matchAll(new RegExp(`${continuation}(?:\\s+(?:on|with|task|the|this))*\\s*#(\\d+)(?!\\d)`, "g"))) {
    ids.add(match[1]);
  }
  return [...ids];
}

function detectShellMutation(command: string, depth = 0): string | null {
  if (hasFileOutputRedirection(command)) {
    return "shell file redirection";
  }

  if (depth < 3) {
    for (const splitStringCommand of envSplitStringCommands(command)) {
      const splitStringMutation = detectShellMutation(splitStringCommand, depth + 1);
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

  const stripped = stripQuotedText(command);
  for (const segment of splitShellSegments(stripped)) {
    if (isMutatingShellSegment(segment)) {
      return "shell file mutation";
    }
  }

  return null;
}

function stripQuotedText(input: string): string {
  let result = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      result += " ";
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      result += " ";
      continue;
    }
    result += inSingle || inDouble ? " " : ch;
  }

  return result;
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
    if (word === "sudo") {
      const next = skipSudoPrefix(words, i + 1);
      if (next === -1) {
        return -1;
      }
      i = next;
      continue;
    }
    if (word === "env") {
      i = skipEnvPrefix(words, i + 1);
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

    const option = word.split("=", 1)[0];
    const hasInlineValue = word.includes("=");
    i++;
    if (sudoOptionNeedsValue(option) && !hasInlineValue && i < words.length) {
      i++;
    }
  }
  return i;
}

function sudoOptionStopsExecution(word: string): boolean {
  const option = word.split("=", 1)[0];
  return /^(?:--(?:list|validate|reset-timestamp|remove-timestamp|version|help)|-[^-]*[lvkKV])$/
    .test(option);
}

function sudoOptionNeedsValue(option: string): boolean {
  return /^(?:-[ughpCTrUDR]|--(?:user|group|host|prompt|close-from|command-timeout|type|role|other-user|chdir|chroot))$/
    .test(option);
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

    const option = word.split("=", 1)[0];
    const hasInlineValue = word.includes("=");
    i++;
    if (envOptionNeedsValue(option) && !hasInlineValue && i < words.length) {
      i++;
    }
  }
  return i;
}

function envOptionNeedsValue(option: string): boolean {
  return /^(?:-[uCS]|--(?:unset|chdir|split-string|argv0|block-signal|default-signal|ignore-signal))$/
    .test(option);
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
    if (words[i] === "sudo") {
      const next = skipSudoPrefix(words, i + 1);
      if (next === -1) return -1;
      i = next;
      continue;
    }
    return words[i] === "env" ? i : -1;
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
        payloads.push(words[i + 1]);
      }
      return;
    }
    if (word.startsWith("--split-string=")) {
      payloads.push(word.slice("--split-string=".length));
      return;
    }

    const option = word.split("=", 1)[0];
    const hasInlineValue = word.includes("=");
    i++;
    if (envOptionNeedsValue(option) && !hasInlineValue && i < words.length) {
      i++;
    }
  }
}

function isShellExecutable(word: string): boolean {
  return /^(?:bash|sh|zsh)$/.test(word.replace(/^.*\//, ""));
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

function isMutatingShellSegment(segment: string): boolean {
  const words = shellWords(segment);
  const commandIndex = executableWordIndex(words);
  const normalized = commandIndex === -1 ? "" : words.slice(commandIndex).join(" ");
  return /^(?:touch|mkdir|mv|cp|rm|chmod|chown|install|tee)\b/.test(normalized) ||
    /^sed\s+-[A-Za-z]*i[A-Za-z]*\b/.test(normalized) ||
    /^perl\s+-[A-Za-z]*i[A-Za-z]*\b/.test(normalized) ||
    isMutatingGitSegment(normalized) ||
    /^(?:npm|pnpm|bun|yarn)\s+(?:install|add|remove|update)\b/.test(normalized) ||
    isTarExtractionSegment(normalized) ||
    /^unzip\b/.test(normalized);
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
