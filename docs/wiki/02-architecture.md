# 02 — Architecture

[← 01 Installation](01-installation.md) · [Home](Home.md) · Next: [03 — Phases](03-phases.md)

## The shape of a run

```text
install.js  (bin: asbmods)
   │  parseArgv → command + flags
   │  preflight: node ≥ 18, git present, shared-core found, home target
   │
   ├─ lib/detect.js    Phase 1  inventory + removable/protected classification
   ├─ lib/archive.js   Phase 2  verified backup + git tag            (all|archive)
   ├─ lib/remove.js    Phase 3  scoped deletion of detected artifacts (all|remove)
   ├─ lib/deploy.js    Phase 4  shared-core → agents + vendored tooling (all|install)
   ├─ lib/npmpkgs.js   Phase 4b npm globals: report / install         (all|npm)
   ├─ lib/brew.js      Phase 5  Homebrew plan / install               (all|brew)
   ├─ lib/secrets.js   Phase 6  shell-env wiring + secret collection  (all|env, all|secrets)
   ├─ lib/hooks.js     Phase 7  register the shared hooks with all three tools (all|hooks)
   │
   ├─ lib/restore.js   standalone `reset` (replay a removal report)
   ├─ lib/tooling.js   the class contract shared by vendor.js and deploy.js
   └─ lib/fsx.js, lib/paths.js — primitives every module uses
```

Two commands bypass the pipeline entirely: `status` (reads state, verifies) and `reset`
(replays a removal report). Both are implemented in `install.js` / `lib/restore.js`.

## Design rules the code actually keeps

| Rule | Where it is enforced |
| --- | --- |
| **One entry point.** No phase has its own script; `install.js` wires them. | `install.js` is the only `bin` in `package.json` |
| **Zero runtime dependencies.** No build step, so a checkout is the installer and `npx` works without an install step. | `package.json` has no `dependencies` |
| **Paths relative to the package.** `PKG_ROOT = path.resolve(__dirname, '..')`, `CORE = ASB_MODS_CORE \|\| PKG_ROOT/shared-core`. | `lib/paths.js`; asserted by the suite ("works from a copy of the package") |
| **Config is data.** Phases read `shared-core/**`; adding a skill, prompt, package or bundle is a data change, not a code change. | `lib/deploy.js` (`deployTooling` is fully data-driven) |
| **Detection proposes, the denylist vetoes.** Deletion re-checks protection at delete time and requires an absolute path inside the target home. | `lib/detect.js` `PROTECT_NAMES`, `lib/remove.js` `insideHome` + `isProtected` |
| **Nothing is trusted that can be verified.** Archive completeness, git tag creation, hook-file presence, secrets file mode are all re-read after writing. | `lib/archive.js` (`countFiles`, tag listing), `lib/secrets.js` (mode readback), `install.js status` |
| **Dry-run is a real mode, not a slogan.** Every phase has a `dryRun` branch that returns the same shape without touching disk. | per-module `dryRun` returns; suite asserts no archive and no manifest are created |
| **Machine-independent packaged data.** `{{HOME}}`, `{{STATE_DIR}}`, `{{CORE}}` are resolved at write time; a test fails on any shipped absolute home path and on any unresolved token reaching a live config. | `lib/fsx.js` `resolvePlaceholders`, `lib/deploy.js` `VARS`, `lib/hooks.js` `flatten` |
| **Merge, never replace.** Settings files are deep-merged; keys the package does not mention are left byte-equal, and the pre-merge content is backed up. | `lib/deploy.js` `mergeInto`, `lib/hooks.js` `writePreserving` |

## Placeholder tokens

Three tokens may appear in packaged data and are resolved per run — never shipped as literals:

| Token | Resolves to | Example consumer |
| --- | --- | --- |
| `{{HOME}}` | target home (`ASB_MODS_HOME` or `os.homedir()`) | tooling bundle destinations, hook command paths |
| `{{STATE_DIR}}` | `<XDG_CONFIG_HOME \|\| ~/.config>/asb-mods` | hook commands that point at deployed hook scripts |
| `{{CORE}}` | the installed package's `shared-core/` | diagnostics that cite the source of truth |

