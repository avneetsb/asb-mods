# Decision log — 0.3.x slicing and the 0.4.0 plan

Authority: `plan/2026-11-21_agent-compat-040.md`. Divergences go here. Every "done" below names the
slice id and what a checker runs; a claim with no live-machine proof says so in its own sentence.

**Loss notice (2026-11-22).** The original version of this file — D1–D6 plus a finding-by-finding
appendix — was never committed, and an in-progress edit truncated it. It could not be restored from git
(no commit and no dangling blob ever contained it) or from the session transcript (which stores digests,
not full tool payloads). What follows is **re-derived** from `git log`, the code, the test suite and the
plan; it is a reconstruction, not the original prose, and it is committed the moment it was written so the
same accident cannot repeat. `test/install.test.js` now refuses a shrunken decision log.

## D1 — Scope narrowed to three hosts (2026-11-21)

**Decision.** pi, Claude Code and Codex CLI only, in code, payload, docs and tests.
**Rejected.** "Mention the others, ship three" — a named surface is a broken promise as soon as its config
format is read on a machine that does not have it.
**Status.** Done, amended by D4. **Claims:** verified — a case-insensitive scan of `*.md *.js *.json *.sh`
for out-of-scope *runtime* names returns zero, checked before the first commit and re-checked by tests.

## D2 — O1 came first, unconditionally (2026-11-22)

**Decision.** Fix the prompt/EOF hang before anything that adds a new entry point. `confirm()` resolves on
readline `close` as a refusal and child stdin is closed; interactivity is judged on `process.stdin.isTTY`,
not on whether stdout is a pipe (the old rule refused to prompt exactly when a human was attached, in
`lib/prereqs.js`).
**Rejected.** Shipping `doctor` first — surfacing "missing" behind the same defect that hangs CI.
**Status.** Done, committed `10ae374`. **Claims:** `npm test` 92 passed / 0 failed at that commit, with an
EOF-with-timeout-kill test (hang made visible, never sleep-polled) and a closed-stdin variant.

## D3 — P1: one place owns paths, env, phase order (2026-11-22)

**Decision.** `lib/paths.js` paths + env reads; `lib/payload.js` placeholder vocabulary and payload
coupling; `lib/prereqs.js` toolchain; `DEPENDENCY-MAP.json` read as data, not restated.
**Rejected.** A big-bang rewrite of `install.js`. **Status.** Partial: paths/env/toolchain consolidated;
`lib/state.js`, `lib/render/*`, the host capability matrix and `asbmods-mcp` are **open** (§1, §2, Q1).
**Claims — read the qualifiers.** "Absolute paths are gone" is *not* verified; the packable tarball has
never been run as an installer, only `npm pack --dry-run` inventories (§5 limitation 39) — that sentence
lives here precisely so it cannot become a claim. "Every phase idempotent" is likewise demonstrated only
on the fake-home e2e, never on a live machine.

## D4 — Cursor removed from scope; nothing deleted (2026-11-21)

**Decision.** No adapter, payload entry or doc names a fourth runtime; vendored `caveman`/`ponytail` keep
their *own* multi-agent install docs intact, documented as personal tooling under §9's vendoring rules.
**Rejected.** Scrubbing upstream skill prose — we would be editing code we do not own to satisfy our scope
note, and it changes nothing operationally.
**Status.** Done; D1's scope rail still passes (the names appear only as inert upstream content, never in
our generators or registers).

## D5 — Host-local memory on purpose (2026-11-21)

**Decision.** Cross-host sharing happens in tool stores (engram over loopback HTTP; Mnemosyne's shared
surface), never by merging two runtimes' memory formats. Each host keeps its own store; `source_agent`
tags rows written through us.
**Rejected.** Shared `.md` pools and a shared `MEMORY.md`. Per §7.4, two agents appending to one file do
not merge and do not lock; the last flush wins and a host quietly loses another's recollection.
**Status.** Done — `docs/wiki/17-agent-memory-surfaces.md` documents all of it (see D7).
**Claims:** *no* live three-host round-trip has been run. What is proven is the protection half:
`MEMORY_SURFACES` in `test/install.test.js` lays down every documented surface inside a throwaway home and
requires the bytes to survive a real run untouched. Locking remains limitation 37.

