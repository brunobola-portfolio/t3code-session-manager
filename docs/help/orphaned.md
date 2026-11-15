# Deleted in T3 Code: conversations that come back as copies

## What it means

These conversations were started in T3 Code, and you deleted their threads there. Their session files are still on
this machine. By default t3sm brings each one back as a copy, once you said yes to that question in `t3sm start`
(the setting `organize.sessions.orphaned` is `"copy"`). Until the question is answered, they wait.

## Why one is left out

You answered no in `t3sm start`, or set `organize.sessions.orphaned` to `"skip"` in config.json: a conversation you
deleted is then never copied back behind your back.

## What to do

- Nothing, if you meant to delete them.
- To bring them back, set `organize.sessions.orphaned` to `"copy"` in config.json (or answer yes in `t3sm start`),
  then run `t3sm plan` and `t3sm apply`.
- `t3sm status` lists the ones left out under Worth knowing.
