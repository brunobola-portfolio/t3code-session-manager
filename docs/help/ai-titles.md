# Titles written by T3 Code: the ones that stay technical

## What it means

Some imported conversations keep a technical title (a command, a pasted log, an image) because their transcript has
no usable first message. `t3sm organize --ai-titles` asks T3 Code to write those titles with its own text model, the
one set in T3 Code's settings. That spends your provider's tokens, so it is off unless you ask for it.

## Why it happens

t3sm cleans a title from the transcript itself first (its own title, summary or first real message), at no cost.
Only a title still technical after that is handed to T3 Code: a conversation you did not rename by hand, not archived,
not automated, and never handed to T3 Code before. Before anything runs, the summary says how many titles, which model
(when T3 Code reports it) and the cap of the run (`--ai-titles-max`, default 50: the most recent conversations first).
T3 Code writes each title a few seconds later; t3sm waits up to 2 minutes and records each title it wrote. The
background sync never asks T3 Code for titles.

## What to do

- See it first: `t3sm organize --ai-titles --dry-run`.
- Fewer per run: `t3sm organize --ai-titles --ai-titles-max 20`.
- A title T3 Code could not write: t3sm shows its reason. Check the text model in T3 Code's settings, then run
  `t3sm organize --ai-titles` again; that conversation is asked for again.
- Always on for `t3sm organize`: set `organize.aiTitles.enabled` to `true` in config.json (`maxPerRun` sets the cap);
  `--no-ai-titles` skips it for one run.
- `t3sm organize --undo` puts back the old titles t3sm recorded. A title T3 Code wrote after the wait ended stays as
  it is: t3sm cannot tell it from one you set by hand.
