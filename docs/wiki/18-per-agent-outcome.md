# 18 — What asb-mods changes on each agent (pi, Claude Code, Codex CLI)

[Home](Home.md)

One command, three very different machines. This page says, per host, **what is written, what actually
changes behaviour the next time that agent starts, what does not change, and the mechanism that explains
the difference**. It describes the shipped package (0.3.x); where the 0.4.0 plan changes an answer, that is
called out at the bottom and nowhere else.

Every "why" below is a mechanism in this repo, not a general claim about the products. Where a capability
is missing because the *host* has no mechanism for it, that is said in those words — it is not something a
future release can fix by writing another file.

## The short answer

| Host | What you get working on next start | What you still have to do |
| --- | --- | --- |
| **pi** | Nearly everything: npm packages registered through `settings.json`, vendored extensions, generated hook extension, prompts, skills, instruction block | Register the locally-authored packages under `~/.agents/packages/` yourself; configure a provider before the enabled model ids mean anything; register MCP servers yourself |
| **Claude Code** | Skills, slash commands, hook entries merged into `settings.json`, env defaults | Run `claude` once first (hooks are presence-gated); install plugin equivalents yourself — there are none here; write `~/.claude/CLAUDE.md` yourself; register MCP servers yourself |
| **Codex CLI** | Instructions (`AGENTS.md` managed block), hooks (`~/.codex/hooks.json`), prompts, skills | Nothing asb-mods can do about models or MCP: `config.toml` is preserved by policy, and Codex has no extension mechanism to receive the 21 pi-side artifacts |

The asymmetry is not neglect. **pi discovers capability from files**; Claude gates much of its capability
behind a plugin/command it must run itself; Codex's capability surface is instructions plus hooks plus
`config.toml`, and `config.toml` is the one file this installer refuses to touch.

## What is identical on all three hosts

Everything below is deployed unconditionally by Phase 4 (`lib/deploy.js`), for each of `pi`, `claude`,
`codex` — the loop is over the host map, not over detected agents:

| Thing | pi | Claude Code | Codex CLI |
| --- | --- | --- | --- |
| Canonical skills (`shared-core/skills/canonical`: caveman, gitnexus, paseo, ponytail) | `~/.agents/skills/<name>/SKILL.md` | `~/.claude/skills/<name>/SKILL.md` | `~/.codex/skills/<name>/SKILL.md` |
| Prompts from one master (`shared-core/prompts/master/asb-mods-standards.md` + `adapters/<host>.md`) | `~/.pi/agent/prompts/` | `~/.claude/commands/` | `~/.codex/prompts/` |
| Shared hook definitions (`shared-core/hooks/hooks.json`, 4 defs) | compiled into an extension | merged into `settings.json` | merged into `hooks.json` |
| Hook scripts (`shared-core/hooks/bin/*.sh`) | deployed under the state dir for all hosts to call |  |  |
| npm globals: one `npm i -g` of 14 packages (`shared-core/npm/manifest.json`) | shared npm prefix |  |  |
| Homebrew formulae under `--install-prereqs` (`shared-core/brew/formulae.csv`: core/tooling/optional) | shared |  |  |
| Agent CLIs under `--install-agents` (routes probed, never guessed) |  |  |  |
| Secrets + shell env, state ledger, removal reports, install lock | `<config>/asb-mods/` |  |  |

Two consequences of that unconditional loop, stated plainly because they surprise people:

- **A host directory can be created for an agent that is not installed.** `deploySkills` calls `mkdirp` on
  each destination, and `lib/fsx.js` `writeJSON()` mkdirps before writing, so a machine with no Codex still
  ends up with `~/.codex/skills/` and `~/.codex/hooks.json`. An orphan directory is not a capability — the
  agent has to exist to read it. Nothing here is harmful; `asbmods detect` simply reports the host absent.
- **Deployment is not registration.** Files landing in a directory changes an agent's behaviour only if that
  agent scans the directory. The next three sections are exactly about which directories each host scans.

## pi — the host this package was built around

### Works out of the box

