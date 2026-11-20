# @asbmods/install

One self-contained npm package that consolidates personal tooling — plugins, packages, skills,
hooks, prompts, scripts, env config and the Homebrew inventory — across **three** agents:
**pi**, **Claude Code** and **Codex**. Detection, prompting, installation and registration all
live inside the package: nothing on the target machine is required except Node 18+ (and Homebrew,
if you want the brew phase to install rather than plan).

Cursor is no longer supported; the Cursor adapters, skills and migration that used to ship here
were removed along with the tool itself.

## Install

```bash
npx @asbmods/install            # full cutover, prompting as it goes
npx @asbmods/install --dry-run  # report every phase, change nothing
```

or globally:

```bash
npm i -g @asbmods/install && asbmods --help
```

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

## Layout

```text
install.js                  single entry point (bin: asbmods)
lib/                        phase implementations: detect, archive, remove, deploy, brew,
                            secrets, hooks, npmpkgs, restore, paths, fsx
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
  skills/canonical/         caveman, gitnexus, paseo, ponytail
test/install.test.js        functional suite (fixture home, all phases executed)
DEPENDENCY-MAP.json         cross-agent dependency map used for reporting
```

State lives in `~/.config/asb-mods/`: `backups/<stamp>/`, `reports/`, `env/`, `hooks/`,
`state.json`, `installed-manifest.json`.

## Rollback

```bash
asbmods reset                 # restore exactly what the removal report recorded
asbmods status                # archives, tag, registered hooks, per-agent skill counts
```

The archive is addressable by git tag (`asb-backup-<stamp>`), and the full agent directories are in
`~/.config/asb-mods/backups/<stamp>/` if a settings merge needs unwinding.
