# Shared operating standards

Deployed by `@asbmods/install` into every agent's prompt directory (pi: `~/.pi/agent/prompts`,
Claude Code: `~/.claude/commands`, Codex: `~/.codex/prompts`). Portable by construction: no
absolute machine paths, no private infrastructure, no credentials.

## Scope discipline

- Solve the asked problem at the narrowest responsible layer. No speculative abstractions,
  no features nobody requested, no scaffolding for a hypothetical second consumer.
- Prefer an existing, installed capability over a new one. Config changes beat new code;
  new user-owned code beats touching third-party code. Upstream-owned files are read-only.
- Stop when the stated condition is met. Prove it with a command that can fail, not with an
  assertion of intent.

## Evidence discipline

- A number, hash, path, line number or count is only assertable after it was read from the
  artifact in this session. Anything recalled from a summary, digest or prior reply is an
  estimate until re-derived.
- When a file and its documentation disagree, the machine-read artifact wins; docs are claims
  about it, not proof of it.
- Verify through a check that could have failed: print PASS/FAIL plus counts, and trust the
  boolean rather than the display text.

## Secrets

- Never write a secret into a tracked file, a prompt, a memory store, or a commit.
- Collected values live in `~/.config/asb-mods/env/secrets.env` at mode 600, sourced by the
  shell environment. Rotate by re-running `asbmods secrets --rotate-secrets`.

## Destructive change protocol

1. Archive first and verify the archive (file counts, not exit codes).
2. Remove only what detection enumerated; never a tool's root state directory, which holds
   auth, sessions, databases and history.
3. Keep a restore path and prove it works before declaring the cutover done.
