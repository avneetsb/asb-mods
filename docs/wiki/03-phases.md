# 03 — Phases

[← 02 Architecture](02-architecture.md) · [Home](Home.md) · Next: [04 — CLI reference](04-cli-reference.md)

`install.js` is the only entry point. `asbmods` with no arguments (or `all`) runs the phases in the
order below; each also runs standalone. Detection always runs first — every later phase consumes its
output, and `--dry-run` threads through all of them.

| # | Command | Module | Destructive? |
| --- | --- | --- | --- |
| 1 | `detect` | `lib/detect.js` | no (writes reports only) |
| 2 | `archive` | `lib/archive.js` | no (adds files + a git tag) |
| 3 | `remove` | `lib/remove.js` | **yes** — needs `--allow-destructive` |
| 4 | `install` | `lib/deploy.js` | writes into agent dirs (merges settings) |
| 4b | `npm` | `lib/npmpkgs.js` | report-only unless `--install-npm` |
| 5 | `brew` | `lib/brew.js` | report-only unless `--install-brew` |
| 6 | `env` | `lib/secrets.js` → `deployShellEnv` | edits shell rc files (marked block) |
| 6b | `secrets` | `lib/secrets.js` → `collect` | writes `secrets.env` (mode 600) |
| 7 | `hooks` | `lib/hooks.js` | edits agent config (merge) |

---

## Pre-flight

Before any pipeline phase: Node major ≥ 18; `git --version` (its absence disables archive tagging,
not archiving); `shared-core` present next to the installer — **missing it exits 1**, because there
is no meaningful partial run; target home directory reported (flagged when `ASB_MODS_HOME` overrides it).

## Phase 1 — detect (`lib/detect.js`)

Inventories each agent, classifies every finding as removable or protected, and writes the inventory
to `reports/inventory-<stamp>.json` plus `state/inventory.json`.

**pi** — `~/.pi/agent/settings.json` and `mcp-adapter.json` are read for keys; findings: loose
extensions in `~/.pi/agent/extensions` (`.ts`/`.js`), extension subdirectories, local pi packages in
`~/.agents/packages`, personal skills in `~/.agents/skills`, scripts in `~/.agents/scripts`, loose
prompts in `~/.pi/agent/prompts`, prompts shipped inside packages, registered package entries, npm
`node_modules` count, MCP server names, settings keys. Removable classes: `extension`,
`extension-dir`, `skill`, `prompt`, `local-package`, `script`.

**Claude Code** — `~/.claude/settings.json`; findings: `settings*.json` files, settings keys, hook
events, agents (**files and directories** — subagents are `~/.claude/agents/*.md`, not folders),
skills, commands, custom hook files (walked up to depth 3 under `hooks/` for `.cjs|.mjs|.js|.sh|.py`),
plugin directories, plugin registry JSON files, plugin cache (`vendor/plugin` pairs), enabled plugins.
Removable classes: `agent`, `agent-dir`, `skill`, `hook-dir`, `plugin-dir`, `plugin-registry`.

**Codex** — `~/.codex`: top-level entries, whether `config.toml` and `hooks.json` exist, hook events,
skills, prompts, custom top-level config files. Removable classes: `skill`, `prompt`, `loose-file`.
`hooks.json` is deliberately **not** queued — it is the live hook registry the installer merges into.

Two details that changed real results:

- Directory listings **follow symlinks** (`fs.statSync`, not `withFileTypes().isDirectory()`), because
  Claude Code installs many skills as symlinks; the naive check silently undercounted on the first
  live run.
- Hook units are derived from the first path segment *inside* `hooks/`. Using the raw first segment
  produced `~/.claude/hooks/hooks`, which removal then reported as "already absent".

**Protected evidence, not just counts.** `scanProtected()` walks all three agent roots plus
`~/.agents` (skipping `node_modules`, `npm`, `cache`, `.git`) and counts live-state files that
actually exist, capped at 2000 with 12 samples listed. Without it, "0 protected" would read as safe
when it only means nothing dangerous was proposed.

**The falsifiable check.** The inventory carries `protectionHole: true` if any live-state file found
on disk is equal to, or inside, something queued for removal. Non-zero means the denylist has a hole —
the claim can be wrong, which is what makes it useful.

Listings are capped at `CHILD_LIMIT = 400` entries per directory so a pathological tree can't
balloon the report.

## Phase 2 — archive (`lib/archive.js`)

