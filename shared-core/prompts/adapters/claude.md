# Claude Code adapter

`asbmods install` writes the shared standards file into `~/.claude/commands/`, which Claude Code
exposes as a slash command. Settings are merged into `~/.claude/settings.json` — the installer
preserves every key it does not own and hooks are appended, tagged `# asb-mods:` so a later run
recognises its own entries instead of duplicating them.

Skills are published to `~/.claude/skills/<name>/SKILL.md`. Credentials and gateway URLs are never
written here: they come from `~/.config/asb-mods/env/secrets.env` via the shell environment.
