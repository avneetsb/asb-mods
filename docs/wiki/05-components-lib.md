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

## The verification envelope — `lib/report.js` (slice `O2`, finding F10)

Before this module, `--json` meant three different things: `doctor` dumped its raw probe rows, `status`
printed `{lines, state, archives}`, `verify-core` built a good object inline, and the mutating verbs printed
nothing machine-readable at all. Finding F10 called that out: anything consuming asb-mods had to know which
verb spoke which dialect. Now one module builds one shape, and the block below is **compared against the
real CLI by a test** (`O2: the envelope schema in wiki 05 is the schema the code emits`) — a documented
contract nobody compares against is a rumour.

```json envelope
{ "verb": "doctor",
  "ok": false,
  "checks": [ { "name": "Homebrew", "verdict": "fail", "detail": "not on PATH", "fix": "asbmods --install-prereqs" } ],
  "summary": { "checks": 8, "passed": 7, "failed": 1 },
  "exitCode": 1 }
```

| Field | Meaning |
| --- | --- |
| `verb` | The command that produced it, exactly as typed (`doctor`, `status`, `verify-core`, or the phase-running command such as `all`) |
| `ok` | **Exactly one thing:** zero checks whose `verdict` is not `pass`. Not a health score, not a severity judgement |
| `checks[]` | `{name, verdict, detail, fix}` — `verdict` ∈ `pass` \| `fail` \| `warn` \| `skipped` (the reporter throws on anything else, so a consumer can switch on it); `fix` is the command that resolves the row or `""`, never an absent key |
| `summary` | `{checks, passed, failed}` from the reporter, plus whatever the verb adds (`missing`, `green`/`total`, phase tallies) |
| `exitCode` | The code the process exits with. It follows `ok` by construction, which is why no page has to explain the exit code in prose |

Verb-specific extras are merged at the **top level** rather than nested (`core` and `inventory` on
`verify-core`, `state`/`archives`/`lines` on `status`, `catalogError` on `doctor`) so consumers written
against 0.3.x keep working. `hosts` — §8's per-host `{discovered, applied, held_back, failed, unverified}` —
appears only for a verb that actually has the data; it is omitted rather than zero-filled, because a zero
reads as "looked and found nothing" while an absence reads as the truth: "this verb did not look".

| Symbol | Contract |
| --- | --- |
| `check(name, verdict, detail, fix)` | Builds one row; **throws** on a verdict outside the four |
| `envelope({verb, checks, summary, hosts, extra})` | Computes `ok` and `exitCode` from the checks — a caller cannot pass its own opinion of either |
| `fromRow(row)` / `fromLine(line)` | Adapts `prereqs.probe()` rows and `status`'s `[label, detail, ok]` triples |
| `hostCounters({discovered, applied, heldBack, failed, unverified})` | Maps to the wire spelling (`held_back` with an underscore) |
| `emit(flags, env, prose, opts)` | On `--json`: a check verb prints **only** the object (prose suppressed by the caller, not appended after); a mutating verb passes `{trailer: true}` and prints the object *after* its progress output, because silencing an install to feed a parser would hide what the run is doing while it does it |

The §12 trim kept this small on purpose: no nonce, no run id, no stale-report anti-forgery. That machinery
answers a threat this package does not face — caliper's checker executes untrusted third-party tests, ours
run in our own fixture homes — and carrying it would have cost a write per run for no change in what a
reader can conclude.

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

## `lib/prereqs.js` — Phase 0 probe, plan and installer

Answers "can this machine host the package?" and, only when asked, fixes what it finds missing.