## D6 — Vendored memory components keep their own stores (2026-11-21)

**Decision.** Engram runs as one loopback HTTP server shared by all three hosts — the pattern the
caliper-harness study showed works. **Rejected:** three databases, or every host writing SQLite directly.
**Status.** Design agreed; the 0.4.0 single-server wiring (§2, Q5) is **open**; we vendor and register the
copy, we do not fork storage. **Claims:** nothing here is load-tested; "single writer" is *design intent*,
which is why limitation 37 stays open rather than being marked mitigated.

## D7 — What P12 actually is; a page-numbering deviation; a destructive bug caught (2026-11-22)

**My task labels drifted and the plan was right.** §10's `P13` row is *dependency-aware brew removal*
(limitation 37), not documentation. `P12` is the docs-coupling guard, and it is **done**: `lib/docsync.js`
checks commands ⊆ wiki 04, parsed flags ⊆ wiki 04, `ASB_MODS_*` both directions, payload dirs ⊆ wiki 06
(with `tooling/` cross-pointed at wiki 07, whose page must actually name the subtree), `Phase N` banners ⊆
wiki 03, and no doc may tell a reader to run an `@asbmods/install` npm route while publishing is parked.
**`P13` (brew dependency check) is still open.**

**Page numbering.** The memory page was to be wiki 08 and runtime layout wiki 09; `08-protection-model.md`
and `09-secrets-and-env.md` already exist and carry links, so memory shipped as **17**. The runtime-layout
/ what-changed page is **still open** and will be 18 rather than squeezed into 08/09.

