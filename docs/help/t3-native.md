# Started in T3 Code: conversations t3sm leaves out

## What it means

These conversations were started inside T3 Code, but T3 Code no longer reports a thread t3sm can match them to.
t3sm never copies a conversation that belongs to T3 Code itself, so they stay as they are.

## Why it happens

- The thread was removed in T3 Code, or T3 Code was reinstalled and lost its own list.
- The session file was copied from another machine.

## What to do

- If T3 Code still shows the conversation, there is nothing to do.
- If it does not, you can still continue it in a terminal: `claude --resume <session id>` (the id is the file's
  name).
- `t3sm status` lists them under Worth knowing.