Targets: `pi` → `~/.pi`, `claude` → `~/.claude`, `codex` → `~/.codex`, `agents-dir` → `~/.agents`,
`dotfiles` → `~/.zshrc`, `~/.bashrc`, `~/.zshenv` (only those three; others are never touched).

Copies into `~/.config/asb-mods/backups/<stamp>/`, counts files per target, and reports
`complete: true` only when the counts verify; anything short lands in `incomplete[]`. The record goes
to `backups/<stamp>/archive-record.json` **and** `state/last-archive.json`, which is what Phase 3
refuses to run without. Finally it tags the repo `asb-backup-<stamp>` at HEAD and verifies the tag by
listing it back — an unverified tag is reported as a warning, and reasons like "not inside a git
repository" or "tag already exists" are surfaced rather than swallowed.

`--dry-run` returns `{ dryRun: true, wouldArchive: [...] }` and creates nothing.

## Phase 3 — remove (`lib/remove.js`)

Refuses, in order, unless: (1) `--allow-destructive` was passed; (2) a **verified complete** archive
record exists for this run (`state/last-archive.json` counts). Then, per detected artifact:

1. path must resolve **inside the target home** — otherwise `refused: outside target home`;
2. the protection denylist is re-checked at deletion time (detection may be stale) — `refused: protected (live agent state)`;
3. already-gone paths are recorded as `refused: already absent` rather than silently dropped;
4. otherwise the entry is snapshotted (type, byte size, first 16 hex chars of sha256, or symlink
   target), deleted, and recorded with `archivedTo` pointing into the archive.

Everything is written to `reports/removal-<stamp>.json` with `removed[]`, `refused[]`, `failed[]` and
the archive stamp — the input to `reset`. Under `--dry-run` the same report shape is produced with
`dryRun: true` on each entry and no deletions.

`install.js` puts the human gate in front of this: it prints how many artifacts will be deleted,
states that live agent state is never touched, and asks `[y/N]` unless `--yes`.

## Phase 4 — install (`lib/deploy.js`)

Six sub-steps, in this order, each returning actions recorded in `installed-manifest.json`:

| Sub-step | What it does |
| --- | --- |
| `deploySkills` | every `shared-core/skills/canonical/*/SKILL.md` → all three skill roots; content-identical files are recorded `unchanged` (idempotence), changed ones `updated` |
| `deployPrompts` | `shared-core/prompts/master/*.md` → pi prompts, Claude commands, Codex prompts |
| `deployHookBin` | `shared-core/hooks/bin/*.sh` → `~/.config/asb-mods/hooks/`, chmod 755 — the registered hook commands point here, so skipping this creates dangling commands |
| `deploySettings` | merges each tool's `settings-fragment.json` into the live settings file; documentation keys (`_`-prefixed, `purpose`, `notes`, …) are stripped first; `packages`/`extensions` arrays merge as sets (dedup by JSON identity); **Codex `config.toml` is recorded as `preserved`, never rewritten** |
| `deployAgnostic` | `shared-core/agents/agnostic/*.json` staged into `~/.config/asb-mods/agnostic/` |
| `deployTooling` | every bundle in `shared-core/tooling/manifest.json` restored to its destination (7 classes, `{{NAME}}` substitution, `dir` and `flatten` layouts) — see [page 07](07-personal-tooling-vendoring.md) |

Any file this phase rewrites is first copied to `file-backups/<basename>.<hash12>.<iso-ts>`, so a
single config can be restored without touching the rest.

## Phase 4b — npm globals (`lib/npmpkgs.js`)

Reads `shared-core/npm/manifest.json` (14 packages), compares against `npm ls -g --depth=0 --json`,
and — for anything missing — probes registry resolvability with `npm view <name> version` (20 s
default). Per package the action is `already-installed`, `skipped-unavailable` (with the npm error,
first line), `install` (only with `--install-npm`) or `report-only`. A package that lives only on a
private registry is **surfaced as unavailable**, not silently skipped. Always writes
`reports/npm-<ts>.json`.

## Phase 5 — brew (`lib/brew.js`)

Driven entirely by `shared-core/brew/formulae.csv` — 367 rows, columns
`name|type|version|dependency-type|used-by`. Installed state comes from exactly two subprocesses
(`brew list --formula -1`, `brew list --cask -1`), not one per row.