| What lands | Path | Mechanism that makes it work immediately |
| --- | --- | --- |
| 14 npm packages installed globally (`pi-subagents`, `@abix5/pi-beads`, `@sting8k/pi-vcc`, `pi-advisor-flow`, `pi-browser-harness`, …) | npm prefix | Phase 4b installs them, and `shared-core/agents/tool-specific/pi/settings-fragment.json` declares **33** `packages` entries, which pi reads at session start. Install + declaration together = live capability |
| Vendored extensions (10: `memory-config.ts`, `prompt-recall.ts`, `engram-project-pin.ts`, `engram-review-on-compaction.ts`, `auto-compact.ts`, `auto-private-tags.ts`, `extension-crash-guard.ts`, `herdr-agent-state.ts`, `pi-rtk-optimizer/`, `subagent/`) | `~/.pi/agent/extensions/` | pi loads every file in that directory at session start; a file drop **is** registration |
| Generated hook extension `asb-mods-hooks.ts` (Phase 7, `lib/hooks.js registerPi`) | `~/.pi/agent/extensions/` | Same scan. It is regenerated from `hooks.json`, and re-running the installer reports "already up to date" instead of duplicating |
| Prompts, canonical skills, personal skill bundles, `~/.agents/packages/` payloads | `~/.pi/agent/prompts/`, `~/.agents/skills/`, `~/.agents/packages/` | `~/.agents/skills` is pi's host-agnostic skill root, so one copy serves every session regardless of project |
| Managed instruction block | `~/.pi/agent/AGENTS.md` | Phase 4 appends a marked block and owns only that block; the rest of the file is yours (see [page 17](17-agent-memory-surfaces.md)) |
| Settings keys | `~/.pi/agent/settings.json` | Deep merge: `enabledModels`, `packages`, `extensions`, `toolCallDefaults`, `crossAgent`. Any key the fragment does not name is left exactly as you had it, and the pre-merge file is backed up first |

### Does not work out of the box — and why

| Gap | Evidence in this repo | Why it is a gap | What closes it |
| --- | --- | --- | --- |
| The **11 locally-authored packages** copied to `~/.agents/packages/` (`memory-recall-gate`, `subagent-sync-only`, `tool-surface-gate`, `working-line-rate-off`, …) do nothing | The fragment's own `_note` excludes "locally-authored package paths under `~/.agents/packages` (not published, so useless on a fresh machine)", and the installer **never spawns an agent CLI** — `grep` for a `pi`/`claude`/`codex` process spawn finds none; only `brew`, `npm`, `git`, `node` | pi enables a package by having it *declared* in `settings.json`. Deliberately not declaring unpublished paths is the honest choice — a declaration for a path that does not exist on another machine is a broken setting, not a capability | `pi install ~/.agents/packages/<name>` per bundle you want (that command edits the same settings file the installer merges) |
| The 16 `enabledModels` are inert on a clean machine | The fragment never sets `defaultProvider` and never writes provider entries. `_note`: local provider entries "carry a per-machine baseUrl + apiKey → collected by `asbmods secrets`" | A model id like `localllm-omlx/…` names a provider that does not exist until you configure one. pi falls back to its own default rather than failing, which is why the gap is invisible until a model is missing | `asbmods secrets`, then add the provider entry your machine actually has |
| No MCP server is registered | Nothing under `lib/` writes any MCP config. `lib/detect.js` only *reads* `~/.pi/agent/mcp-adapter.json` to report what exists | Components whose interface is MCP (engram, Mnemosyne, gitnexus, codegraph, headroom) are therefore invisible to the agent even after everything else installs. This package ships **pi-side consumers** of engram/Mnemosyne (extensions above), not the servers | Register them yourself today; plan §2 replaces this with one `asbmods-mcp` stdio command |

## Claude Code

### Works out of the box

| What lands | Path | Mechanism |
| --- | --- | --- |
| Hook entries | `~/.claude/settings.json` | `registerClaude` merges entries for the events its adapters declare, preserving every foreign key and pre-backing-up. `hooks.json` names the command; commands carry `{{STATE_DIR}}`/`{{HOME}}` resolved at registration time, never packaged |
| Env defaults and URL-shaped settings only | `~/.claude/settings.json` | The Claude fragment is deliberately tiny (env defaults plus the path of `<state>/env/secrets.env`); no secret values are ever packaged |
| Canonical skills **plus 9 personal skill bundles** (`graphify`, `investigate-first`, `lean-build`, `megacave`, `migration`, `safe-refactor`, `surgical-patch`, `ultracave`, `verify-and-stop`) | `~/.claude/skills/` | Claude scans its skills directory, so these work — the only non-pi host to receive personal bundles |
| Slash commands | `~/.claude/commands/` | Adapter-generated from the same master prompt file as every other host |

### Does not work out of the box — and why

