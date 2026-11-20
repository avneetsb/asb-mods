# 14 — Contributing

[← 13 Testing](13-testing.md) · [Home](Home.md) · Next: [15 — Release and publishing](15-release-and-publishing.md)

## Read in this order

1. [02 Architecture](02-architecture.md) — what owns what.
2. [03 Phases](03-phases.md) — the order of operations and each phase's contract.
3. [05 Code components](05-components-lib.md) — module boundaries and the dependency graph.
4. [07 Vendoring](07-personal-tooling-vendoring.md) + [08 Protection](08-protection-model.md) — the
   two safety contracts. Most "why is it like this?" answers are here.

## Orientation

```text
install.js            CLI + phase orchestration + status/reset/help        start here
lib/paths.js          every path decision (the only place HOME is resolved)
lib/fsx.js            filesystem primitives — extend here, not ad hoc
lib/detect.js         phase 1 + PROTECT_NAMES (the denylist)
lib/{archive,remove,deploy,hooks,secrets,npmpkgs,brew,restore}.js   one phase each
lib/tooling.js        the artifact-class contract shared by vendor + deploy + tests
shared-core/          the payload (data + two shell scripts)               page 06
tools/vendor.js       development-only bundle generator                    page 07
test/install.test.js  the whole suite, one file                            page 13
docs/wiki/            this documentation, linked from README
```

Rules the codebase actually follows:

- **CommonJS, zero runtime dependencies, nothing to build.** `package.json` has no `dependencies`;
  adding one is a design decision, not a convenience. Node ≥ 18 (`engines`).
- **`paths.js` and `fsx.js` are leaves.** A phase module may depend on them; they depend on nothing but
  each other. Keep it that way — it is what makes `ASB_MODS_HOME` isolation possible.
- **Never hardcode a home path.** Resolve through `paths.js`, and in shipped data use `{{HOME}}`,
  `{{STATE_DIR}}`, `{{CORE}}` (resolved by `resolvePlaceholders` / `flatten`).
- **Report, don't assume.** Destructive code verifies after acting (`rmrf` result, `countFiles`
  before/after, permission bits re-read) and records it in a report.

## Commit identity (do this before your first commit)

This repository is public and is pushed under a **personal** GitHub identity:

```bash
cd ~/Dev/asb-mods
git config user.name  "Avneet Singh Bindra"
git config user.email "avneetbindra180691@gmail.com"     # the address linked to avneetsb
git remote -v                                            # origin git@github.com:avneetsb/asb-mods.git
git log -1 --format='%an <%ae> / %cn <%ce>'              # author AND committer must match
```

A wrong address does not fail anything — the commit just lands unlinked (or linked to the wrong
account), and fixing it later means rewriting history. Check `git log --format='%ae' | sort -u` after
any rebase or cherry-pick from another machine.

## Public-repository hygiene (non-negotiable)

| Rule | Why |
| --- | --- |
| No employer or client names, internal hostnames, internal model endpoints, internal package scopes — in **any** committed byte, including JSON comments, exclusion reasons and commit messages | history purge mechanics cannot fix a habit; the November 2026 purge existed because committed metadata named internal systems |
| The machine/employer term list stays in gitignored `shared-core/tooling/policy.local.json` | the *scan* ships, the *vocabulary* does not |
| No secrets in `shared-core/`, fixtures, reports or tests. Values live only in `~/.config/asb-mods/env/secrets.env` | an archive of an agent tree would otherwise capture them |
| Never commit `~/.config/asb-mods` output (`backups/`, `reports/`, `state.json`) or a tarball | those are machine state, some of it containing paths you don't want public |
| Scan before you push | see the checklist below |

```bash
# staged-diff scan: author home paths and obvious internal vocabulary
git diff --cached | grep -nEi "$HOME|corp\.|\.internal|vpn|sso|<registry-host>|[a-z]+\.vip\." | head -20
# lib/fsx.js exposes the same predicate the vendoring scan uses:
node -e "const X=require('./lib/fsx');const P=require('./lib/paths');\
console.log(X.mentionsHomeDir(require('fs').readFileSync(process.argv[1],'utf8'), P.HOME))" <file>
```