| Export | Purpose |
| --- | --- |
| `probe()` | Reads the toolchain and returns `{ ok, rows }`. Rows: node (major ≥ `NODE_MIN_MAJOR`), npm, git, Xcode CLT, Homebrew, then one per agent CLI from the catalogue. Each failing row carries its own `fix` string |
| `doctor(flags, log)` | Prints the table and returns the verdict; `flags.json` additionally dumps the raw rows. Never writes anything |
| `installPrereqs(flags, log, confirm)` | Builds the ordered plan (Homebrew → Node → npm/git → CLT), announces every command, then runs it after consent. Returns `{ planned }` under `--dry-run`, `{ refused }` (handled as exit 2) when consent is impossible, `{ declined }` on a "no", and `{ attempted, installed, remaining }` after a real run |
| `findOnPath(name)` | PATH lookup, absolute paths resolved through `X_OK`. Everything that asks "is it usable?" goes through this, so on-PATH means the same thing in every module |
| `brewBin()` | Also looks in `/opt/homebrew/bin` and `/usr/local/bin`, because after Homebrew installs itself the current shell has not exported it yet. `adoptBrewPath()` prepends that directory to `process.env.PATH` so a single run can install Homebrew and then use it |
| `cltStatus()` | `xcode-select -p`, with the fix (`xcode-select --install`) that no script can complete unattended |
| `agentCatalog()` | Reads `shared-core/npm/agents.json`; a missing or malformed file becomes an extra failing row rather than a crash |

Homebrew is judged **on PATH** by `probe()`, so an installation no shell profile exports shows up as a
gap with `eval "$(<prefix>/bin/brew shellenv)"` as its fix. The distinction matters because
`lib/brew.js` calls `brew` by name: a tool that cannot be invoked must not be reported as ready.

## `lib/agents.js` — installing the agent CLIs

Reads the route catalogue from `lib/prereqs.agentCatalog()` and offers install paths for tools this
package configures but never ships.

| Export | Purpose |
| --- | --- |
| `assess(opts, log)` | Per tool: `{ tool, bin, installedAt, probeCommand, routes }`. An installed tool is marked without probing, so an offline machine still reports its own working tools as present |
| `probeRoute(route, opts)` | brew routes require `brew` on PATH and ask `brew info`; npm routes ask `npm view` unless `opts.probe === false`; `native` is reported as unprobed because no availability check exists for a vendor installer script |
| `install(opts, log)` | Runs the first resolvable route for each absent tool after announcing it, then writes `<state>/reports/agents-<stamp>.json` and returns `{ rows, summary, installed, skipped, failed }` |
| `brewInfo(kind, name)` | `brew info --json <kind> <name>` — availability and version without installing |

`summary` counts `{ tools, present, absent, installable, unresolvable }`; the summary block at the end
of a run carries the same numbers plus `installed` and `failed`. A failed install is what makes
`--strict` exit 3 — the phase itself still exits 0, on the rule that a run which finished honestly is
not a crash.

## `lib/ledger.js` — the install ledger (`uninstall`)

What the installer put on the *machine*, as opposed to the files it copied into agent directories.
Every install path records what it actually installed: `brew.js` (formulae and casks, with the row
type so a cask is removed with `--cask`), `npmpkgs.js` (npm globals), `prereqs.js` (whatever
`brew install …` step it ran) and `agents.js` (agent CLIs, via `routeEntry()`, tagged with the tool
they belong to).

| Export | Contract |
| --- | --- |
| `record(entries)` | Appends to `state/install-ledger.json`, deduped by `manager:name`, so a re-install refreshes one row instead of adding a second removable entry. Runtime prerequisites (`node`, `npm`, `git`, Homebrew) are stored with `reversible: false` on the way in |
| `read()` | Never throws: a missing or corrupt ledger reads as empty |
| `plan(opts)` | Read-only. Asks each manager whether the name is still present, then groups rows into `removable` / `heldBack` (with the reason and the flag that unlocks it) / `alreadyGone`. Never runs a removal |
| `remove(opts, log)` | Runs the removal command for each planned row and *verifies* it by re-querying the manager: exit 0 with the name still listed is a failure, not a success. Writes `reports/uninstall-<ts>.json` and stamps `removedAt` on the row |
| `rebuildFromReports(log)` | Materialises the ledger from the `reports/{brew,npm,agents}-*.json` a pre-0.3.1 installer already wrote, so an existing machine is not stuck with an empty one |
| `routeEntry(route, agent)` | Turns an `agents.json` route into a ledger entry — the single place that maps `npm-global`/`brew-formula`/`brew-cask` onto a manager and a kind |