**Bug found by the slice's own fixture, and fixed.** `MEMORY_SURFACES` requires a sentinel
`~/.codex/AGENTS.override.md` to survive a run. It did not: with `--allow-destructive` the installer
archived and removed it (recoverable under `~/.asb-mods/backups/<ts>/codex/`, and named in the removal
report — but never something we should take). That file silently outranks the `AGENTS.md` Phase 4 manages,
so losing it changes what Codex reads with no signal. `lib/detect.js` `PROTECT_NAMES` now covers
`AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `memories/` and `rules/`; reproduced before and after
(sentinel preserved, `~/.codex/prompts/personal.md` still swept as intended, report no longer names the
override). Recorded as §5 limitation 40.

**Three claims in my own first draft of the memory page were false and were corrected against code:**
(a) "asb-mods deploys `~/.claude/CLAUDE.md`" — no code path writes it; (b) "an existing override is
reported rather than written over" — it was archived, see above; (c) "engram is one server for the three
hosts" — we install and register it but implement neither its storage nor a lock, so the page states
one-writer as intent and points at limitation 37. `~/.codex/AGENTS.md` turned out to be installer-owned
(Phase 4 appends its managed block) and is flagged so the untouched list describes only files nothing
writes.

**Also this slice:** `shared-core/skills/README.md` (tree contract for the four canonical skills) is
listed in `lib/payload.js` `UNREAD`, because deployment walks `skills/canonical/` and nothing opens it;
and doc-to-fixture path matching is done without regexes — escaping left `<project-slug>` literal, which
presented as a missing fixture rather than a broken matcher. Suite at **102 passed / 0 failed**.

## D8 — P13: the dependents question is asked of Homebrew, and it has no override (2026-11-22)

**Decision.** `lib/ledger.js` plan() asks Homebrew itself (`brew uses --installed <formula>`, via
`lib/brew.js` `dependentsOf`) for every present brew formula, and a formula with dependents is held
back. Committed `cc1d843`, closing §5 row 37 and §10 `P13`.
**Rejected.** (a) An override flag — the agent-CLI and runtime-prerequisite hold-backs are *our*
inconvenience and say which flag waives them; breaking someone else's toolchain is not a preference.
(b) A dependency table we maintain — the shim test deliberately deletes a dependent's marker and
requires the formula to become removable again, which only a live manager answer can satisfy. (c) A
batched reverse map from `brew info --json=v2 --formula --installed` — measured here, it returned 178
formulae in 0.9 s but listed only *direct* dependents (5 of the 7 `brew uses` gave for `openssl@3`,
4 of 48 for `ca-certificates`), i.e. it under-reports and would have let exactly the removals through
that this slice exists to stop.
**Claims — with their evidence.** Against this machine's real Homebrew, read-only in a scratch home:
`sqlite` held back naming 29 dependents, `ripgrep` (none) offered for removal. Verified behaviour now
written into both source comment and wiki 04: exit code is 0 for *every* case including an unknown
name, so `No available formula with the name "…"` on stderr is the only thing separating "nothing
depends on it" from "Homebrew has never heard of it", and unknown fails closed.
**Residual, deliberately not removed.** At ~0.74 s per query a 367-row inventory cannot be checked row
by row, so one plan asks at most 60 (`DEPENDENCY_CHECK_CAP`) and the unasked rows are held back as
`dependents not checked this run` rather than offered. Coverage in bulk plans is therefore capped and
*stated*, never silent. Nothing here changes locking or single-writer (that is still limitation 37's
neighbour in §5 row 38 / F8).
**Process notes from this slice.** Two assertion bugs in my own new test failed the first run (I
expected 4 held rows for a cask-containing fixture, and typed `4 installed package(s)` for a 6-dependent
message) — the production code was right and I fixed the test, not the other way round. The brew shim
now answers `uses --installed` from marker files and reproduces brew's unknown-name shape (exit 0 +
stderr warning) because "empty stdout" is ambiguous in real Homebrew and a shim that only returned
dependents would have hidden that. One pre-existing assertion moved to a delta count: it asserted one
uninstall report existed globally, and the new tests legitimately write their own.

## D9 — §1 packaging contract: an allowlist, a payload-integrity refusal, two npm facts that changed files (2026-11-22)

**Decision.** `package.json` gets a `files` allowlist; `scripts/check-pack-coverage.cjs` runs inside
`npm test` and compares four things that had never been compared — the allowlist, the artifact `npm pack`
actually produces, `shared-core/MANIFEST.sha256`, and the tarball file count wiki 15 quotes; and
`install.js` pre-flight refuses with exit 1 when the inventory lists a file that is absent.
**Rejected.** (a) Keeping `.npmignore`-only packaging: it defines an artifact by omission and states
nothing about which trees are load-bearing. (b) Making a *missing inventory* fatal too — a fixture home or
a vendored copy legitimately has none, so that would convert a safety net into a new failure mode (§5 row
32's pattern); it warns instead. (c) Keeping `npm/.npmrc` and merely passing `--userconfig`: the file
cannot ship under that name at all, so wiring it would have made an npm call depend on a path no artifact
contains.
**Two measured facts, each of which moved a file.** (1) A `files` allowlist **takes precedence over the
root `.npmignore`** inside a listed directory: naming `shared-core/` re-admitted
`shared-core/tooling/policy.local.json` — machine-local internal vocabulary — into the artifact. The fix is
the nested `shared-core/tooling/.npmignore` (nested ignores are still consulted inside an allowlisted
directory), verified by packing with and without it. (2) npm will not pack a file named `.npmrc` whatever
`files` says, so the payload's public-registry statement was in the inventory and silently absent from every
artifact; it is `shared-core/npm/registry.conf` now, `lib/npmpkgs.js` no longer claims to hand it to npm,
and it is listed in `payload.js` `UNREAD`. The exclusion rules are centralised in `skipPath()`, which the
check imports, so payload and packaging cannot drift into two different definitions.
**Claims, with their evidence.** `npm test` → **108 passed / 0 failed**; gates: token lint (194 files, 59
placeholders), `MANIFEST.sha256 matches the tree (196 files)`, `[pack-coverage] ok — 240 files`. Guard
reproduced before and after: `install.js --dry-run` against a copied payload with `hooks/hooks.json`
deleted exits 1, names `shared-core/hooks/hooks.json`, and writes no state; with `MANIFEST.sha256` deleted
the same run warns `integrity cannot be checked` and exits 0. Docs corrected against measurement: wiki 15's
tarball row claimed **233 files while `npm pack` produced 241** — nothing had ever compared them — and the
replacement row now says which number is machine-checked and which is not: packed bytes drifted
506,912 → 507,246 → 508,928 B across three consecutive packs here, so bytes/shasum/integrity are explicitly
*not* an artifact identity.
**Scope honesty.** This is the packaging half of §1. The §1 paths that belong to other slices —
`lib/mcp.js`, `shared-core/mcp/servers.json`, `shared-core/toolchain/tools.json`, `lib/state.js`,
`lib/render/*`, `test/{unit,phase,e2e}/` — do not exist yet, so `sec01-layout` stays open; `PLAN_ONE_PATHS`
in the new check registers the payload ones among them, so each slice inherits the packaging guarantee the
moment it lands a file rather than having to remember to ask for one.

## D10 — `P8` cross-process lock: pid liveness, not age, and a lock that cannot lock out a diagnostic (2026-11-22)

**Decision.** `lib/state-lock.js` (the filename wiki 17 had already promised) takes an exclusive-create
lock at `<state-dir>/install.lock` holding `{pid, verb, startedAt, host}`. `install.js` calls
`takeLockOrRefuse(command, flags)` at the three places that write — before the phase pipeline, inside
`reset`, and immediately before `uninstall`'s removal.
**Rejected, each with the failure it avoids.** (a) *Age-based expiry*: reopens the interleaving window on
any legitimately long install — a 367-row brew plan outlives every fixed timeout worth picking.
(b) *Locking read-only verbs*: that turns limitation 32's accepted failure mode into an outage, because you
could not run `status` or `doctor` beside the very run that is blocking you. (c) *`flock`-style advisory
locks*: the holder's fd dies with the process, so there is nothing to show a human — no pid, no verb, no
start time — which is precisely the refusal row 32 asks for. (d) *Auto-steal after N minutes*: same defect
as (a) plus it deletes evidence.
**Measured before writing assertions** (fixture homes, real subprocesses): against a live holder
`uninstall --yes` exits **1** naming `pid`, `running "install"`, `since …`, `host fixture-host`, and prints
both `kill -0 <pid> 2>/dev/null && echo alive` and `asbmods uninstall --force-unlock`; the holder's record
is untouched and no `reports/` directory is created. `--force-unlock` exits 0 reporting `takeover forced
with --force-unlock`. A lock whose pid is gone exits 0 reporting `its pid is gone, so that run crashed or
was killed`. `--dry-run` beside a live holder exits 0 and is never refused.
**One test-harness fact worth keeping.** A "stale" fixture pid cannot come from `cp.spawn` in the test
process: until the event loop reaps it, the child is a zombie and a zombie still answers `kill(pid, 0)` —
so it reads as a *live* holder. The dead pid therefore comes from
`/bin/sh -c 'sleep 0.2 & p=$!; wait $p; echo $p'`, where the parent reaps it before exiting. A fixture that
had used a zombie would have asserted the opposite of what the code does.
**Claims, with their evidence.** `npm test` → **112 passed / 0 failed** (was 108). The four new tests assert
the primitive layer too: `'wx'` create, `holderAlive` on nonsense inputs (`0`, `-1`, `null`, `'nope'`,
`1.5`), a `release()` that refuses to delete a lock it does not own, and that an ancient timestamp with a
live pid is still a refusal while a fresh timestamp with a dead pid is a reported takeover. The new
pack-coverage gate from D9 caught its first drift on this slice: `lib/state-lock.js` made the artifact 241
files and wiki 15's row said 240 — the gate failed `npm test` rather than letting the doc lie.
**Rail honoured, and a correction made durable.** §10.5 requires `O1` before `P8`, because a prompt that can
hang while holding a lock is worse than no lock; `O1` landed first (`46a6e45`, EOF resolves as a refusal),
and the lock is acquired only after every prompt-capable decision point that precedes a write. Worth
recording because a session note in this very slice asserted that a lock and its test already existed: the
repository had **neither** (`grep "process\.kill("` → no matches outside the new file), and the docs were
more accurate than the note — wiki 17 said "no cross-process lock today … `lib/state-lock.js` will add".
Docs updated to present tense, and limitation 32 now disposes as *accepted with a defined escape* against
test names rather than prose.

## Findings from the caliper-harness study, and where each stands

The read-only caliper-harness study checkout — its location is deliberately not recorded here, since a personal absolute path is exactly what the leak screens below refuse; plan §6 holds the analysis. Status is
per `git log`, the code and the suite at HEAD, not per intention.

| Id | Finding in one line | Slice | Status today |
| --- | --- | --- | --- |
| F2 | One file owns the phase sequence | P1 | Partial — `lib/paths.js` / `lib/payload.js` extracted; `lib/pipeline.js` open |
| F3 | Declarative renderer, one `mode:` per host | P2 | Open (0.4.0 §2) |
| F4 | State root `~/.asb-mods/{toolchain,bin}` with a lock | P4 | Partial — `lib/paths.js` models both roots; no runtime layout yet |
| F5 | Single `asbmods-mcp` binary + data-only server table | P3 | Open (0.4.0 §2) |
| F6 | Doctor table names the missing thing *and* its fix command | P14 | Done — `asbmods doctor`, committed with the 0.2.0 CLI work |
| F7 | Toolchain lives under state root, PATH is a consequence | M1/M2 | Partial — `lib/prereqs.js` reports and installs; **M1** (node + Homebrew bootstrap) open |
| F8 | One writer per store; others talk to a server | D6 | Design agreed; wiring open; limitation 37 stands |
| F9 | `config/` payload read by no code | P7 | Open — enumerated honestly instead, in `lib/payload.js` `UNREAD` |
| F10 | No offline/self-contained bootstrap artifact | M5 | Open |
| F11 | Payload↔code coupling unasserted; some payload read by nobody | P6 | **Done** — `OWNED`/`UNREAD` + bundle-aware coverage; `config/` named as unread |
| F12 | Doc truth unguarded | P12 | **Done** — `lib/docsync.js`, six checks, each proven to bite |
| F13 | Tests all e2e-tier, slow and ungrouped | P9/P10 | Open — unit tier exists for new pure modules only, no CI yet |
| F14 | No CI on this repo | P11 | Open (P12/P5/P6 gates exist to be wired) |
| F15 | No coverage measurement | P9 | Open |
| F16 | Prompt hangs on EOF (limitation 32) | O1 | **Done** — `10ae374`, EOF test kills on timeout |
| F17 | Codex has four surfaces, not one | P13-docs | **Done** — documented in wiki 17 with verified paths |
| F18 | Memory surfaces unmanaged and unprotected | P13-docs/O8 | **Fixed for removal** (`PROTECT_NAMES`); recording/compaction still open (O6) |
| F19 | Shared skills must reach all three hosts identically | T24/P8 | Partial — canonical skills deploy to three hosts and are asserted; lock-free registry open |
| F20 | Runtime layout undocumented | P13-docs | Open — will be wiki 18 |
| F21 | Brew removal ignores dependents (limitation 37) | P13 | **Done** — `cc1d843`: dependents asked of Homebrew, no override flag; bulk coverage capped at 60 queries and the cap is stated |

## Reading rules, since this file is public

Never write into this repository, or any artifact generated from it: employer names, client names, repo
names, internal endpoints, ticket keys, personal absolute paths — including the study checkout's location, which is why it is named and never
addressed — key material or fragments. `test/install.test.js` runs
both leak screens on every `npm test`; a violation fails the suite rather than the release.

## 2026-11-22 — brew inventory: mislabelled formula twins are voided, not installed

**Slice.** Found while starting `M1` (plan §6 row 231: "`iterm2` cask under install/uninstall ledger").
M1 cannot ship a working `iterm2` cask row while the same name is also planned as a formula.

**Defect (measured, not inferred).** `shared-core/brew/formulae.csv` is a dump of one machine's
`brew list` and carries 367 rows across 273 distinct names: 188 rows share a name with another row.
For `iterm2`, `claude` and every `font-*` row the two rows carry the *same version* and differ only
in `type`, and Homebrew provides no formula by those names — probed unproxied on 2026-11-22:

```
iterm2   formula_exit=1 cask_exit=0     (Error: No available formula with the name "iterm2".
                                         Found a cask named "iterm2" instead.)
claude   formula_exit=1 cask_exit=0
font-caskaydia-cove-nerd-font  formula_exit=1 cask_exit=0
docker   formula_exit=0 cask_exit=0     (a genuine dual: versions differ, both rows kept)
```

A formula row that Homebrew can never satisfy is unsatisfiable forever, so it was counted missing on
every machine and `--install-prereqs` spent a doomed `brew install <name>` on each one. Before the
fix, real-machine plan reported installed iTerm2/Claude/fonts as missing; after it, the same command
fix, real-machine plan reported installed iTerm2/Claude/fonts as missing. After it the same machine
reports `considered 367 / present 271 / missing 2 / deferred 1 / voided 93` (scope=all) and
`considered 28 / voided 0` (scope=required), with `font_rows_missing 0`.

**Decision.** In `lib/brew.js plan()`, a `formula` row whose name+version also appears as a `cask`
row is one artefact listed twice: when its cask twin is installed the row adds nothing (the cask row
accounts for it), and when the twin is absent the row is **deferred** with the reason
`brew provides no formula by this name — the same-version cask row covers it`. It is never an install
target. Rows whose versions differ are left completely alone, so a name Homebrew genuinely provides
both ways keeps both behaviours.

Voided rows are **counted, not dropped**: `plan()` returns `voided`/`voidedCount` and folds them into
`considered`, preserving the invariant `considered == rows in scope` that
`brew --scope=required considers every non-optional row` asserts. The first version of this fix
`continue`d silently and broke that invariant — required scope reported 122 considered against 28 rows
in scope, because the twin test also ran ahead of the scope filter. Both invariants are now machine
checked, and the twin handling sits after `wantOnly` so scope counts stay honest.

**Rejected alternative.** A blanket "when a name is both formula and cask, prefer the cask" rule was
refused: for names Homebrew really does provide both ways (`docker`, and the `oracle`/`vmware` family
the installer already holds back for entitlements), cask-precedence would silently turn a CLI formula
install into a GUI bundle install. Kind must come from what brew provides, not from a table preference.

**Visibility.** `install.js` phase 5 now prints each held-back row with its reason in both branches
(plan and `--install-brew`), because a row this package will never install is the kind of row an
operator has to see; previously `deferred` existed only in the report JSON and `--install-brew` printed
no reason at all. `asbmods brew --install-brew` output is the assertion target in test section `17b`.

**Not done here.** The inventory data itself is left as detected — repairing the vendored dump means
regenerating it from a real `brew list`, which is a data slice, not this code fix. Until then the twin
rows are inert and counted once.
