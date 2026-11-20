# Codex adapter

`asbmods install` writes the shared standards file into `~/.codex/prompts/`.

`~/.codex/config.toml` is never rewritten — it holds live model and auth state. Codex receives the
shared hooks through `~/.codex/hooks.json`, merged by `lib/hooks.js` with foreign entries preserved.
Skills are published to `~/.codex/skills/<name>/SKILL.md`.
