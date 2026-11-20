# Prompts: where they live and how they stay in sync

Prompts are consolidated as **one canonical copy plus per-agent placement**, not three drifting
copies. The installer owns placement; you only ever edit the canonical file.

## Layout

| Path | Role |
| --- | --- |
| `shared-core/prompts/master/` | Canonical prompt files. Everything in `*.md` here is deployed. |
| `shared-core/prompts/adapters/` | Per-agent notes on where the canonical file lands and what each tool adds. Documentation only — not deployed. |

## Where each agent gets its prompts

Deployed by `deployPrompts()` in `lib/deploy.js`, which copies every `shared-core/prompts/master/*.md`:

| Agent | Destination |
| --- | --- |
| pi | `~/.pi/agent/prompts/` |
| Claude Code | `~/.claude/commands/` |
| Codex | `~/.codex/prompts/` |

Destination directories are created if missing. Files are copied, never symlinked, so removing the
repo cannot leave an agent pointing at a vanished path.

## Changing a prompt

1. Edit the file under `shared-core/prompts/master/`.
2. Re-run `asbmods install` (or `npx @asbmods/install install`). The same content lands in all
   three agents, and `~/.config/asb-mods/installed-manifest.json` records what was written.
3. `asbmods status` reports per-agent counts so drift is visible rather than assumed.

## What deliberately does not live here

- **Machine-specific instruction files.** A personal `AGENTS.md` / `CLAUDE.md` names local paths,
  hosts and services. Those are archived by the cutover into
  `~/.config/asb-mods/backups/<stamp>/` and are otherwise left alone — publishing them in a
  portable package would leak one machine's layout onto every other install.
- **Secrets and gateway URLs.** See `shared-core/env/secrets.env.template`; collected values go to
  `~/.config/asb-mods/env/secrets.env` at mode 600 and reach agents through the shell environment.
