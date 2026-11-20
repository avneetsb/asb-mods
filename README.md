# @asbmods/install

One self-contained npm package that consolidates personal tooling — plugins, packages, skills,
hooks, prompts, scripts, env config and the Homebrew inventory — across **three** agents:
**pi**, **Claude Code** and **Codex**. Detection, prompting, installation and registration all
live inside the package: nothing on the target machine is required except Node 18+ (and Homebrew,
if you want the brew phase to install rather than plan).

Everything else is documented in the **[wiki](docs/wiki/Home.md)**: architecture, each installer
phase, the CLI reference, every `shared-core` data file, the vendoring policy, the protection
model, secrets handling, hooks, updates and rollbacks, testing, contributing and troubleshooting.

## Install

There are **no runtime dependencies** and nothing to build, so the checkout *is* the
installer. (`@asbmods/install` is not published to the public registry yet —
`npm view @asbmods/install` returns 404 — so the two supported routes are a checkout or
a git URL. `npx @asbmods/install` will start working the day it is published.)

### 1. From a checkout (recommended — you keep the archive tags locally)

```bash
git clone git@github.com:avneetsb/asb-mods.git          # SSH, personal key → avneetsb
# or: git clone https://github.com/avneetsb/asb-mods.git  # no key needed, public repo
cd asb-mods

node install.js --dry-run        # run it straight from the clone: no npm install needed
```

Put the `asbmods` command on your PATH either way:

```bash
npm install -g .                 # snapshot the checkout into the npm global prefix
                                 # → $(npm prefix -g)/bin/asbmods  (~/.local/bin/asbmods,
                                 #    which shell-env.sh already puts on PATH)
npm link                         # …or a symlink back to this checkout, so edits to the
                                 #    working tree take effect without reinstalling
asbmods --dry-run
```

Do **not** do both: `npm link` and `npm install -g .` write the same bin, so the last one
wins. Check what is live with `command -v asbmods` and `readlink -f "$(command -v asbmods)"`.

### 2. From GitHub, no checkout (npx)

```bash
npx github:avneetsb/asb-mods --dry-run
npx github:avneetsb/asb-mods                       # detect -> archive -> install -> env/secrets -> hooks (removal needs --allow-destructive)
npx "git+https://github.com/avneetsb/asb-mods.git" --dry-run   # HTTPS variant, no SSH key
npx github:avneetsb/asb-mods#<commit-sha> --dry-run            # pin a specific commit
```

`github:` resolves to `git+ssh`, so it uses your SSH key; the `git+https` form needs none.
Both were verified against this repo (`npm view git+ssh://git@github.com/avneetsb/asb-mods.git`
→ `@asbmods/install 0.1.0`).

### First run, in order

```bash
asbmods --dry-run                # phase plan: check "removable: N" and "protected: M"
asbmods status                   # detection detail + what is already deployed and verified
asbmods --allow-destructive      # archive → remove → install → env/secrets → hooks
                                 # (add --yes for non-interactive; removal refuses without the flag)
exec zsh                         # …or open a new shell: env + secrets arrive from shell-env.sh
asbmods status                   # verify: hook registrations, deployed prompts, skill counts
```

Restart pi / Claude Code / Codex after the hooks phase — each tool reads its config at start-up.
Paths resolve relative to the installed package, so a git clone, `npm i -g`, `npm link` and an
npx temp dir all behave identically. There is no hardcoded checkout location.

## Phases

`install.js` is the only entry point. `asbmods` (no arguments, or `all`) runs them in order:

| # | Phase | What it does |
| --- | --- | --- |
| 1 | **detect** | Inventories `~/.pi`, `~/.claude`, `~/.codex` plus `~/.agents` and the shell rc files; classifies each artifact removable vs protected; writes a JSON inventory |
| 2 | **archive** | Copies each agent directory, `~/.agents` and the rc files to `~/.config/asb-mods/backups/<stamp>/`, **verifies** the file counts, then tags the package repo `asb-backup-<stamp>` |
| 3 | **remove** | Deletes exactly the artifacts detection listed. Requires `--allow-destructive` plus confirmation, and refuses to run before a verified archive exists |
| 4 | **install** | Deploys shared-core: canonical skills, prompts, hook scripts, agnostic defaults; merges per-tool settings fragments without touching keys it does not own |
| 4b | **npm** | Reports the `shared-core/npm/manifest.json` packages; installs with `--install-npm` |
| 5 | **brew** | Plans against `shared-core/brew/formulae.csv` (367 rows: 273 formulae, 94 casks); installs with `--install-brew`, optionally `--limit=N` |
| 6 | **env** | Deploys `shell-env.sh` to the state dir and wires a marked, idempotent source block into existing rc files |
| 6b | **secrets** | Prompts per variable from `shared-core/env/secrets.env.template` (masked for key/token/secret names), writes `secrets.env` at mode 600 |
| 7 | **hooks** | Registers the shared hook definitions with all three tools: a generated pi extension, `~/.claude/settings.json` hooks, and `~/.codex/hooks.json` |

