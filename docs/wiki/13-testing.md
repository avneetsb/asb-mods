# 13 — Testing

[← 12 Troubleshooting](12-troubleshooting.md) · [Home](Home.md) · Next: [14 — Contributing](14-contributing.md)

One file, **74 test cases** across 14 sections, 1,076 lines: `test/install.test.js`. Run it with
`npm test`; the verdict line at the end reads `74 passed, 0 failed`. No network dependency except the
npm registry probe, which the suite deliberately tolerates failing.

```bash
npm test                                   # the whole suite
node test/install.test.js                  # identical (that is what npm test runs)
npm test 2>&1 | grep -A3 FAIL              # triage just the failures
npm test 2>&1 | tail -20                   # the verdict line at the end
```

There is no `node:test`, no runner dependency and no name filter — the file defines its own
`test(name, fn)` helper, so `node --test --test-name-pattern=…` does not apply. The suite is fast
enough to run whole every time, which is the point.

## How it stays honest: a fixture home

Nothing in the suite touches your machine. It builds a throwaway world in `mkdtemp(<tmp>/asbmods-e2e-*)`:

```text
ROOT/home          → passed as ASB_MODS_HOME   (the fake "machine")
ROOT/xdg-config    → passed as XDG_CONFIG_HOME (fake state dir: archives, reports, env)
ROOT/pkgcopy       → copyPackage(): a copy of the package, so PKG_ROOT-relative deploy works
```

`install.js` is spawned as a **child process** with those three variables set (`ASB_MODS_HOME`,
`XDG_CONFIG_HOME`, `ASB_MODS_CORE`). That matters: the suite exercises the real CLI, argv parsing and
exit codes included — not an internal API reimplemented in test.

## The fixture is two lists per agent

`FIXTURE` declares, for each of pi / Claude Code / Codex, files that **must be treated as removable**
(`custom`) and files that **must survive** (`protected`). A test asserts every `protected` path is
still byte-identical after a full cutover, and every `custom` path is archived then gone.

| Agent | `custom` — expected to be archived and removed | `protected` — must survive untouched |
| --- | --- | --- |
| pi | `.pi/agent/extensions/alpha.ts`, `extensions/beta.js`, `extensions/nested/gamma.ts`, `.agents/skills/legacy-skill/SKILL.md`, `.agents/packages/old-package/package.json`, `.pi/agent/prompts/stale-prompt.md` | `.pi/agent/settings.json`, `auth.json`, `.credentials.json`, `sessions/index.sqlite`, `history.jsonl`, `npm/node_modules/thing/package.json` |
| Claude Code | `.claude/agents/reviewer.md`, `skills/old-skill/SKILL.md`, `hooks/gitnexus/hook.cjs`, `plugins/marketplace.json` | `settings.json`, `.credentials.json`, `history.jsonl` |
| Codex | `.codex/skills/codex-skill/SKILL.md`, `notes.md` | `config.toml`, `auth.json`, `version.json`, `hooks.json` |

Plus three canary strings that must still be present afterwards:

```text
PI-OWNED-KEY-must-survive        the user's own pi-owned key, not clobbered by a settings merge
echo foreign-claude-hook-must-survive    a hook the package did not author
echo foreign-codex-hook-must-survive     ditto, codex side
```

Those canaries are why a regression in `mergeInto` or hook registration fails loudly: they encode
"the user's content is not ours to rewrite".

## The inertness proof

`hashTree(HOME)` hashes the entire fixture tree. The dry-run test snapshots it, runs
`--dry-run --allow-destructive --yes --no-input`, and asserts (a) exit status 0, (b) the tree hash is
unchanged, (c) no `backups/` directory appeared, (d) no `installed-manifest.json` was written.
That is the strongest cheap guarantee in the suite: a dry run cannot mutate anything, anywhere.

## What each section covers

