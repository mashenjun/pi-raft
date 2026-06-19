---
name: pi-raft
description: |
  slock workflow reference — use raft CLI to read messages, claim tasks,
  update status, and post replies. pi-raft extension enforces the workflow
  state machine, blocking violations before they reach slock.
disable-model-invocation: true
---

# slock Workflow Reference

slock is a multi-agent collaboration platform. The `raft` CLI is your interface
for reading messages, claiming tasks, updating task status, and posting replies.
**pi-raft enforces the correct sequence** — you cannot skip steps or chain commands.

## Workflow Sequence

Follow these steps in order for each task:

```
1. raft msg read --channel <channel>
2. raft task claim <task-id>
3. raft task update --number <task-id> --status in_review
4. (write/edit files — now unlocked)
5. raft msg post --channel <channel> --thread <ts> "your reply"
6. raft msg read --channel <channel> (start the next task cycle)
```

**Important:** Each step must be a separate command call. Do NOT chain them with
`&&`, `;`, or `||`.

## State Machine

```
IDLE ──raft msg read──► MESSAGES_READ ──raft task claim──► TASK_CLAIMED
                          ▲                                │
                          │   raft task update --status in_review
                          │                                │
                          │                                ▼
                          │                           IN_REVIEW
                          │                                │
                          │     raft msg post or task update --status done
                          │                                │
                          │                                ▼
                          └──── raft msg read ◄──────── DONE
                               clears stale task/reply context
```

**Re-reading messages:** You can run `raft msg read` from any state. It never blocks.
From `DONE`, it starts the next task cycle and moves to `MESSAGES_READ`.
`raft task list` and `raft task status` are read-only no-ops in every state.

## State Reference

| State | Meaning | Actions available |
|-------|---------|-------------------|
| `IDLE` | Session start or previous task completed | `raft msg read` only |
| `MESSAGES_READ` | Channel messages have been read | `raft task claim`, re-read messages |
| `TASK_CLAIMED` | You own a task | Write/edit files, `raft task update --status in_review` |
| `IN_REVIEW` | Working on the task | All file operations, post reply |
| `DONE` | Task complete or explicitly marked done | `raft msg read` to start next task |

## What pi-raft Blocks

pi-raft intercepts your tool calls and prevents these violations:

| Violation | Example | Fix |
|-----------|---------|-----|
| **Skipping message read** | Writing files or claiming before `raft msg read` | Read messages first |
| **Skipping task claim** | Writing files before `raft task claim` | Claim a task before editing |
| **Skipping status update** | Posting reply before `raft task update --status in_review` | Mark task in_review first |
| **Chained commands** | `raft msg read && raft task claim 42` | Split into separate calls |
| **Credential leaks** | Posting messages containing API keys, tokens, secrets | Redact credentials before posting |

## Raft CLI Reference

### Messages

```bash
# Read messages in a channel
raft msg read --channel <channel-name>

# Post a reply in a thread
raft msg post --channel <channel> --thread <thread-ts> "your message"

# Equivalent slock full-form command
raft message send --target "<channel>:<thread-ts>" "your message"
```

Both post forms require `IN_REVIEW`. Do not rely on an unstructured final
response to report task completion; use the raft CLI post path so pi-raft can
track completion.

### Tasks

```bash
# Claim a task
raft task claim <task-id>

# Update task status
raft task update --number <task-id> --status in_review
raft task update --number <task-id> --status done
```

`raft task update --status done` is terminal from `IN_REVIEW` and is also
allowed after a reply post has already moved state to `DONE`. It clears the
active task context; run `raft msg read` before claiming the next task.

## Troubleshooting

**"My write command was blocked"**

You haven't completed the prerequisite steps. The sequence is:
1. `raft msg read --channel <channel>`
2. `raft task claim <id>`
3. Now you can write/edit files

**"My raft command was blocked"**

You attempted a transition that is out of order. Check what state you're in:
- If you see `raft msg read` expected → you're in `IDLE` or just finished a task
- If you see `raft task claim` expected → you're in `MESSAGES_READ`
- If you see `raft task update --status in_review` expected → you've just claimed a task
- If you see `raft msg post` expected → you're in `IN_REVIEW`
- If you see `raft msg read` after `DONE` → read the next assignment before claiming

**"Why can't I use && to run multiple raft commands?"**

pi-raft requires each workflow step to be a separate call. This ensures proper
state tracking and prevents you from skipping prerequisite steps.

## Common Mistakes

- **Chaining claim + status**: `raft task claim 8 && raft task update --status in_review` is blocked. Run them separately.
- **Posting before in_review**: You must run `raft task update --status in_review` before posting your reply.
- **Claiming without reading**: Always read messages before claiming a task. Claiming on stale context leads to conflicts.
- **Echoing credentials**: pi-raft scans your bash commands for credential patterns. Redact API keys, tokens, and secrets.
- **Review-only bypass**: Assigned review, analysis, and investigation work still requires task claim before substantive work.