Each phase also runs standalone: `asbmods detect|archive|remove|install|npm|brew|env|secrets|hooks`,
plus `status` (what is deployed, verified) and `reset` (restore what removal took).

### Flags

`--dry-run` · `--yes` · `--allow-destructive` · `--no-input` (CI) · `--scope=required|all` ·
`--install-brew` · `--limit=N` · `--install-npm` · `--probe=false` · `--rotate-secrets` ·
`--json` · `--agent=pi,claude,codex` · `--report=<name>`

Environment overrides: `ASB_MODS_HOME` (target home) and `ASB_MODS_CORE` (source of truth), which
the functional test suite uses to run the whole destructive flow against a throwaway home.

## What removal never touches

Detection proposes, the denylist vetoes. Live agent state is excluded by name pattern and
re-checked at deletion time, and any path outside the target home is refused: credentials and
`auth.json`, `settings*.json`, `config.toml`, `mcp*.json`, `*.sqlite*`, session/history stores,
caches, locks and logs. The full directory is archived first anyway, so the sweep is reversible
even for something the denylist did not anticipate. `status` and the inventory report make this
auditable: the scan counts live-state files actually present, so "0 protected" can never pass as
silently safe.

## Self-containment rules the tests enforce

`npm test` runs the functional suite (`test/install.test.js`), which builds a fixture home, copies
the package elsewhere and executes the phases for real. Among its assertions:

- packaged data contains **no** absolute home paths, no corporate registry or gateway endpoints,
  and no credential values — captured config was reduced to a machine-independent subset;
  secrets are collected at install time instead of shipped;
- no unresolved `{{HOME}}` / `{{STATE_DIR}}` / `{{CORE}}` token reaches a live config file;
- every directory the docs mention exists, and every migration entry has a backing file;
- `--dry-run` provably mutates nothing and creates no archive or manifest;
- the destructive phase removes custom tooling from all three agents while every protected path
  survives, including a user key injected into pi's settings for the occasion;
- hook registration is idempotent and preserves foreign entries already in each tool's config;
- the deployed hook scripts execute and exit 0, and `reset` restores a file removal took away.


## Packaged tooling

A fresh machine must not need this one. Everything the destructive phase can remove is vendored
into `shared-core/tooling/` and redeployed by the installer, so phases 2–4 work without a second
machine or a private dotfiles repo.

| Agent | What ships | Restored to |
| --- | --- | --- |
| pi | loose extensions, extension directories, local pi packages, personal skills, scripts | `~/.pi/agent/extensions`, `~/.agents/packages`, `~/.agents/skills`, `~/.agents/scripts` |
| Claude Code | personal-authored skills | `~/.claude/skills` |
| Codex | personal skills, loose prompt files (`AGENTS.md`) | `~/.codex/skills`, `~/.codex` |

The inventory is `shared-core/tooling/manifest.json`. Regenerate it after changing tooling on a
machine that has the tooling:

```bash
node tools/vendor.js            # report only: what would ship, what is excluded and why
node tools/vendor.js --clean    # rewrite shared-core/tooling/ and the manifest
```

`shared-core/tooling/policy.json` decides scope, and the manifest records every exclusion with a
reason. The rules, because bulk-copying state into a published package leaks it:

- **Personal-authored only.** A skill or loose file has to be named in `personalSkills` /
  `personalCodexFiles`. Anything else is third-party or employer content and is reinstalled from
  its upstream (npm package, marketplace) rather than redistributed here.
- **No machine paths, no internal vocabulary.** Any file containing an absolute user-home path or a term
  from the deny-list excludes its whole bundle; an offending *documentation or test* file is only
  dropped from it. The employer term list lives in gitignored `policy.local.json` — the mechanism
  ships, the vocabulary does not.
- **No dependency trees.** `node_modules`, `dist`, caches, logs and scratch never ship; npm
  globals plus `shared-core/brew/formulae.csv` cover that ground.

What the policy refuses to publish is **still archived and still restorable on this machine**:
removal archives first, and `asbmods reset` reads the archive, not the bundle.
## Layout