| Gap | Evidence | Why it is a gap | What closes it |
| --- | --- | --- | --- |
| **Hooks are skipped on a machine where Claude has never run** | `registerClaude`: `if (!X.isDir(P.agents.claude.dir)) return { tool: 'claude', skipped: '~/.claude absent' }` | Merging into a host config the host has not created would invent a schema we do not own. So the very first run on a fresh machine can register nothing for Claude, and the run reports it as `skipped`, not as success | Run `claude` once (or `--install-agents`, then launch it), then re-run the installer — Phase 7 is idempotent |
| **No plugins.** None of the 13 pi-only npm packages has a Claude counterpart, and no Claude plugin is installed or registered | No `claude` process is ever spawned; there is no plugin catalogue in `shared-core` | Plugin installation is a network fetch plus a trust decision the host wants made interactively. 0.3.x has no catalogue to install from, so capabilities like subagents, beads tracking, session compaction and the statusline simply **do not exist** on Claude | Either accept the reduced set, or install equivalents by hand. Plan §3 adds an `asbmods/*` plugin pair with a catalogue this package ships |
| **`~/.claude/CLAUDE.md` is never written** | Finding F11; no code path writes it, and the fixture requires its bytes to survive an install ([page 17](17-agent-memory-surfaces.md)) | Standing instructions in pi's `AGENTS.md` therefore do not reach Claude at all. This is a gap we recorded rather than a policy decision about your content | Symlink or copy the managed block into `CLAUDE.md` yourself until the plan's instruction-sync lands |
| No MCP servers | same as pi: no writer exists | Same consequence: no `asbmods`-provided tools beyond what the CLI gives you natively | Plan §2 |
| Claude's own per-project memory is untouched | `~/.claude/projects/<slug>/memory/**` is in the fixture's protected list | Deliberate: per [page 17](17-agent-memory-surfaces.md), one writer per store. Claude's runtime owns those notes |

## Codex CLI

### Works out of the box

| What lands | Path | Mechanism |
| --- | --- | --- |
| Hook entries | `~/.codex/hooks.json` | `registerCodex` merges per-event arrays, preserving foreign entries. Unlike Claude, **there is no presence gate**: `writeJSON()` creates the file and its parent, so registration succeeds on a machine where Codex was never launched (and leaves an orphan file if it never gets installed) |
| Managed instruction block | `~/.codex/AGENTS.md` | Phase 4 appends its marked block; this is the one instruction file in the memory-surface table the installer owns |
| Prompts, canonical skills, `graphify` bundle, `herdr-agent-state.sh` | `~/.codex/prompts/`, `~/.codex/skills/`, `~/.codex/` | Directory-scanned by the host |
| `config.toml` | — | Read by `lib/detect.js`, **never rewritten**. It is also in the removal denylist, so even `--confirm` cannot archive it |

### Does not work out of the box — and why

| Gap | Evidence | Why it is a gap (and what kind of gap it is) | What closes it |
| --- | --- | --- | --- |
| **No models, no providers, no MCP on Codex** | `lib/deploy.js`: "`config.toml` is TOML and holds live model/auth state — we never rewrite it"; the codex fragment lists it as `strategy: preserved, never rewritten` | Host-config gap, and a deliberate one. A JSON-shaped merge applied to a file holding a working login can destroy the login, and a partially-written `[model]` block is worse than none. Consequence: no `[mcp_servers.*]` entries, so **zero** MCP tools on Codex from this package | Add `~/.codex/config.toml` blocks yourself; plan §2 writes them with a TOML-aware writer |
| **The 21 pi-side artifacts have no Codex counterpart at all** (10 extensions + 11 local packages) | `shared-core/tooling/manifest.json` targets them at `~/.pi/agent/extensions` and `~/.agents/packages` | Not an installer omission: Codex has no extension or package mechanism to receive them. Anything that worked by hooking pi's event loop is simply not expressible on Codex | Nothing. Rewrite as hooks or instructions, or don't expect it there |
| **No npm global package is usable on Codex** | `global_install_command` installs 13 pi packages + `ccstatusline` | They are pi extensions that happen to travel by npm. They exist on the machine and do nothing on this host | Accept, or find a host-native equivalent |
| Personal skills are thinner here | `shared-core/tooling/codex/` vendored only `loose/` + one skill; the rest reach Codex as canonical `SKILL.md` files | A canonical skill is instructions. Its pi-side tooling (scripts, widgets, gate hooks) does not travel | Accept: instructions-only is the honest description of what Caveman/Paseo mean on Codex |