Two limits worth knowing. A manager that is *itself* missing reports `unknown`, never "not installed":
otherwise removing Homebrew first would silently reclassify every brew row as already-gone. And a
`native` route (a vendor `curl | bash`) is recorded but never planned, because there is no inverse
command the package could state honestly — the row says so and points at the vendor's own docs.
The ledger stores managers and names, never absolute paths, so it survives another user, another
Homebrew prefix or a moved Node.
## `lib/state-lock.js` — one mutating run at a time

| Symbol | Contract |
| --- | --- |
| `acquire({dir, verb, dryRun, force})` | Exclusive create (`fs.open(p, 'wx')`) of `<dir>/install.lock` holding `{pid, verb, startedAt, host}`. Returns `{acquired, tookStale, release}` — or `{acquired: false, held, alive}` when a **live** pid owns it |
| `holderAlive(pid)` | `kill(pid, 0)`. `EPERM` counts as alive (the pid exists, someone else owns it); non-integer, `≤ 0` and fractional pids are never alive |
| `release(lockPath, pid)` | Deletes only a record that still names *your* pid, so a lock another run already took over cannot be deleted by you |
| `describe(holder)` / `takeoverCommand(verb)` | The refusal text and the exact takeover line, so the printed instruction and the flag that implements it cannot drift apart |

Three decisions carry §5 row 32 and finding F8, and each is observable rather than promised:

* **Staleness is pid liveness, never age.** A lock two days old whose process exists is a refusal; one written
  a second ago whose pid is gone is a takeover. Age-based expiry would reopen the interleaving window every
  time an install legitimately runs long — a 367-row brew plan outlives any fixed timeout you would pick.
* **A takeover is always announced.** `tookStale` becomes a `[warn]` naming what it replaced and why, so the
  escape hatch cannot quietly become the normal path.
* **Read-only verbs and `--dry-run` never take the lock.** That is what makes the accepted failure mode — "a
  crashed or hung run keeps later runs out" — survivable: `status`, `doctor`, `detect` and every plan still
  run beside a live install, which is how you find out what it is doing.

`install.js` calls `takeLockOrRefuse(command, flags)` at the three places that write: before the phase
pipeline, inside `reset`, and immediately before `uninstall`'s removal (its planning branch stays
lock-free). A refusal exits **1** having changed nothing — no archive stamp, no report file, holder record
untouched. The module is a leaf: it needs only `fs`, `path` and `os`, so the lock can be taken on a machine
where nothing else in the package works yet.

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
  ├── npmpkgs→ paths, fsx, ledger(record)
  ├── brew   → paths, fsx, detect(parseFormulae), ledger(record)
  ├── ledger → paths, fsx, child_process (brew/npm queries only; never touches shared-core)
  ├── state-lock → (fs, path, os) — a leaf too: it has to be takable on a bare machine, before any phase module can load
  ├── prereqs→ (fs, path, child_process, ledger(record)) — a leaf by design *in effect*: doctor
  │           must work on a machine where nothing else in the package can run yet, and ledger
  │           needs only paths + fsx, so that promise still holds
  ├── restore→ paths, fsx, archive
  └── agents  → paths, fsx, prereqs(catalogue + findOnPath), npmpkgs(resolvable), ledger(record)
tools/vendor.js → lib/tooling.js, lib/fsx.js, lib/paths.js   (development only)
```

No cycles: `paths` and `fsx` are leaves; every phase module depends on them and nothing else, except
the deliberate reuses (`remove` re-checks `detect.isProtected`, `brew` reuses `detect.parseFormulae`,
`agents` reads the catalogue and PATH rules out of `prereqs` and registry reachability out of
`npmpkgs`, so an install route is judged by the same probe the npm phase already used).
`ledger` is the one module four phases depend on — brew, npmpkgs, prereqs and agents each call
`record()` after a successful install — and the direction is deliberate: `ledger` depends on
`paths`/`fsx` and queries managers through `child_process`, never on a phase module, so the four
install paths can share one record without any of them importing each other. That is also why
`doctor` keeps working on a bare machine: the ledger it may touch needs no shared-core and no network.