```text
install.js                  single entry point (bin: asbmods)
lib/                        phase implementations: detect, archive, remove, deploy, brew,
                            secrets, hooks, npmpkgs, restore, paths, tooling, fsx
shared-core/
  agents/agnostic/          defaults.json, keybindings.json, source-map.json
  agents/tool-specific/     pi/, claude/, codex/ settings fragments
  brew/                     formulae.csv (367 rows), deps.json
  config/                   settings-schema.json, agent-overrides.json, agent-overrides/,
                            migrations.json, migrations/
  env/                      shell-env.sh, secrets.env.template
  hooks/                    hooks.json (4 definitions x 3 tools), bin/ hook scripts
  npm/                      manifest.json (14 packages), .npmrc (public registry only)
  prompts/master/           canonical prompt files, deployed to every agent
  prompts/adapters/         per-agent placement notes (documentation)
  tooling/                    vendored personal tooling: policy.json sets scope, manifest.json is the inventory
  skills/canonical/         caveman, gitnexus, paseo, ponytail
test/install.test.js        functional suite (fixture home, all phases executed)
tools/vendor.js               regenerates shared-core/tooling/ from a machine that has the tooling
DEPENDENCY-MAP.json         cross-agent dependency map used for reporting
```

State lives in `~/.config/asb-mods/`: `backups/<stamp>/`, `reports/`, `env/`, `hooks/`,
`state.json`, `installed-manifest.json`.

## Updates

Re-running the installer is the update mechanism — the deploy phase is idempotent, so a second
run reports "already in place" instead of duplicating hooks or prompts (the suite asserts this).

```bash
cd ~/Dev/asb-mods
git pull --ff-only                       # main
npm test                                 # 32 functional + structural checks, fixture homes only
asbmods --dry-run                        # what the new version would change
asbmods install                          # redeploy shared-core (no removal needed for an update)
```

How your install method affects updating:

| installed as | to update |
| --- | --- |
| `node install.js` from the clone | just `git pull` — you are already running the new code |
| `npm link` | just `git pull` — the symlink points at the checkout |
| `npm install -g .` | `git pull` **then** `npm install -g .` again (the global copy is a snapshot) |
| `npx github:avneetsb/asb-mods` | nothing to do — npx re-fetches; add `#<sha>` or a tag to pin |

Migrations are the upgrade path for existing machines: a new release adds an entry to
`shared-core/config/migrations.json`, and the next run rewrites settings it owns to the new
shape, leaving keys it does not own alone. Deploy state is recorded in
`~/.config/asb-mods/state.json` and `installed-manifest.json`, which is what `asbmods status`
verifies against.

## Rollback

Three levels, widest first. Everything below reads state that already exists on the machine —
no network, no package reinstall required.

**1. Undo the whole cutover (what removal deleted, back in place)**

```bash
asbmods reset                            # replays the newest reports/removal-*.json
asbmods reset --report=removal-<ts>.json # a specific run  (names: ls ~/.config/asb-mods/reports)
```

`reset` reads the removal report, locates each path in the newest archive and copies it back.
It applies immediately (there is no dry-run mode for it) and refuses reports that recorded a
dry run, because nothing was removed in those.

**2. Undo one rewritten config or rc file**

Every file the installer rewrites is copied first to
`~/.config/asb-mods/file-backups/<basename>.<hash12>.<iso-timestamp>`. Restore the newest:

```bash
ls -t ~/.config/asb-mods/file-backups | head
cp ~/.config/asb-mods/file-backups/settings.json.<hash>.<ts> ~/.claude/settings.json
```

**3. Restore a whole agent directory from the verified archive**

Each run archives `pi`, `claude`, `codex`, `~/.agents` and the rc files to
`~/.config/asb-mods/backups/<stamp>/`, with per-target file counts in `archive-record.json`
(the phase reports `complete: true` only when those counts verify):

```bash
ls ~/.config/asb-mods/backups                       # stamps, newest last
cp -R ~/.config/asb-mods/backups/<stamp>/claude ~/.claude
```

**Rolling back the consolidated content itself.** Every archive also tags this repo
`asb-backup-<stamp>` at HEAD (creation is verified by listing the tag), so the shared-core that
was deployed at that moment is addressable:

```bash
git tag -l 'asb-backup-*'
git checkout asb-backup-<stamp> -- shared-core && asbmods install
```

Those tags are local unless you push them (`git push origin --tags`).

**What rollback does not undo:** `--install-brew` and `--install-npm` install real packages and
are never reversed automatically (uninstall by hand if you must: `brew uninstall`,
`npm rm -g`); `secrets.env` stays at `~/.config/asb-mods/env/secrets.env` mode 600 — rotate or
delete it yourself; and `~/.claude/plugins/marketplace.json`, which the cutover removes, is not
rebuilt — plugin installs recorded there must be re-added inside Claude Code (the archived copy
under `backups/<stamp>/claude/plugins/marketplace.json`) keeps the original for diffing).
