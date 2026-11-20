# pi adapter

`asbmods install` drops the shared standards file into `~/.pi/agent/prompts/`, where pi loads it
as a prompt alongside the user's own. Per-tool extras for pi live in its own settings, merged by
the installer (`~/.pi/agent/settings.json`) and registered as hooks through the generated
extension `~/.pi/agent/extensions/asb-mods-hooks.ts`.

Skills are published to `~/.agents/skills/<name>/SKILL.md`, which pi scans natively.
