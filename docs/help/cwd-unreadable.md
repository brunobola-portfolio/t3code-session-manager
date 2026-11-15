# Folder unreadable: T3 Code cannot tell where a conversation ran

## What it means

T3 Code files each conversation under a project by the folder written at the start of its transcript, and it only
looks at the first 1 MiB (and the first 1000 records). This conversation's folder is past that point, or not recorded
at all, so T3 Code cannot place it:

- `t3sm apply` (and `t3sm sync`) report it as not imported: "its folder is unreadable" (exit 5);
- `t3sm plan` counts it under the skipped sessions: "folder unreadable", or "no folder recorded" when the transcript
  names no folder.

## Why it happens

The conversation began with a very large first message or attachment, so the folder comes too late, or the agent
never wrote a folder into it.

## What to do

- Nothing to fix in t3sm, and running `t3sm apply` again does not change it: the transcript stays as it is.
- The conversation is safe on disk. Continue it in a terminal from its project folder, for a Claude Code session with
  `claude --resume <session id>` (the id is the transcript's file name).
