# 04 — CLI reference

[← 03 Phases](03-phases.md) · [Home](Home.md) · Next: [05 — Code components](05-components-lib.md)

```text
asbmods [command] [flags]
```

The command is the first non-flag argument and defaults to `all`. Invocation forms are equivalent:
`node install.js`, `./install.js`, `asbmods`, `npx github:avneetsb/asb-mods`.

## Commands

| Command | Runs | Notes |
| --- | --- | --- |
| `all` (default) | pre-flight → detect → archive → remove → install → npm → brew → env → secrets → hooks | removal still needs `--allow-destructive`; without it Phase 3 reports why it skipped |
| `detect` | Phase 1 only, then exits | honours `--json`; skips pre-flight (it is pure read) |
| `status` | verification only, then exits | never mutates; honours `--json` |
| `reset` | restore from a removal report, then exits | applies immediately; `--report=<name>` selects the report |
| `archive` | detect → archive | |
| `remove` | detect → remove | refuses without `--allow-destructive` **and** a verified archive |
| `install` | detect → install (deploy shared-core) | the normal update command |
| `npm` | detect → npm global report | add `--install-npm` to act |
| `brew` | detect → brew plan | add `--install-brew` to act |
| `env` | detect → deploy `shell-env.sh` + wire rc files | |
| `secrets` | detect → collect secrets | interactive unless `--no-input` |
| `hooks` | detect → register hooks in all three tools | |
| `help` | prints usage and exits | same text as `--help` / `-h` |

