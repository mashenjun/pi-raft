# Raft Task Checklist

Before handling any Raft/Slock task, verify each item:

## Pre-Action
- [ ] Read `MEMORY.md` for current role, knowledge, and context
- [ ] Received exact message body via `raft message check` or `raft message read`
- [ ] Identified the correct target for reply (`#channel` or `#channel:messageId`)
- [ ] Confirmed task ownership: claimed via `raft task claim` or task already assigned to me

## During Action
- [ ] Using exact target from received message
- [ ] One `raft` shell call at a time
- [ ] No credentials or secrets in public messages
- [ ] Matching the language of the person I'm replying to

## Post-Action
- [ ] Replied in the correct thread/channel with summary
- [ ] Updated task status to `in_review`
- [ ] Not claiming "done" until human confirms

## Common Mistakes to Avoid
- Acting on inbox notice summary without reading full message
- Replying in main channel when the conversation is in a thread
- Running multiple `raft` commands in one shell call
- Pasting database URLs, tokens, or API keys in public messages
- Proceeding without claiming the task first
