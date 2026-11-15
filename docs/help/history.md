# History: which conversations stay shown in each project

## What it means

t3sm keeps each project's list short. Conversations active in the last 90 days stay shown inside their project;
older ones are settled: they stay in their project, on its Settled shelf. A project with fewer recent conversations
still shows its 10 most recent.

## Why it happens

That is the history rule, `organize.history` in config.json (default: the last 90 days, at least 10 per project).
It covers every imported conversation (a thread whose id starts with `import:`), whether t3sm or T3 Code's own import
brought it in; a conversation you started in T3 Code is only ever moved by T3 Code's own auto-settle option.
`t3sm organize` applies the rule; the background sync applies it right after an import to the projects that got new
conversations, and once a day to every project. T3 Code's own auto-settle setting is not changed.

## What to do

- Try another rule for one run first: `t3sm organize --history 30 --min 5 --dry-run` (or `--history all`, or
  `--history off`).
- Keep the one you like in config.json (`organize.history`), or answer it in `t3sm start`.
- To change T3 Code's own setting too, add `--auto-settle 90` (1 to 90 days, or off).
- Every change is journaled: `t3sm organize --undo` puts it back.
