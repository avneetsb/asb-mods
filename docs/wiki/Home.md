# `@asbmods/install` — Wiki

Documentation for the package that consolidates one person's agent tooling —
extensions, packages, skills, hooks, prompts, scripts, shell env, secrets and the Homebrew
inventory — into a single self-contained installer that reproduces it on any machine.

Three agents are in scope: **pi**, **Claude Code** and **Codex**. Everything else (vendor
marketplaces, npm globals, Homebrew) is reinstalled from upstream, not redistributed here.

---

## Pages

| Page | What it answers |
| --- | --- |
| [01 — Installation](01-installation.md) | Clone / `npx` / global / `npm link`, first run, install-method trade-offs |
| [02 — Architecture](02-architecture.md) | How a run is organised, why paths resolve relative to the package, where state lives |
| [03 — Phases](03-phases.md) | What each of the nine phases actually does, in order, with its inputs and outputs |
| [04 — CLI reference](04-cli-reference.md) | Every command, flag and environment variable; what each flag is wired to |
| [05 — Code components](05-components-lib.md) | `install.js`, every `lib/*.js` module, `tools/vendor.js`: API and responsibility |
| [06 — shared-core reference](06-shared-core-reference.md) | Every packaged data file: schema, example, who reads it |
| [07 — Vendored personal tooling](07-personal-tooling-vendoring.md) | The parity contract, the publish policy, `tools/vendor.js`, adding a bundle |
| [08 — Protection model](08-protection-model.md) | The denylist, the falsifiable "protection hole" check, what removal never touches |
| [09 — Secrets and shell env](09-secrets-and-env.md) | `secrets.env.template`, masking, mode 600, rc wiring, rotation |
| [10 — Hooks reference](10-hooks-reference.md) | The four shared hook definitions and how each tool registers them |
| [11 — Updating and rollback](11-update-and-rollback.md) | Update per install method, migrations, the three rollback levels |
| [12 — Troubleshooting](12-troubleshooting.md) | Symptom → cause → fix, including the failures this package has actually had |
| [13 — Testing](13-testing.md) | What `npm test` proves, fixture homes, how to add a case |
| [14 — Contributing](14-contributing.md) | Dev loop, patch shape, documentation rules, review checklist |
| [15 — Release and publishing](15-release-and-publishing.md) | Version, tags, `npm publish` preconditions, post-publish verification |
| [16 — FAQ](16-faq.md) | Short answers to the questions this repo always gets |

---

## What it is, in one paragraph

`install.js` (bin: `asbmods`) is the only entry point. With no arguments it runs a pipeline:
**detect** what the three agents have → **archive** it to a verified, timestamped backup and tag
the repo → **remove** the custom tooling that this package now owns (opt-in, `--allow-destructive`)
→ **install** `shared-core/` into each agent (skills, prompts, hook scripts, settings *merge*,
agnostic defaults, vendored personal tooling) → **npm** and **brew** inventory reports →
**env** and **secrets** propagation → **hooks** registration for all three tools. Each phase also
runs standalone. Detection proposes; a denylist vetoes; removal re-checks the veto at deletion time
and refuses anything outside the target home. `status` verifies the result, `reset` undoes removal.

## What makes it different from a dotfiles repo

| Concern | How this package handles it |
| --- | --- |
| Machine independence | Packaged config uses `{{HOME}}`, `{{STATE_DIR}}`, `{{CORE}}`; a test fails if any token reaches a live config file, and another fails if any absolute home path is shipped |
| Reproducibility without a second machine | Everything removal is allowed to delete is vendored under `shared-core/tooling/` and redeployed by the installer — see [page 07](07-personal-tooling-vendoring.md) |
| Not leaking private/employer material | Publish policy excludes third-party and employer content; the vocabulary that identifies it stays in a gitignored `policy.local.json`, so the mechanism ships and the terms do not |
| Destructive-but-safe | Verified archive before any deletion, live-state denylist, protection re-check at delete time, per-artifact removal report with content hashes, `reset` to put it back |
| Proof, not claims | `npm test` builds a fixture home and executes the phases for real — including the destructive one — then asserts every protected path survived |

## Numbers at a glance

As of `v0.1.0` (2026-11-20). Re-run the command in the right-hand column; these figures move as
tooling is added, and a stale number in the docs is a bug (see [page 14](14-contributing.md)).

| Figure | Value | Verify with |
| --- | --- | --- |
| Vendored tooling bundles | 46 (159 files, ~1.2 MB) | `node tools/vendor.js --dry-run` |
| Vendored classes | 7 (`piExtensions`, `piPackages`, `agentScripts`, `agentSkills`, `claudeSkills`, `codexSkills`, `codexLooseFiles`) | `python3 -c "import json;print(json.load(open('shared-core/tooling/manifest.json'))['byClass'])"` |
| Recorded publish exclusions | 14 groups (name-digested, each with a reason) | `python3 -c "import json;print(len(json.load(open('shared-core/tooling/manifest.json'))['exclusions']))"` |
| Homebrew inventory | 367 rows — 273 formulae, 94 casks | `tail -n +2 shared-core/brew/formulae.csv \| wc -l` |
| npm globals in manifest | 14 packages | `python3 -c "import json;print(len(json.load(open('shared-core/npm/manifest.json'))['packages']))"` |
| Shared hook definitions | 4, each with pi / claude / codex adapters | `python3 -c "import json;print(list(json.load(open('shared-core/hooks/hooks.json'))['hooks']))"` |
| Canonical skills | 4 (`caveman`, `gitnexus`, `paseo`, `ponytail`) | `ls shared-core/skills/canonical` |
| Migrations | 3 entries, each with a backing file | `ls shared-core/config/migrations` |
| Test suite | 62 test cases, verdict line `62 passed, 0 failed` | `npm test` |

## Start here

```bash
git clone git@github.com:avneetsb/asb-mods.git
cd asb-mods
node install.js --dry-run     # read the plan: "removable: N", "protected: M"
node install.js status        # detection detail + what is already deployed
```

Nothing destructive happens without `--allow-destructive`, and even then removal refuses to run
before a verified archive exists. [Next: installation →](01-installation.md)
