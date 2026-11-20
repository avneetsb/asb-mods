# 07 — Vendoring personal tooling

[← 06 shared-core reference](06-shared-core-reference.md) · [Home](Home.md) · Next: [08 — Protection model](08-protection-model.md)

Phase 3 deletes personal extensions, skills and scripts on a cutover run. If the package did not
**ship** those same artifacts, a fresh machine would come back with hooks and settings but none of the
tooling — which is exactly the defect this subsystem exists to prevent, and the reason a test fails
when a class becomes removable but stays unvendored.

## The contract

```text
what Phase 3 may delete   ⇐  lib/tooling.js CLASSES (11 classes)
what the package ships    ⇐  shared-core/tooling/ + manifest.json (46 bundles)
enforcement               ⇐  test/install.test.js + tools/vendor.js --dry-run
```

`lib/tooling.js` defines **11 artifact classes** — the map between an agent-home source directory, a
bundle root inside `shared-core/tooling/`, a layout and a destination template:

| Class | Bundles shipped | Layout | Notes |
| --- | --- | --- | --- |
| `piExtensions` | 10 | 8 `flatten`, 2 `dir` | loose `.ts`/`.js` extensions into `~/.pi/agent/extensions/`; the 2 dirs are self-contained extension packages |
| `piPackages` | 10 | `dir` | locally authored pi packages (kept as directories so their own `package.json` survives) |
| `agentSkills` | 9 | `dir` | skills under the shared agent-skills root (`~/.agents/skills/`) |
| `claudeSkills` | 9 | `dir` | `~/.claude/skills/` |
| `codexSkills` | 1 | `dir` | `~/.codex/skills/` |
| `codexLooseFiles` | 2 | `flatten` | loose files in the Codex root (`AGENTS.md`, one status script) |
| `agentScripts` | 5 | `flatten` | standalone Python/shell helpers (`canary.py`, `cross_session_proof.py`, `fresh_pi_sessions.py`, `rtk_savings_sample.py`, `splice_policy.py`) |
| `claudeAgents` | 0 | `dir` | class exists (18 candidates found) but **all were excluded** as employer-internal agent definitions |
| `claudePlugins` | 0 | — | denied: plugin installs and registries belong to the plugin manager, not this package |
| `claudeHooks` | 0 | — | denied: hook directories belong to third-party plugins; the package registers its own hooks instead |
| `agentsPackages` | 0 | — | class defined for completeness; nothing personal found to vendor |

Current manifest totals: **46 bundles / 159 files / 1,236,301 bytes**, `droppedFiles: 0`,
`skippedProtected: 2`, and **14 exclusion groups covering 193 candidate items** — each with a written
reason. Bundle counts are why `deployTooling()` can restore a machine: every removable artifact class
that ships content has at least one bundle, and the four zero-bundle classes are zero *by policy*,
documented in `exclusions`.

## `policy.json` — what may ship

```text
shared-core/tooling/policy.json
  personalOnly: true              # anything not personally authored is out
  skipPathSegments: [examples, .unipi, .codex, artifacts, _archive]
  dropInsteadOfBundle: [(^|/)test/, (^|/)docs/, (^|/)references/, \.(md|txt)$, CHANGELOG, IMPROVEMENT-PLAN]
  scan: { homePath, internalTermsFile: "policy.local.json", note }
  denyBundles: [11 entries: { match, reason }]
  personalSkills: [9 names]       # the allow-list that makes a skill "personal"
  personalCodexFiles: [AGENTS.md, herdr-agent-state.sh]
  restoreNote / unlistedNote / denyBundlesNote
```

`personalSkills` is an **allow-list, not a deny-list**:
`graphify`, `investigate-first`, `lean-build`, `megacave`, `migration`, `safe-refactor`,
`surgical-patch`, `ultracave`, `verify-and-stop`. Anything not named there is treated as third-party
and excluded — that single rule accounts for the largest exclusion groups (31 agentSkills, 55
claudeSkills, 68 codexLooseFiles, 3 codexSkills).

