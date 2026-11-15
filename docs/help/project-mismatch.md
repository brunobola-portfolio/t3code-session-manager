# Project mismatch: T3 Code filed a conversation elsewhere

## What it means

The conversation was imported, but into another project than the one in the plan, so t3sm reports it instead of
calling it done.

## Why it happens

The project was renamed, moved or created again in T3 Code after the plan was made.

## What to do

1. Check the conversation in T3 Code: it is there, in another project.
2. Run `t3sm plan` and `t3sm apply` again: a fresh plan sees T3 Code as it is now.
