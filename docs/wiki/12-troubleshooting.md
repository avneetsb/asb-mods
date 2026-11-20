# 12 — Troubleshooting and known gaps

[← 11 Updating and rolling back](11-update-and-rollback.md) · [Home](Home.md) · Next: [13 — Testing](13-testing.md)

## First five things to try

```bash
asbmods status                        # read-only: 14 checks, "N/M checks green"
ASB_MODS_DEBUG=1 asbmods <cmd>        # full stack trace instead of one message
asbmods --dry-run                     # what this invocation would do, provably inert
python3 -m json.tool ~/.config/asb-mods/state.json | head -40   # what the last run recorded
node --version                        # must be >= 18 (engines field)
```

## By symptom

### Installation and detection

| Symptom | Cause | Fix |
| --- | --- | --- |
| `shared-core not found next to installer` (exit 1) | ran from a partial copy, or `ASB_MODS_CORE` points at something else | use a real clone, or unset `ASB_MODS_CORE` and retry |
| `npx @asbmods/install` fails / 404 | the package is **not published to the public registry** yet | `npx github:avneetsb/asb-mods#v0.2.0` or a checkout |
| `npm warn gitignore-fallback` while packing | `.npmignore` deleted or out of sync | restore it; publish-time ignore set is stated explicitly |
| detection reports nothing under `~/.claude` | tool installed but never run, so no config dir exists | start the agent once; `hooks` then reports `up-to-date` instead of `skipped` |
| a large install appears to hang listing one directory | a directory with huge numbers of children | by design: `CHILD_LIMIT = 400` per listing caps it — detection still finishes |
| exit status 0 but something clearly didn't happen | success means "ran to completion", not "did everything" | read the **Summary** block or `asbmods status`; automation should pass `--strict`, which turns those soft failures into exit 3. See *Not bugs* below |

### Removal and restore

| Symptom | Cause | Fix |
| --- | --- | --- |
| `destructive phase not authorised (pass --allow-destructive)` | removal did twice as much authorisation as `--yes` gives it | add `--allow-destructive`; confirm the archive looks right first |
| removal skipped with an archive complaint | no verified archive exists for this run | run `asbmods archive` (or `all`, which archives first) |
| entry in `refused[]` you wanted removed | it matched a protection pattern, or fell outside the target home | intended: [page 08](08-protection-model.md). Remove it by hand if you really mean it |
| `reset` says the newest report is a dry-run report | newest report was written by a rehearsal | `asbmods reset --report=<real-removal-report>.json` |
| restored file has old content you expected to keep | the archive predates your own edits | archives are point-in-time: prefer layer-2 `file-backups/` restores ([page 11](11-update-and-rollback.md)) |

### Hooks

| Symptom | Cause | Fix |
| --- | --- | --- |
| `pi:skipped` although pi is installed | `~/.pi/agent` missing (not the `extensions` subdir) | create/start pi once, then `asbmods hooks` |
| hook registered with a literal `{{STATE_DIR}}` | a new field bypassed `flatten()`'s placeholder resolution | route it through `flatten`; see [page 10](10-hooks-reference.md) |
| duplicated hook commands | the `# asb-mods:<name>` marker was hand-edited away | dedupe by hand, re-run `asbmods hooks` |
| hook helper exits non-zero silently and nothing shows | 8 s timeout, or a script that needs an interactive shell | run the helper directly from the state dir and time it |

### Brew and npm

| Symptom | Cause | Fix |
| --- | --- | --- |
| brew phase reports `brewAvailable: false` | Homebrew not installed / not on PATH | install brew, or accept plan-only mode |
| `missing: 18` never reaches 0 | deferred casks and optional rows | check `deferred[]`: interactive casks (docker/virtualbox/vmware/oracle) are never auto-installed |
| `--scope=required` considered too few rows | the filter didn't include the CSV's `core` value | fixed — see *Known gaps* (regression test added) |
| npm phase marks packages `unavailable` | `npm view` probe failed (registry unreachable, or private scope) | verify reachability; `--probe=false` skips the check and reports nothing as unavailable |
| `--install-npm` did nothing | every manifest package already present | normal: the phase reports `installed: 14` |