`denyBundles` carries 11 explicit refusals with reasons — dependency-tree installs, plugin registries,
test fixtures with an absolute author-home path baked in, and packages whose source names internal
systems (the employer-vocabulary rule below). `dropInsteadOfBundle` keeps a vendored package lean:
tests, docs, reference material and changelogs stay out of the bundle while the code stays in.

### The vocabulary rule

`scan.homePath` is the author's home path and `scan.internalTermsFile` points at
**`policy.local.json`, which is gitignored** (`.gitignore:9`). So the machine-specific and
employer-specific term list — the strings that must never leave a machine — lives only on the author's
disk, while the *mechanism* (scan every candidate file before bundling) ships and is auditable.
A candidate whose content matches either list is refused and recorded in `exclusions` with a generic
reason. The same rule is applied to committed metadata: exclusion reasons are written so that they
describe the refusal **without quoting the term** ("Source names employer-internal model refs and
paths", never the ref itself). Vendored code that legitimately names its host agents is exempt from
this scan — hence the `shared-core/tooling/` skip in the test guard.

## `manifest.json` — generated inventory

| Key | Contents |
| --- | --- |
| `generatedAt`, `generator` | timestamp; always `tools/vendor.js` |
| `policy` | `shared-core/tooling/policy.json` |
| `note` | states the rules in one sentence, including what is never vendored |
| `totals` | `{ bundles, files, bytes, droppedFiles, skippedProtected, exclusions }` |
| `byClass` | per-class counts |
| `exclusions[]` | `{ cls, count, reason }` — 14 groups, 193 items |
| `bundles[]` | `{ cls, name, layout, files, bytes, source?, dest }` — the deploy instructions |

`deployTooling()` reads only `bundles`; a bundle whose destination template contains `{{HOME}}` (and
`{{NAME}}` for per-artifact classes) is expanded by `resolvePlaceholders()` at deploy time, which is
what makes the same manifest deploy into a fixture home during tests and a real home during install.

## Regenerating the bundle

```bash
node tools/vendor.js --dry-run     # report only: what would ship, what would be refused
node tools/vendor.js               # refresh content in place
node tools/vendor.js --clean       # delete and rewrite the bundle tree (keeps gitignored policy.local.json)
npm test                           # class/vendoring parity tests must stay green
```

`--clean` deliberately keeps `policy.local.json` because it is the gitignored local override; losing it
would silently disable the vocabulary scan.

### Adding a new artifact class

1. Add the class to `CLASSES` in `lib/tooling.js`: agent-home source dir, bundle root under
   `shared-core/tooling/`, `layout: 'dir' | 'flatten'`, destination template with `{{HOME}}`.
2. Add a `denyBundles` entry if some members of the class must never ship (plugin-managed installs,
   credential-bearing artifacts).
3. `node tools/vendor.js --dry-run` — confirm the new class appears with the expected bundle count and
   that every refusal has a reason you would accept reading in public.
4. `node tools/vendor.js && npm test` — the parity test fails if the class is removable but no bundle
   ships, which is the exact failure mode this exists to catch.

## Failure modes and what they mean

| Symptom | Meaning | Fix |
| --- | --- | --- |
| parity test names a class | Phase 3 can delete artifacts of that class but nothing ships | vendor it (steps above) or make the class non-removable |
| `manifest.json` byte total jumps | something vendored a dependency tree or a docs folder | check `bundles[]` for the class, tighten `dropInsteadOfBundle` |
| exclusion reason reads like an internal system name | metadata leaked vocabulary — the exact bug fixed during the November purge | rewrite the reason generically, re-run with the term in `policy.local.json` |
| a reinstalled extension cannot find its files | destination template lost its `{{HOME}}`/`{{NAME}}` placeholders during an edit | restore the template; `deployTooling()` expands them, never a literal path |