`{{NAME}}` is a fourth token, scoped to tooling bundle destinations — the artifact's own name.
It is resolved by `deployTooling`, not by `resolvePlaceholders`.

## Where state lives

`lib/paths.js` derives everything from the target home and `XDG_CONFIG_HOME`:

```text
~/.config/asb-mods/            STATE_DIR
├── state.json                 last command, summarised results, updatedAt; history keeps the last 40 runs
├── inventory.json             the most recent detection result (also copied to reports/)
├── installed-manifest.json    what Phase 4 did, written after each real install
├── last-archive.json          the verified archive record removal refuses to run without
├── agnostic/                  copies of shared-core/agents/agnostic/*.json
├── hooks/                     deployed hook scripts (mode 755), pointed at by registered hooks
├── env/shell-env.sh           the file your rc files source
├── env/secrets.env            mode 600, created interactively, never committed
├── backups/<stamp>/           pi/ claude/ codex/ agents-dir/ dotfiles/ + archive-record.json
├── file-backups/<base>.<hash12>.<iso-ts>   every rewritten config/rc, newest by timestamp
└── reports/                   inventory-<stamp>.json, removal-<stamp>.json, tooling-<ts>.json,
                               npm-<ts>.json, brew-<ts>.json, hooks-<ts>.json, secrets-<ts>.json,
                               restore-<ts>.json
```

Every report is written after the phase it describes, which is what makes `status` verifiable and
`reset` possible. Reports are the audit trail: they name each path, its size, a content-hash prefix
and where the archive copy lives.

## Two directories, deliberately separate

`~/.config/asb-mods` is **installer state** — archives, reports, deployed scripts. `~/.config/asb-mods`
never holds the source of truth; `shared-core/` inside the installed package does. That split is why
you can delete a checkout, reinstall from npx, and still roll back: the archives and reports are not
inside the package.

## How the three tools differ

| | pi | Claude Code | Codex |
| --- | --- | --- | --- |
| Root | `~/.pi` (agent dir `~/.pi/agent`) | `~/.claude` | `~/.codex` |
| Skills land in | `~/.agents/skills` | `~/.claude/skills` | `~/.codex/skills` |
| Prompts land in | `~/.pi/agent/prompts` | `~/.claude/commands` | `~/.codex/prompts` |
| Settings merged | `~/.pi/agent/settings.json` | `~/.claude/settings.json` (incl. `hooks`) | `config.toml` **never rewritten** |
| Hooks mechanism | generated extension `~/.pi/agent/extensions/asb-mods-hooks.ts` | `hooks` map in `settings.json` | `~/.codex/hooks.json` (merged, and itself protected) |
| Custom tooling classes | loose extensions, extension dirs, local packages (`~/.agents/packages`), skills (`~/.agents/skills`), scripts (`~/.agents/scripts`), loose prompts | agents (files *and* dirs), skills, hook dirs, plugin dirs + registry files | skills, prompts, loose top-level files |
| Why `config.toml` is untouched | — | — | it holds live model/auth state; the installer writes `hooks.json` instead and records an explicit `action: 'preserved'` |

## Why each destructive decision is reversible

1. Phase 2 copies each agent directory (following symlinks) and **verifies file counts** before
   reporting `complete: true`; it then tags the repo `asb-backup-<stamp>` and verifies the tag by
   listing it.
2. Phase 3 refuses to run unless that complete record exists for this run (or `last-archive.json`).
3. Each deletion is recorded with type, byte size, a 16-hex-char sha256 prefix and `archivedTo`.
4. `reset` replays a removal report against the newest archive; unanticipated damage is covered by
   restoring whole directories from `backups/<stamp>/`.

Details: [03 — Phases](03-phases.md), [08 — Protection model](08-protection-model.md),
[11 — Updating and rollback](11-update-and-rollback.md).