### Secrets and shell env

| Symptom | Cause | Fix |
| --- | --- | --- |
| `status` warns about `secrets.env` | file missing (never prompted) or mode not 600 | `asbmods secrets`, then `chmod 600` if the mode is wrong |
| prompts appeared in CI | `--no-input` missing | add it; the phase then leaves unset values alone |
| exports absent in a new shell | rc block not sourced yet, or you use a shell with no wired rc file | `exec zsh`; fish/csh are not wired — source `<state-dir>/env/shell-env.sh` yourself |
| TLS/`unable to verify` errors in tools | `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` not pointing at a bundle with this machine's roots | rebuild the bundle and re-run `asbmods env` ([page 09](09-secrets-and-env.md)) |

### Vendoring and publishing

| Symptom | Cause | Fix |
| --- | --- | --- |
| parity test names an artifact class | class removable but nothing bundles it | vendor it: [page 07](07-personal-tooling-vendoring.md) |
| `tools/vendor.js --dry-run` refuses a personal artifact | it isn't in `personalSkills` / `personalCodexFiles`, or hits a `denyBundles` entry | add it to the allow-list only if you authored it and its content is safe to publish |
| an exclusion reason names an internal system | committed metadata leaked vocabulary | rewrite generically; keep the term list in gitignored `policy.local.json` |
| a vendored extension can't find files after deploy | destination template lost `{{HOME}}` / `{{NAME}}` | restore the placeholders in `lib/tooling.js` and re-run `deployTooling()` |

### Prerequisites and bootstrap