| Section (printed as `── …`) | Proves |
| --- | --- |
| Package shape and self-containment | no runtime dependencies, `bin` wiring, `shared-core` present, packaged files name only supported agents, retired generator file absent, canonical skills are real content |
| Phase 1 — detection against fixture home | every `custom` artifact classified removable, every `protected` path excluded, brew inventory CSV-consistent, `--scope=required` covers non-optional rows |
| Phase 1b — `--dry-run` provably inert | the `hashTree` proof above |
| Phase 5 — interactive secret collection | template declares vars; piped prompts produce `secrets.env` at mode 600 with every value |
| Phases 2-4, 6 — full cutover | archive completeness + git tag, removal counts vs report, deploy actions, tooling restored, settings merged additively, hooks registered |
| Idempotency and rollback | second run changes nothing new; `reset` restores from the removal report; canaries survive |
| 14 shell-env.sh sources in a clean shell without corrupting it | runs `zsh -c 'source …'` and asserts the exports arrive and the shell still works |
| 15 env phase on fresh home creates rc files | marked blocks created in `.zshrc`/`.bashrc`/`.zshenv` where absent |
| 16 packaged tooling covers removal contract and restores real | the vendoring parity contract of [page 07](07-personal-tooling-vendoring.md) |
| 17 source map and dependency map agree packaging contract | `source-map.json` vs the shipped payload do not disagree |
| 18 brew phase installs formulae and casks right subcommand | `--cask` used for casks, rows (not names) drive install, interactive casks deferred, a report is written |
| CLI usage guards | `--help`/`-h` print usage without running a phase; unknown command, unknown flag, bad `--scope` and `--agent` all exit 2 and write no state; `--strict` exits 0 on a clean run |
| Prerequisites — doctor / `--install-prereqs` / `--install-agents` | every row exists and each gap carries a fix; `doctor`'s exit code agrees with its own rows; off-PATH Homebrew is a gap with the `shellenv` fix; the brew phase no longer calls 367 rows missing and `--strict` does not punish it; `--install-prereqs` refuses under `--no-input` and announces without executing under `--dry-run`; `agents.json` uses only implemented route kinds; a dry-run agent pass writes its report and starts nothing |
| `bootstrap.sh` | `--help` lists the routes; a machine with Node is left alone; a Node-less machine is diagnosed and `--via=none` exits 1; the Homebrew route is *announced*, never run (this pins a real bug: a double-quoted `$(curl …)` announcement executed the download it was describing); with no terminal to answer on, nothing is installed |

These two sections run the installer under a **stripped PATH** — a fixture `bin/` holding a symlink to
the test runner's own `node` plus `/usr/bin/git`, and nothing else. That is how a fresh machine gets
tested on a fully provisioned one: Homebrew and the agent CLIs become absent by construction rather
than by uninstalling them, and because Homebrew stays present-but-off-PATH it also proves the tool
does not count a `brew` it cannot invoke as ready.

## Adding a test

Use the existing helpers — do not add a dependency:

```js
section('Phase N — what you are proving');            // prints a banner
test('short claim about behaviour', () => {
  const r = run(['install', '--no-input']);           // spawn the real CLI with fixture env
  assert.strictEqual(r.status, 0, r.out.slice(-400)); // keep output in the failure message
  assert.ok(fs.existsSync(path.join(STATE, 'installed-manifest.json')));
});
```

| Helper | Use for |
| --- | --- |
| `run(args, opts)` | spawn `install.js` with fixture env; returns `{ status, out }` |
| `write(rel, text)` | create a file under the fixture home (parents included) |
| `buildFixture()` / `copyPackage()` | reset the fake machine / refresh the package copy |
| `hashTree(dir)` | before/after equality proofs |
| `packagedFiles()` | iterate everything the package actually ships (the guard tests use it) |

Rules that keep this suite useful:

1. assert on the **fixture**, never on your real home;
2. destructive behaviour gets a "user content survives" assertion next to it;
3. when you fix a bug, add the failing case first — `--scope=required` was caught exactly this way
   (considered 5 rows where the inventory has 28 non-optional ones);
4. don't assert on colours or exact banner widths; assert on report/state JSON.

## Running one area while iterating

No filter exists, so iterate by running the CLI directly against your own fixture and only run the
suite before committing:

```bash
FIX=/tmp/asb-fix; rm -rf $FIX; mkdir -p $FIX/home $FIX/xdg
ASB_MODS_HOME=$FIX/home XDG_CONFIG_HOME=$FIX/xdg ASB_MODS_CORE=$PWD/shared-core \
  node install.js all --allow-destructive --yes --no-input
ASB_MODS_HOME=$FIX/home XDG_CONFIG_HOME=$FIX/xdg node install.js status
npm test                                   # before you commit anything
```
