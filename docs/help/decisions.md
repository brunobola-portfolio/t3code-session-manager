# Decisions: conversations that wait for your answer

## What it means

Some conversations need a yes or no from you before t3sm brings them into T3 Code, and t3sm never guesses. Until you
answer, they wait; everything else is imported as usual.

## Why it happens

t3sm asks about:

- conversations started in your home folder, or in a folder T3 Code refuses to open;
- conversations in temporary or system folders;
- automated conversations (started by the Agent SDK);
- conversations you deleted in T3 Code.

## What to do

- Run `t3sm start`: it asks each question once, explains the choices and remembers your answers in config.json.
- `t3sm status` and `t3sm plan` say how many conversations wait for each question.