Empty output is the pass condition. `lib/detect.js`'s `scanProtected` and `tools/vendor.js --dry-run`
apply the same idea to trees.

## Commit style

Conventional Commits with a scope, imperative subject, and a body that explains *why*:

```bash
git log --oneline -8                       # match the existing shape
# feat(tooling): vendor and restore every removable artifact class under a personal-only scope policy
# fix(brew): include core rows in --scope=required
```

One logical change per commit. If a change touches payload *and* code, say so in the body — the
release notes are built from these subjects.

## Change recipes

| You want to… | Touch | Must also do |
| --- | --- | --- |
| add a settings key | `config/settings-schema.json` → `properties`, then the agent fragment | suite asserts every fragment key exists in the schema; add a fixture assertion that it merges |
| add a hook | `shared-core/hooks/hooks.json` (+ a script under `hooks/bin/`) | `asbmods hooks` twice: `registered` then `up-to-date`; page 10's verify block |
| add a secret variable | `shared-core/env/secrets.env.template` (comment line + `NAME=""`) | confirm masking behaviour for its name; `asbmods secrets --rotate-secrets` |
| add a brew row | `shared-core/brew/formulae.csv` (pipe-delimited) + `deps.json` if it's tooling | `asbmods brew` plan shows it present/missing correctly; CSV consistency test stays green |
| add an npm global | `shared-core/npm/manifest.json` (`packages[]`) + `global_install_command` | probe path tolerates a missing/unreachable name |
| ship a personal tooling artifact | `node tools/vendor.js` → regenerates `shared-core/tooling/` + `manifest.json` | allow-list it in `policy.json` only if you authored it; parity test green |
| add an artifact class | `lib/tooling.js` `CLASSES` (+ `denyBundles` where needed) | the four steps on [page 07](07-personal-tooling-vendoring.md#adding-a-new-artifact-class) |
| protect something new | `PROTECT_NAMES` in `lib/detect.js` | a fixture entry under `protected[]` proving it survives removal (page 08's rules) |
| add a phase | wire it in `install.js` `main()`, record into `state.json`, print in the Summary | document it in page 03 and page 04 in the same commit |
| change CLI flags | `parseArgv` + `HELP` text | page 04's flag table in the same commit — it is the reference |

## Pre-commit checklist

```bash
npm test                                  # 33 tests, ~36 s — must be green
node tools/vendor.js --dry-run            # nothing unexpected would start shipping
git status --porcelain                    # no stray archives/reports/tarballs staged
git diff --cached | grep -nEi "$HOME|corp\.|<registry-host>|[a-z]+\.vip\." | head   # must print nothing
git diff --cached --stat                  # docs updated alongside code? (see table above)
git commit
```

If a change altered observable behaviour, paste the relevant `--dry-run` transcript and the final
Summary block into the PR description. Screenshots of terminals are fine, but the Summary lines are
what reviewers diff against.

## Pull-request expectations

- `npm test` green, and a **new assertion** for the behaviour you changed.
- Documentation updated in the same PR: this wiki, README if a user-facing command changed.
- No new runtime dependency without an explicit paragraph justifying it.
- Destructive or removal-adjacent changes: include the "user content survives" proof, and show the
  fixture-home rehearsal output.
- Payload-only changes (a vendored extension, a brew row) still run the suite — the parity and shape
  tests are exactly about payload.

## Getting unblocked

Ask in a GitHub issue on `avneetsb/asb-mods` and include: the command you ran, the Summary block,
`asbmods status` output, `node --version`, and whether `ASB_MODS_HOME` / `ASB_MODS_CORE` /
`XDG_CONFIG_HOME` were set. Redact any credential before posting — the log line that surprises people
is `secrets.env` content, which should never be in an issue body.
