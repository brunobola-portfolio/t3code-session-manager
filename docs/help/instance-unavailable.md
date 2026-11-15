# Account off: the conversation's account is not usable in T3 Code

## What it means

The conversation belongs to an account (or an agent such as Codex or Pi) whose instance in T3 Code is signed out,
disabled or missing, so T3 Code cannot import it.

## Why it happens

- The account's sign-in expired in T3 Code.
- The instance, or the agent, is turned off in T3 Code's settings (Providers).
- The account has no instance in T3 Code yet.

## What to do

1. `t3sm accounts` shows every account, its instance and whether it is signed in.
2. Sign in from T3 Code, or turn the agent on in its settings (Providers). A missing instance: `t3sm accounts --apply`.
3. Then run `t3sm apply` again.
