# Started in T3 Code: conversations t3sm leaves out

## What it means

These conversations were started inside T3 Code, but T3 Code no longer reports a thread t3sm can match them to.
t3sm never copies a conversation that belongs to T3 Code itself on its own, so they stay as they are until you say
otherwise.

## Why it happens

- The thread was removed in T3 Code, or T3 Code was reinstalled and lost its own list.
- The session file was copied from another machine.

## What to do

- If T3 Code still shows the conversation, there is nothing to do.
- If it does not (you deleted its thread, for example), bring it back with `t3sm recover <session id>`: a faithful
  copy with a new id, imported into its project. Try `t3sm recover <session id> --dry-run` first. t3sm cannot see
  whether the thread still exists, so if it does, this makes a duplicate. Undo with
  `t3sm rollback --run <id> --archive-threads`.
- You can also continue it in a terminal: `claude --resume <session id>` (the id is the file's name).
- `t3sm status` lists them under Worth knowing.
