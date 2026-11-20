# 16 — FAQ

[← 15 Release and publishing](15-release-and-publishing.md) · [Home](Home.md)

## Purpose

**Why does this exist?**
Because personal tooling for coding agents lives in five disconnected places per tool — extensions,
skills, prompts, hooks, settings — and every new machine meant rebuilding them by hand. This package
makes "my tooling" one artifact: detect → archive → (optionally) remove → deploy → verify.

**Why three agents and not a plugin per agent?**
pi, Claude Code and Codex share the same *concepts* (skills, prompts, hooks, settings) with different
file formats. One payload plus one translator per tool is smaller and more auditable than three
hand-maintained plugin trees. The concept mapping is written down in
`shared-core/agents/agnostic/source-map.json`.

**Why zero dependencies?**
It installs on machines with restricted networks, and an installer that itself needs a network to boot
is a bad installer. `npm` globals and `brew` formulas are handled *as data*, not as dependencies.

## Safety

**It deletes things from my home directory?**
Only under `--allow-destructive`, only inside the target home, never anything matching the 34
protection patterns, and only after copying the whole agent tree to an archive whose file count was
verified. Removal re-checks every path immediately before deleting it.
[Phase 3](03-phases.md) · [Protection model](08-protection-model.md).

**Can I try it without risk?**
`asbmods --dry-run` (hash-verified inert — the suite proves it), or run the real thing against a
throwaway home with `ASB_MODS_HOME=/tmp/fix/home XDG_CONFIG_HOME=/tmp/fix/xdg`.

**I removed things and want them back.**
`asbmods reset` replays the newest removal report out of the archive. Undo granularity from finest to
coarsest: `file-backups/` → `reset` → the whole `backups/<stamp>/` tree.
[Page 11](11-update-and-rollback.md).

**Will it clobber my settings?**
No. `settings.json` files are merged (arrays merged as sets for `packages`/`extensions`, your extra
keys untouched) and backed up first. `~/.codex/config.toml` is never written at all.

**Where are my API keys?**
`~/.config/asb-mods/env/secrets.env`, mode 600, outside every repository, never copied into a report,
`state.json`, an archive or this repository. The template holds names only.
[Page 09](09-secrets-and-env.md).

## Scope and limits

**Does it install Homebrew packages and npm globals for me?**
By default it reports. Add `--install-brew` / `--install-npm` to act; interactive casks
(Docker, VirtualBox, VMware, Oracle) are always deferred to you. It never uninstalls anything.

**Is Windows supported?**
No — hook execution uses `/bin/bash -lc` and shell wiring targets `.zshrc`/`.bashrc`/`.zshenv`.
On Windows use a POSIX environment, and source `<state-dir>/env/shell-env.sh` yourself in fish.

**Can I run this for a teammate's setup?**
Yes, but the payload is *personal* by policy: only artifacts the maintainer authored ship
(`personalOnly`, an explicit `personalSkills` allow-list). Fork the repo, replace `shared-core/tooling/`
with your own via `tools/vendor.js`, and keep your machine-specific term list in a gitignored
`policy.local.json`. [Page 07](07-personal-tooling-vendoring.md).

**Which parts are safe to keep hand-edited?**
Anything you want, but `state.json` and `installed-manifest.json` describe what the installer believes
it deployed. After hand edits, `asbmods status` is the arbiter — it checks live files, not beliefs.

## Usage odds and ends

**Why does `asbmods --help` run detection instead of printing help?**
Because `-h`/`--help` are not parsed — swallowed as unknown flags, leaving the command at `all`. Use
`asbmods help`. It's listed as [known gap 1](12-troubleshooting.md#known-gaps).

**Exit code was 0 but nothing happened — bug?**
Success means "ran to completion". Removal skipped, brew rows missing and npm packages unavailable all
exit 0. Read the Summary block or `--json`. [Known gap 4](12-troubleshooting.md#known-gaps).

**`--scope=required` used to hide 23 core rows — still?**
Fixed. `formulae.csv` tags rows `core|tooling|optional`, and the required filter only knew
`direct|required|tooling`, so it considered 5 rows instead of 28.
[Page 12](12-troubleshooting.md#known-gaps) records the fix and its regression test.

**Why pipe-delimited `formulae.csv`?**
Because brew's own inventory exports use `|`, so the file round-trips with the tool that produced it.
367 rows: 273 formulae, 94 casks.

**Is `--agent=pi` supposed to limit the run to pi?**
It is parsed but currently ignored — all three tools are always processed. [Known gap 2](12-troubleshooting.md#known-gaps).

**Why do two runs in a row print different things?**
Second run reports `up-to-date` instead of `registered`, and zero deploy actions where the first made
changes. Idempotence is asserted by the suite; a second run that keeps changing things is a bug worth
reporting.

## Payload questions

**Why are 4 of the 11 artifact classes empty?**
By policy, not accident: `claudePlugins` and `claudeHooks` belong to plugin managers, `claudeAgents`
candidates were all third-party/internal and excluded with reasons, `agentsPackages` had nothing
personal. The manifest's `exclusions` list is the audit trail (14 groups, 193 items).

**Why vendor code at all instead of installing from npm?**
Because those artifacts are personally authored — they exist nowhere else. Dependency-tree installs are
refused precisely so the package never pretends to ship third-party code.

**Why does `manifest.json` regenerate on every `tools/vendor.js` run?**
It is a generated inventory with `generatedAt`, not hand-authored data. Diff it: byte and file-count
movement is how payload drift becomes visible.

**Why do the wiki pages state literal counts (34, 46, 159, 222, 33)?**
Deliberately brittle. If payload or test count drifts, documentation has to change too, which is the
cheapest available defence against "the docs quietly stopped being true".

## Contributing questions

**Where do I start reading code?**
`install.js` `main()` for the sequence, then the one `lib/*.js` for the phase you care about.
`paths.js` and `fsx.js` are the only shared leaves. [Page 05](05-components-lib.md).

**Can I add a dependency to make something easier?**
Not without arguing the case; zero runtime dependencies is the property that makes this work on
restricted machines. [Page 14](14-contributing.md).

**Is this published to npm?**
Not yet — `npm view @asbmods/install version` returns `E404`. Use a clone or
`npx github:avneetsb/asb-mods#v0.1.0`. Publishing steps are on
[page 15](15-release-and-publishing.md).

**Are the releases signed?**
No. Commits carry no signature and there is no CI/npm provenance, so trust is by content — pin a tag
and diff `npm pack --dry-run` output between releases.