## Why the three answers differ — mechanism, in one table

| Axis | pi | Claude Code | Codex CLI |
| --- | --- | --- | --- |
| How new capability is discovered | directory scan at session start (`extensions/`, `skills/`, `prompts/`) plus `packages` declared in `settings.json` | skills/commands by scan; **plugins** through its own install + trust step; hooks and env in `settings.json` | instructions (`AGENTS.md`), `hooks.json`, prompts/skills by scan; models and MCP only in `config.toml` |
| What a file drop buys you | almost everything | skills and slash commands | instructions and hooks |
| Does registering anything require running a host command? | only for unpublished local packages (`pi install <path>`) | yes, for plugins | no — but the surface it can receive is smaller |
| What asb-mods may safely merge, and why | `settings.json`: JSON, keys we name are ours, everything else preserved | `settings.json`: same, and presence-gated so we never invent the host's config | `hooks.json`: JSON, safe. `config.toml`: TOML + live auth, therefore **never** |
| Net effect | the reference host | content parity, behaviour partial | instructions and hooks only |

## Closing the remaining gaps today

```bash
asbmods doctor                    # what is even present on this machine (exit 1 = gaps, each with its fix)
asbmods --install-prereqs         # brew formulae from shared-core/brew/formulae.csv, announced first
asbmods --install-agents          # install a missing pi/claude/codex CLI from probed routes
asbmods secrets                   # per-machine credentials; nothing secret is packaged
claude                            # once, so ~/.claude exists — then:
asbmods                           # re-run: Phase 7 now registers Claude's hooks instead of skipping

pi install ~/.agents/packages/<name>     # pi: enable a locally-authored bundle you copied
# Codex models/MCP and Claude CLAUDE.md are hand-edits today; see the gaps above
```

`asbmods status` then tells you per host what it can actually see, and it distinguishes "absent" from
"present but did not accept the change". `asbmods verify-core` proves the payload you deployed is the
payload that was packaged (`verify-core --json` for machines).

## Planned in 0.4.0, **not** true of the shipped package

These are plan rows (`plan/2026-11-21_agent-compat-040.md`), listed so nobody reads them as current
behaviour:

- One `asbmods-mcp` stdio command writing each host's native MCP config from `shared-core/mcp/servers.json`,
  byte-identical command string on all three hosts (plan §2).
- Per-host parity target: pi 4 packages + hooks; Claude 2 plugins + hooks + `mcp.json` with four
  `asbmods/*` entries; Codex 3 hooks + four `[mcp_servers.asbmods-*]` blocks in `config.toml` (plan §3) —
  which requires the TOML-aware writer that does not exist yet.
- One shared Mnemosyne bank on loopback so a recollection saved on one host is readable from another
  (plan §2; the design rationale is at the end of [page 17](17-agent-memory-surfaces.md)).
- `shared-core/config/hosts.json` as a capability matrix, replacing host-name literals in code (plan §2 Q1),
  including in the destructive phase, so "what each host accepts" is data rather than scattered branches.

## What proves the claims on this page

| Claim | Machine check |
| --- | --- |
| Canonical skills, prompts and hook registration happen for all three hosts | Phase tests run the installer against fixture homes for each host and assert destinations per host map |
| Pi's generated hook extension is idempotent, and foreign entries survive on the other two hosts | Phase 7 tests re-run registration and compare the merged documents |
| No memory surface is touched, and `~/.claude/CLAUDE.md` survives byte-identical | `MEMORY_SURFACES` in `test/install.test.js`: paths are laid down, hashed, a real install runs, every hash must be unchanged |
| Nothing packaged names a real machine | token lint (194 files, 59 placeholders) fails on any absolute home or unknown placeholder |
| What ships is what the docs say ships | `scripts/check-pack-coverage.cjs` fails the suite when a §1 path or the tarball count in [page 15](15-release-and-publishing.md) drifts from `npm pack` |
| `--json` output stays parseable for automation | the `O2` envelope contract tests, comparing the documented schema against the live CLI |

If you change any mechanism described here, the page is yours to update: `lib/docsync.js` treats wiki
claims as assertions, and a page that stops matching behaviour fails `npm test`.

Related pages: [phases](03-phases.md), [hooks reference](10-hooks-reference.md),
[agent memory surfaces](17-agent-memory-surfaces.md), [shared-core reference](06-shared-core-reference.md),
[vendored personal tooling](07-personal-tooling-vendoring.md), [troubleshooting](12-troubleshooting.md).