- `--scope=required` restricts to rows whose `dependency-type` is `core` or `tooling` (28 of 367 rows;
  `direct` and `required` are accepted as aliases for older inventories); the default `all` considers
  every row.
- Formula and cask membership are checked in their own sets, and installation iterates **rows**, not
  names — a name that exists as both (the inventory lists `1password` twice) must not have its cask
  row silently satisfied by a same-named formula.
- `docker`, `docker-desktop`, `virtualbox`, `vmware*`, `oracle*` casks are **deferred**, never
  installed automatically: they need interactive entitlements.
- `--limit=N` caps installs in one run; each `brew install` has a 600 s default timeout, and the
  last line of stderr is captured per failure. Report: `reports/brew-<ts>.json`.
- No Homebrew on PATH → the gap is reported, not pretended away.

## Phase 6 — env (`deployShellEnv`)

Copies `shared-core/env/shell-env.sh` to `~/.config/asb-mods/env/shell-env.sh`, then wires a marked
block into `~/.zshrc`, `~/.bashrc`, `~/.zshenv` when they exist:

```sh
# >>> asb-mods shared environment >>>
[ -f "$HOME/.config/asb-mods/env/shell-env.sh" ] && source "$HOME/.config/asb-mods/env/shell-env.sh"
# <<< asb-mods shared environment <<<
```

Between the two marker lines the block is rewritten in place on later runs, so it stays idempotent
and never accumulates duplicates; each rc file is backed up before the first edit. Only the three
known rc files are candidates — your other shell files are not discovered or edited.

## Phase 6b — secrets (`collect`)

Parses `shared-core/env/secrets.env.template` (comment lines become the prompt's hint). Names
matching `KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL` are prompted through a masked reader
(raw-mode TTY, `*` echoed); plain values (`*_BASE_URL`) are prompted visibly. Existing values are
kept unless `--rotate-secrets`; `--no-input` never prompts and leaves what is there untouched.

Writes `~/.config/asb-mods/env/secrets.env` with mode 600 (`writeFile` mode plus an explicit
`chmodSync`), then **verifies** by reading the file and its permission bits back. The report
(`reports/secrets-<ts>.json`) records variable *names* only — values are never logged.

## Phase 7 — hooks (`lib/hooks.js`)

Reads `shared-core/hooks/hooks.json` (4 definitions, each with `tool_adapters` for the tools it
applies to), resolves `{{HOME}}`/`{{STATE_DIR}}`/`{{CORE}}` in every command **before** registration,
and registers:

- **pi** — generates `~/.pi/agent/extensions/asb-mods-hooks.ts`. pi has no shell-hook file; an
  extension *is* its hook mechanism. Gated on `~/.pi/agent` existing (not on `extensions/`, which a
  cutover legitimately deletes — that ordering bug once skipped pi in exactly the run that needed it).
- **Claude Code** — merges into the `hooks` map in `~/.claude/settings.json`.
- **Codex** — merges into `~/.codex/hooks.json`, creating it if absent.

Idempotence is by marker: each appended command ends with `# asb-mods:<hook-name>`, and a bucket that
already contains that marker is left alone. Entries are `unshift`ed so the shared hooks run before
foreign ones, and each target file is backed up before its first change. Skips are explicit: pi
agent dir absent, Claude dir absent, or no applicable adapter in the schema. Report:
`reports/hooks-<ts>.json`. [Details →](10-hooks-reference.md)

## `status` — verification, not restatement

Reports each of these with a green/warning mark and a final `N/M checks green`: package root,
`shared-core`, `state.json`, `installed-manifest.json`, archives present, last archive tag verified,
`secrets.env` (variable count + mode is exactly `600`), `shell-env.sh` deployed, rc files wired
(by marker presence), canonical skill counts per agent (`have/needed`), pi hook extension file,
Claude and Codex hook registration (marker found in the live config). `status --json` emits
`{ lines, state, archives }`.

## `reset` — replay a removal report

Picks the newest `reports/removal-*.json` (or `--report=<name>`), refuses reports whose run was a dry
run, and for each removed artifact tries three candidate locations in the newest archive —
`<stamp>/<agent>/<rel>`, the same with the leading agent segment collapsed, and the recorded
`archivedTo` — then copies it back. Missing sources are reported per entry, and the outcome is written
to `reports/restore-<ts>.json`. There is also a whole-directory restore (`restoreAgents`) in the
library, used by hand rather than wired to a command; see
[11 — Updating and rollback](11-update-and-rollback.md).
