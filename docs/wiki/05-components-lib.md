# 05 — Code components

[← 04 CLI reference](04-cli-reference.md) · [Home](Home.md) · Next: [06 — shared-core reference](06-shared-core-reference.md)

~1,900 lines of dependency-free CommonJS. `install.js` is the CLI and the phase orchestrator;
`lib/*` holds one module per concern; `tools/vendor.js` is the only development-time script.

## `install.js` — entry point (bin: `asbmods`)

| Symbol | Responsibility |
| --- | --- |
| `parseArgv(argv)` | First non-flag token is the command (default `all`); flags are a flat object. Unknown flags ignored |
| `preflight()` | Node ≥ 18, git availability (tagging only), `shared-core` present (else **exit 1**), target home reported |
| `confirm(question)` | `[y/N]` reader; auto-yes on `ASB_MODS_ASSUME_YES=1` |
| `main()` | Wires the phases, collects `results`, calls `writeState()`, prints the summary |
| `writeState(patch)` | Merges into `state.json` with `updatedAt`, appending to `history` (last 40 runs kept) |
| `summarize()` / `printSummary()` | The `key: value` block at the end of every run |
| `status(flags)` | Read-only verification: 14 checks, each `[ok]`/`[warn]`, ending `N/M checks green`; `--json` supported |
| error handler | Prints `[fatal] <message>`; stack with `ASB_MODS_DEBUG=1`; exit 1 |

## `lib/paths.js` — path resolution

Single place that decides where anything lives. `PKG_ROOT = resolve(__dirname, '..')`, so
`shared-core` is found from a clone, a global install, a symlink or an npx temp dir alike.
`ASB_MODS_CORE` and `ASB_MODS_HOME` override the two things that vary per run;
`XDG_CONFIG_HOME` relocates state. Exports `HOME`, `PKG_ROOT`, `CORE`, `STATE_DIR`, `BACKUP_DIR`,
`REPORT_DIR`, `ENV_DIR`, `STATE_FILE`, `MANIFEST_FILE`, `agents.{pi,claude,codex}`, `dotfiles`.
The agent map carries `pi.agentDir` (`~/.pi/agent`) separately from `pi.dir` (`~/.pi`) because
configuration lives in the subdirectory while the archive takes the whole tree.

## `lib/fsx.js` — filesystem primitives (14 helpers)

| Helper | Contract |
| --- | --- |
| `mkdirp`, `isDir`, `isFile`, `exists`, `filesIn`, `listDirs` | Never throw on a missing path — detection has to survive absent agents |
| `readJSON(p, fallback)` / `writeJSON(p, obj, mode)` | JSON round-trip with a fallback value; writes create parents |
| `writeFile(p, text, mode)` | Text write with explicit mode (used for the 600 secrets file) |
| `copy(src, dest)` | File or directory; **follows symlinks** so vendored/link-installed skills are archived as real content |
| `rmrf(p)` | Deletion returning a boolean, which Phase 3 treats as pass/fail rather than trusting silence |
| `sha256(p)` / `hashString(s)` | Content identity: removal snapshots, backup naming, drift checks |
| `dirSize(p)` | Byte total for report entries |
| `expandTilde(p)` | `~/x` → `<HOME>/x`, honouring `ASB_MODS_HOME` — this is why a fixture home works |
| `readFileSyncSafe(p)` | Empty string instead of throwing |
| `backupString(target, contents)` | Pre-write snapshot into `file-backups/<basename>.<hash12>.<iso-ts>` |
| `parseDotEnv(text)` / `readFrom(p)` | `secrets.env` parsing, quote-tolerant |
| `resolvePlaceholders(value, vars)` | Recursive substitution of `{{HOME}}`, `{{STATE_DIR}}`, `{{CORE}}` through objects and arrays |
| `mentionsHomeDir(text, home)` | Publish-scan predicate: does this file name the author's home? |

## `lib/detect.js` — Phase 1