**Unknown command.** A token matching no known command is rejected before pre-flight: exit 2, message
`unknown command "instal" — known: all, detect, …`. The same check covers mistyped flags, so
`--alow-destructive` fails loudly instead of running an unauthorised-removal-shaped plan.
[Known gaps →](12-troubleshooting.md#known-gaps)

## Flags

| Flag | Short | Effect | Consumed by |
| --- | --- | --- | --- |
| `--dry-run` | `-n` | Every phase reports and returns its normal result shape without touching disk; no archive, no manifest, no tag | all phases |
| `--yes` | `-y` | Skips the interactive removal confirmation (does **not** authorise removal) | `install.js` |
| `--allow-destructive` | | Authorises Phase 3. Without it, removal reports `destructive phase not authorised (pass --allow-destructive)` | `lib/remove.js` |
| `--no-input` | | Never prompts; keeps existing values untouched (CI, tests) | `lib/secrets.js` |
| `--scope=all\|required` | | brew only: `all` considers every row of `formulae.csv` (367), `required` only rows whose `dependency-type` is `core` or `tooling` (28 of 367; `direct`/`required` are accepted as aliases) | `lib/brew.js` |
| `--install-brew` | | Actually runs `brew install` for missing rows (default is plan-only) | `lib/brew.js` |
| `--limit=<n>` | | Caps brew installs in this run | `lib/brew.js` |
| `--install-npm` | | Actually runs `npm i -g` for missing, resolvable manifest packages | `lib/npmpkgs.js` |
| `--probe=<bool>` | | `false` skips the `npm view` reachability probe (fast, but then nothing is reported unavailable) | `lib/npmpkgs.js` |
| `--rotate-secrets` | | Re-prompts for variables that already have a value | `lib/secrets.js` |
| `--json` | | `detect` prints the whole inventory; `status` prints `{ lines, state, archives }` | `install.js` |
| `--report=<name>` | | For `reset`: which `reports/removal-<stamp>.json` to replay | `lib/restore.js` |
| `--agent=<a,b>` | | **Rejected (exit 2)** — per-tool filtering is not implemented, so the flag is refused instead of being silently inert | `install.js` |
| `--strict` | | Exits **3** if any phase soft-failed (see [Exit codes](#exit-codes)); without it exit 0 only means the run finished | `install.js` |
| `--help`, `-h` | | Prints usage and exits 0 before pre-flight or any phase runs. Same text as the `help` command | `install.js` |

Unrecognised flags, unknown command words and invalid `--scope` values are rejected with exit 2 and
the offending token named, so a typo cannot masquerade as an instruction that was never given. The
summary block at the end of a run is still what tells you what actually happened.

## Environment variables

| Variable | Effect |
| --- | --- |
| `ASB_MODS_HOME` | Target home directory. Everything — detection, archiving, removal, deployment — is scoped to it. This is how the suite runs destructive flows against a throwaway fixture home |
| `ASB_MODS_CORE` | Overrides the `shared-core` source-of-truth directory (defaults to `<package>/shared-core`) |
| `XDG_CONFIG_HOME` | Relocates the state directory: `<XDG_CONFIG_HOME \|\| ~/.config>/asb-mods` |
| `ASB_MODS_ASSUME_YES` | Set to `1` to auto-answer every confirmation (used by automated runs; implies no human gate on removal, so pair it with care) |
| `NO_COLOR` | Disables ANSI colour (also automatic when stdout is not a TTY) |
| `ASB_MODS_DEBUG` | Prints the full stack trace on a fatal error instead of just the message |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Ran to completion — **including** a run where removal skipped, brew had missing rows, or some packages were unavailable (unless `--strict` was passed). Read the summary, don't infer from status |
| `1` | Fatal: uncaught error (message only, or stack with `ASB_MODS_DEBUG=1`), or `shared-core` missing next to the installer |
| `2` | Bad usage: unknown command, unrecognised flag, invalid `--scope` value, or `--agent` passed. Nothing was inspected or changed — the check runs before pre-flight |
| `3` | `--strict` was passed and a phase soft-failed: archive incomplete, removal failures, install returned no actions, npm packages unresolvable, brew rows still missing after `--install-brew`, or secrets verification failed |

## Reading the output

Log lines are prefixed `[ok]`, `[warn]`, `[error]`, `[..]` and, for the brew missing-row digest, `[dim]`
(green/yellow/red/cyan/grey on a TTY). Phases are separated by `── Phase N — Title ──` banners. The final
**Summary** block is the machine-usable part. The numbers below are illustrative — shape and keys are what
matter:
part. The numbers below are illustrative — shape and keys are what matter:

```text
── Summary ──────────────────────────────────────────
  archive: complete
  removed: 173
  installedActions: 61
  npm: {"total":14,"installed":14,"available":0,"unavailable":0}
  brew: {"present":341,"missing":18}
  secretsVerified: true
  hooks: ["pi:registered","claude:up-to-date","codex:up-to-date"]
```

`installedActions` counts deploy actions (skill/prompt/hook-bin/settings/tooling entries), not files;
`hooks` reports `registered` (changed), `up-to-date` (idempotent no-op) or `skipped` (tool absent).

## Recipes

```bash
# 1. Inspect before touching anything
asbmods --dry-run | tee /tmp/asbmods-plan.txt
asbmods detect --json > inventory.json
asbmods status

# 2. Reproduce a machine from scratch
npx github:avneetsb/asb-mods#v0.2.0 --allow-destructive --yes
exec zsh && asbmods status

# 3. Update an existing install (no removal)
cd ~/Dev/asb-mods && git pull --ff-only && npm test && asbmods install

# 4. Update tooling config only
asbmods hooks            # re-register shared hooks
asbmods env              # re-wire shell-env after editing shell-env.sh

# 5. Phased brew install on a new machine (40 rows at a time, log kept)
asbmods brew --install-brew --limit=40 2>&1 | tee /tmp/brew1.log
asbmods brew --install-brew --limit=40 2>&1 | tee /tmp/brew2.log
asbmods brew                            # confirm: missing → deferred casks only

# 6. CI / automation
asbmods --dry-run --json --no-input
ASB_MODS_HOME="$PWD/fixture" asbmods all --allow-destructive --yes --no-input

# 7. Undo
asbmods reset                          # newest removal report
ls ~/.config/asb-mods/reports          # which reports exist
asbmods reset --report=removal-2026-11-20T02-41-33-507Z.json
```

## Getting help

```bash
asbmods help      # the usage text, flags and environment variables
```

`--help` and `-h` are parsed by `parseArgv` and short-circuit in `main()` before pre-flight, so nothing
is inspected or written when you ask for usage. Anything the parser does not recognise — a command word,
a `--flag`, an invalid `--scope` value, or `--agent` — exits 2 naming the token, which is also what
`asbmods instal` now costs instead of silently running detection.
[Known gaps →](12-troubleshooting.md#known-gaps)
