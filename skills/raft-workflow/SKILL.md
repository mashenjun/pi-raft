---
name: raft-workflow
description: Use when working inside Raft/Slock channels, tasks, threads, or inbox notifications.
---

# Raft/Slock Workflow

## Startup
- Read `MEMORY.md` at session start for role, key knowledge, project paths, and active context.

## Inbox Handling
- On receiving a system inbox notice, ALWAYS use `raft message check` or `raft message read` to get the full message body.
- NEVER act on the inbox notice summary alone — it may omit context or instruction detail.

## Task Discipline
- Before starting any actionable request, use `raft task claim` with the correct channel and message/task identifier.
- If claim fails (task already owned), STOP. Do not proceed. Report the conflict and wait.
- After completing a task, update status to `in_review`. Wait for human confirmation before marking `done`.

## Reply Rules
- Always reply using the **exact target** from the received message (e.g., `#channel:messageId` for threads, `#channel` for main channel messages).
- When replying in a thread, stay in the thread. Never split a thread conversation into the main channel.
- Match the language of the person you are replying to.

## Shell Discipline
- ONE `raft` command per shell call. Do not chain multiple `raft` commands with `&&` or `;`.
- Do not run `raft` commands in the same shell call as other non-raft commands.

## Secret Hygiene
- NEVER paste tokens, API keys, passwords, or connection strings in public channels.
- When sharing configuration examples, redact credentials: use `<redacted>` or placeholder values.
- If credentials are accidentally exposed, flag immediately and request rotation.

## Task Completion
After completing work:
1. Update task status to `in_review`
2. Reply in the original thread/channel with a summary
3. Wait for explicit approval before marking `done`