Exports `detectAll`, `detectPi`, `detectClaude`, `detectCodex`, `detectBrew`, `parseFormulae`,
`isProtected`. Internals: `dirs` (symlink-following), `mdFiles`, `files`, `applyProtection`,
`scanProtected`. Classification data lives in one array, `PROTECT_NAMES` — 34 regexes matched against
both the home-relative and absolute form of every candidate path. `CHILD_LIMIT = 400` bounds each
listing; `scanProtected` walks live trees capped at 2000 findings. Behavioural detail: [page 03](03-phases.md#phase-1--detect-libdetectjs),
denylist rationale: [page 08](08-protection-model.md).

## `lib/archive.js` — Phase 2

| Export | Contract |
| --- | --- |
| `stamp()` | Filesystem-safe timestamp, shared by inventory and archive names (`2026-11-20T02-41-33-507Z` form) |
| `countFiles(root)` | Recursive count; symlinks count as one (the verifier for archive completeness) |
| `archive(opts, log)` | Copies the five targets into `backups/<stamp>/`, verifies counts, tags git, writes `archive-record.json` + `state/last-archive.json`; returns `{ stamp, dest, targets, complete, incomplete, tag }` |
| `gitTag(ts, log)` | Creates `asb-backup-<stamp>` at HEAD, verifies by listing; returns `{ tagged, tag, reason? }` |
| `latestArchive()` / `listArchives()` | Newest stamp / all stamps, for `reset` and `status` |

## `lib/remove.js` — Phase 3

`removeArchived(opts, log)` returns `{ skipped?, reason?, removed[], refused[], failed[], removedCount, refusedCount, failedCount }`
and always writes `reports/removal-<stamp>.json`. Guard order: authorisation → verified archive →
per-entry `insideHome` + `isProtected` re-check → snapshot → delete. `snapshotEntry` records
`{ type, bytes, sha }` (dir / symlink target / file) so `reset` and humans can see what was lost.
Also exports `insideHome(p)` for reuse in tests.

## `lib/deploy.js` — Phase 4

Exports `deploy`, the six sub-deployers, `toolingManifestPath`, `mergeInto`, `canonicalSkills`,
`AGENT_SKILL_DIRS`, `AGENT_PROMPT_DIRS`, `VARS`.

`mergeInto(target, incoming, opts)` is the safety-critical one:

- arrays named in `arraysAsSets` (default `['packages', 'extensions']`) merge as sets keyed by
  `JSON.stringify(item)` — no duplicates, user entries untouched;
- other arrays are replaced, and the change is recorded only if the serialisation actually differed;
- nested objects recurse; scalars set only when different;
- returns the change list (`added` / `appended` / `replaced` / `created` / `set`) that appears in
  `installed-manifest.json`.

`stripNonSettingsKeys` drops documentation keys (`_`-prefixed, `purpose`, `notes`,
`installInstructions`, `_description`) so fragment annotations never leak into live config.

## `lib/hooks.js` — Phase 7

Exports `registerAll`, `registerPi`, `registerClaude`, `registerCodex`, `loadSchema`, `flatten`,
`MARK`, `piExtensionSource`. `MARK = '# asb-mods:'` is the idempotence marker appended to every
registered command (`${command}  ${MARK}${name}`), and `alreadyPresent()` is a serialised-bucket
marker search. `flatten(defs)` expands `trigger_event` (`a|b` supported) and **resolves placeholders in
the command at registration time** — skipping that step registers a literal `{{STATE_DIR}}` path,
which is a real bug this codebase has had. `writePreserving(target, mutate, label, log)` gives all
three registrations the same behaviour: read → back up once → mutate → write only if something changed.
`piExtensionSource(items)` emits a TypeScript extension whose `session_start` hooks fire on
`session_start` and the rest on `turn_end`, each at most once per process, via
`/bin/bash -lc <command>` with an 8 s timeout.

## `lib/secrets.js` — Phases 6 / 6b

`templateVars()` parses `shared-core/env/secrets.env.template` into `{ name, placeholder, hint }`
(preceding comment = hint). `collect(opts, log)` prompts (masked for
`KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL`, visible otherwise), keeps existing values unless
`rotateSecrets`, never prompts under `noInput`, writes mode 600, then re-reads the file to verify both
content and permission bits; report holds names only. `deployShellEnv(log, dryRun)` installs
`shell-env.sh` into the state dir and rewrites the marked block in `~/.zshrc`, `~/.bashrc`,
`~/.zshenv`; exports `MARK_BEGIN` / `MARK_END`.

## `lib/npmpkgs.js` — Phase 4b

`manifest()`, `installedGlobals()` (one `npm ls -g --depth=0 --json`), `resolvable(name, timeoutSec)`
(one `npm view <name> version` per missing package), and `assess(opts, log)` which combines them into
per-package rows plus `{ total, installed, available, unavailable }` and writes `reports/npm-<ts>.json`.

## `lib/brew.js` — Phase 5

`haveBrew()`, `installedSets()` (two subprocesses, 64 MB buffer cap), `plan(opts)` →
`{ brewAvailable, considered, presentCount, missingCount, deferredCount, missing[], missingRows[], deferred[] }`,
`install(opts, log)` iterating **rows** so a cask is never satisfied by a same-named formula.
`INTERACTIVE_CASKS = /^(docker|docker-desktop|virtualbox|vmware|oracle)/i` → deferred, never installed.

## `lib/restore.js` — `reset`

`removalReports()` sorts `reports/removal-*.json` newest-first; `restoreRemoved(opts, log)` resolves
each artifact inside the newest archive via three candidates (`<agent>/<rel>`, the same with a
collapsed agent segment, then `archivedTo`) and writes `reports/restore-<ts>.json`; refuses dry-run
reports. `restoreAgents(log, only)` is the whole-directory variant (library-only, not wired to a
command).

## `lib/tooling.js` — the class contract

The link between what removal deletes and what the package ships. `CLASSES` maps each artifact class
to its source directory under the agent home, its bundle root in `shared-core/tooling/`, a layout
(`dir` or `flatten`) and a destination template containing `{{HOME}}` (plus `{{NAME}}` for per-artifact
destinations). `readManifest()` loads the generated inventory; `agentRel(candidate, cls)` and
`packagedClasses()` answer "is this artifact already shipped?", which is how `tools/vendor.js` and the
test suite detect a class that is removable but not vendored — the defect that broke fresh-machine
reproduction.

## `tools/vendor.js` — development tool

Regenerates `shared-core/tooling/` + `manifest.json` from a machine that has the tooling.
Flags: `--dry-run` (report only) and `--clean` (rewrite the bundle tree, keeping gitignored
`policy.local.json`). Rules for what may ship — personal-authored only, no dependency trees, no
machine paths, no internal vocabulary — live in `shared-core/tooling/policy.json` (plus the
gitignored term list). Full reference: [page 07](07-personal-tooling-vendoring.md).

## Module dependency graph

```text
install.js
  ├── paths ──────────────┐        (no dependencies of its own)
  ├── fsx ────────────────┤        (depends on paths only)
  ├── detect → paths, fsx │
  ├── archive → paths, fsx│
  ├── remove → paths, fsx, detect(isProtected)
  ├── deploy → paths, fsx, tooling
  ├── hooks  → paths, fsx
  ├── secrets→ paths, fsx
  ├── npmpkgs→ paths, fsx
  ├── brew   → paths, fsx, detect(parseFormulae)
  └── restore→ paths, fsx, archive
tools/vendor.js → lib/tooling.js, lib/fsx.js, lib/paths.js   (development only)
```

No cycles: `paths` and `fsx` are leaves; every phase module depends on them and nothing else, except
the two deliberate reuses (`remove` re-checks `detect.isProtected`, `brew` reuses `detect.parseFormulae`).