| Symptom | Cause | What to do |
| --- | --- | --- |
| `asbmods doctor` exits `1` in a CI job | A prerequisite really is missing — that exit code **is** the answer, not a crash. Each row prints its own fix | Read the rows, or use `asbmods doctor --json` and gate on `.ok` |
| `doctor` says Homebrew is missing, but `/opt/homebrew/bin/brew` exists | Installed and never exported, so nothing that calls `brew` by name can use it. Reported deliberately | Do what the row says: `eval "$(/opt/homebrew/bin/brew shellenv)"`, then put that line in your shell profile |
| brew phase prints `Homebrew is not installed — no inventory row was considered` and lists nothing | Homebrew absent. Before this message existed, the phase claimed all 367 rows missing, which read like a broken manifest | Install Homebrew (`bootstrap.sh --via=brew`, or the command in `doctor`'s fix line), then re-run `asbmods brew` |
| `--install-prereqs` exits `2` immediately | It was combined with `--no-input`. An unattended run cannot consent to installing third-party software, so refusing beats installing | Use plain `asbmods doctor` in CI, or run the install path interactively |
| `Homebrew's installer needs an admin password and a terminal. Run this interactively` | `sudo` needs both; the script stops instead of dying inside them | Run it in a real terminal, or install Homebrew yourself and re-run `asbmods doctor` |
| `--install-agents` reports `no install route resolved` for a tool | Every probe failed: Homebrew off PATH, or `npm view` could not reach the registry, or the formula/cask name moved | Fix the route it names in the detail line, or install that CLI yourself — the report at `reports/agents-<stamp>.json` carries each route's reason |
| An announcement line in `bootstrap.sh` prints several hundred lines of someone else's script | A `$( … )` inside a double-quoted `say` string *ran* the command it meant to describe (this happened for real with the Homebrew installer) | Quote the announcement in single quotes. The suite pins it: `bootstrap.sh --dry-run announces the Homebrew route instead of running it` |

## Known gaps

These are real limitations of the current code, not misuse. Each names the honest workaround and,
where small, the fix.

| # | Gap | Impact | Workaround / fix |
| --- | --- | --- | --- |
| 1 | brew installs are never uninstalled, npm globals likewise | a payload change can leave stale artifacts on the machine | remove them yourself (`brew remove`, `npm rm -g`). Fix: a `prune` phase diffing manifest vs installed |
| 2 | `reset` has no `--dry-run` and applies immediately | an unintended replay overwrites current files | rehearsal against `ASB_MODS_HOME=/tmp/…` first; layer-2 backups still exist |
| 3 | archives are never pruned | disk usage grows with every cutover | prune as described on [page 11](11-update-and-rollback.md#pruning-safely) |
| 4 | POSIX-only assumptions (`/bin/bash -lc`, `.zshrc`/`.bashrc`/`.zshenv`) | no Windows support; fish/csh get no rc wiring | on Windows use a POSIX shell environment; source the env file manually in fish |
| 5 | commits are not cryptographically signed | `git log` shows verified-looking authorship without a signature | verify by content and CI, or set `user.signingkey` + `gpg.format=ssh` and re-sign your own commits |
| 6 | not published to the public registry (`npm view @asbmods/install` → 404) | `npx @asbmods/install` fails; the README's npx route is `github:`-prefixed | publish checklist on [page 15](15-release-and-publishing.md) |

Per-tool filtering still does not exist: `--agent=<a,b>` is **rejected** (exit 2) rather than
accepted and ignored, so a run never looks scoped when it is not. Implementing the filter means
threading a selection through detection, deploy, hooks, brew and env; until that lands, every run
processes all three agents.
**Resolved today** (kept here because the fix is behavioural):

- `--scope=required` selected `dependency-type ∈ {direct, required, tooling}` while
  `formulae.csv` tags rows `core|tooling|optional`, so all 23 `core` rows were silently excluded
  (5 rows considered instead of 28). `lib/brew.js` now includes `core`, and the suite has a test
  asserting the required scope considers every non-optional row.
- brew installs iterate manifest **rows**, so a cask is never satisfied by a same-named formula.
- hook placeholder resolution happens at registration time, so no literal `{{STATE_DIR}}` ships.

- `--help` / `-h` are parsed and short-circuit before pre-flight; previously `asbmods --help`
  ran detection and exited 0.
- Unknown command words, unrecognised `--flags` and invalid `--scope` values now exit **2** and
  name the offending token. `asbmods instal` no longer means "detect and stop with exit 0", and
  `--alow-destructive` no longer looks like an authorisation that was never granted.
- `--agent=<a,b>` is rejected with a one-line explanation instead of being silently inert.
- `--strict` exits **3** when a phase soft-failed — archive incomplete, removal failures, install
  returned nothing, npm packages unresolvable, brew rows still missing after `--install-brew`, or
  secrets verification failed. Without it exit 0 still means only "ran to completion", because a
  skipped removal or an absent agent is the expected outcome of a normal plan run.
## Not bugs — by design

| Looks wrong | Is deliberate because |
| --- | --- |
| `~/.codex/config.toml` never written | it holds live model/auth state; hooks go to `~/.codex/hooks.json` instead |
| settings merge leaves your extra keys alone | the package owns fragments, not your whole config |
| protection refused to delete `~/.claude/settings.json` | it is config the package never authored |
| brew/npm default to plan-only | installing 367 rows or 14 globals unprompted is not a safe default |
| third-party skills excluded from vendoring | only personally authored artifacts ship (`personalOnly: true`) |
| `status` reports the same thing twice in one block | it checks both "deployed" and "referenced by config", which can disagree |

## Reading the artifacts when something is confusing

| File | Answers |
| --- | --- |
| `~/.config/asb-mods/state.json` | what ran last, and the last 40 runs (`history`) |
| `~/…/installed-manifest.json` | exactly which keys were added/appended/replaced, per file |
| `~…/reports/removal-<stamp>.json` | what was deleted, with type/bytes/sha per entry |
| `~…/reports/restore-<stamp>.json` | what a reset put back |
| `~…/reports/inventory-*.json`, `npm-*.json` | detection and npm snapshots (detection writes these even on dry runs) |
| `~…/backups/<stamp>/` + `last-archive.json` | the pre-change snapshot and its completeness verdict |
| `~…/file-backups/` | every pre-write copy of a config file, hash-named |
