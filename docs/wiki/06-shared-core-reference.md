# 06 — shared-core reference

[← 05 Code components](05-components-lib.md) · [Home](Home.md) · Next: [07 — Vendoring personal tooling](07-personal-tooling-vendoring.md)

`shared-core/` **is** the payload: everything Phase 4 deploys, and every fact Phases 5–7 act on.
It is data plus two shell scripts — no code imports it at runtime except through the phase modules.

```text
shared-core/
├── agents/agnostic/{defaults,keybindings,source-map}.json      reference cards (not deployed as config)
├── agents/tool-specific/{pi,claude,codex}/settings-fragment.json   merged into live settings
├── config/{settings-schema,agent-overrides,migrations}.json    validation + per-agent cards + migrations
├── config/agent-overrides/{pi,claude_code,codex}.json
├── config/migrations/001-pi-hooks-to-claude-hooks.json         003-env-vars-consolidation.json
│                                                              004-brew-inventory-deployment.json
├── env/{shell-env.sh,secrets.env.template}
├── hooks/hooks.json + hooks/bin/{asb-env-check.sh,asb-secrets-check.sh}
├── npm/{manifest.json,.npmrc}
├── brew/{formulae.csv,deps.json}
├── prompts/master/asb-mods-standards.md + prompts/adapters/{pi,claude,codex}.md
├── skills/canonical/{caveman,gitnexus,paseo,ponytail}/SKILL.md
└── tooling/{policy.json,policy.local.json*,manifest.json,…}    → page 07
```

`policy.local.json` is gitignored (`~/.agents/config-backups/**`-style local override, see page 07).

## Who reads what, and the packaged inventory (`MANIFEST.sha256`)

Every file under this directory ships in the tarball, so two facts about it are asserted by tests
rather than trusted:

**One owner per path.** `lib/payload.js` declares, for each payload path, the single module that
deploys or applies it (plus the modules that merely inspect it — `lib/detect.js` reports on
everything it can find, which is not ownership). For the vendored `tooling/` tree ownership is proven
structurally: `tooling/manifest.json` enumerates 46 bundles, and every file under `tooling/` must sit
under one of them, so a vendored artifact that no bundle deploys fails the suite instead of shipping
dead weight.

**What nothing reads is declared, not hidden.** `lib/payload.js` `UNREAD` lists the payload paths no
module reads today: `config/` (`settings-schema.json`, `agent-overrides.json` and its directory,
`migrations.json` and its directory), `prompts/adapters/`, `brew/deps.json` and
`prompts-sync-guide.md`. That list is a ratchet — a test fails if a payload file falls outside both
the owned set and the unread list, and also if a listed prefix stops covering anything, so it can only
shrink as those files get wired up or removed.

**The payload you deploy is the payload that was packaged.** `MANIFEST.sha256` holds one
`<sha256>  ./<posix path>` line per payload file (the inventory itself is excluded).
`node tools/make-manifest.js` regenerates it; `npm test` runs `--check`, so editing a payload file
without regenerating fails the suite instead of shipping an inventory that lies.
[`asbmods verify-core`](04-cli-reference.md) checks a core directory against it read-only and reports
`missing` / `changed` / `untracked`, treating an absent or malformed inventory as a failure — without
it there is no chain to verify against.

## `agents/agnostic/` — the three reference cards

| File | Top-level keys | Role |
| --- | --- | --- |
| `defaults.json` | `_description`, `version`, `code_search`, `commit_style`, `shell_envars`, `package_management` | Tool-agnostic policy: which search tool to prefer, commit-message style, env-var conventions, package-manager rules. Deployed by `deployAgnostic()` as a readable document, **not** merged into any agent's settings |
| `keybindings.json` | `_description`, `common_shortcuts`, `mcp_tool_access` | Shortcut conventions shared across the three tools, plus how MCP tools are addressed |
| `source-map.json` | `_description`, `pi`, `claude_code`, `codex`, `shared_state` | Maps each concept (skills, prompts, hooks, settings) to where it lives per tool. This is the file to read when porting something between agents |

`_description` keys are annotations: `stripNonSettingsKeys` drops any key matching
`/^(_|purpose$|installInstructions$|notes$|_description$)/` before a fragment reaches a live config.

## `agents/tool-specific/*/settings-fragment.json` — Phase 4 merge

One fragment per agent. `deploySettings()` merges each into the live file with `mergeInto`:

| Agent | Target | Behaviour when target missing |
| --- | --- | --- |
| pi | `~/.pi/agent/settings.json` | warns `pi settings.json not found — skipped`, records nothing destructive |
| Claude Code | `~/.claude/settings.json` | warns `claude settings.json not found — skipped` |
| Codex | `~/.codex/config.toml` | **never written.** Recorded as `{ action: 'preserved', reason: 'TOML config holds live model/auth state; asb-mods writes hooks.json instead' }` |

Merge semantics (arrays as sets for `packages` / `extensions`, replacement elsewhere, changes recorded
only when the serialisation differs): [page 05](05-components-lib.md#libdeployjs--phase-4). A test
asserts every fragment key exists in `config/settings-schema.json` → `properties`, so a fragment
cannot invent settings silently.

## `config/`

- **`settings-schema.json`** — `$schema`, `title`, `description`, `type`, `properties`. The whitelist
  that fragments are validated against, and the documentation of what asb-mods considers legal settings.
- **`agent-overrides.json`** — `_description`, `version`, `agents` keyed exactly `pi`, `claude_code`,
  `codex` (asserted by the suite). The registry of which agent has which deliberate deviation.
- **`agent-overrides/<agent>.json`** — per-agent reference cards: model pin, credential source note,
  MCP registration path, package list. `pi.json` names the local inference provider and model id, the
  `~/.pi/agent/mcp-adapter.json` registration file and the installed pi package set. These cards are
  **documentation of intent**, not deployment input — the values that actually ship come from
  fragments, `env/`, and what you type at Phase 6.
- **`migrations.json`** + `migrations/*.json` — `_description`, `version`, `migrations`, `_note`;
  three recorded migrations: `001-pi-hooks-to-claude-hooks.json`, `003-env-vars-consolidation.json`,
  `004-brew-inventory-deployment.json` (number `002` was retired; the sequence is not renumbered, so a
  gap is expected). Each migration file records what moved from where to where — read them before
  hand-editing anything the installer owns.

## `env/`

**`shell-env.sh`** — deployed to `<state-dir>/env/shell-env.sh` and sourced from a marked block in
`.zshrc`, `.bashrc`, `.zshenv`. It exports the machine-independent contract every tool in this package
expects (13 variables):

```text
SSL_CERT_FILE  REQUESTS_CA_BUNDLE  CURL_CA_BUNDLE          TLS trust for Node + Python tooling
PI_DEFAULT_PROVIDER  PI_DEFAULT_MODEL  LOCALLLM_OMLX_BASE_URL  pi model pin + endpoint
PI_PERMISSION_MODE                                          default permission mode
MNEMOSYNE_LLM_BASE_URL  MNEMOSYNE_LLM_MODEL  MNEMOSYNE_LLM_EXTRA_BODY  MNEMOSYNE_MCP_BANK
ENGRAM_DATA_DIR                                               memory store location
RTK_DB_PATH                                                   shell-output filter database
```

Secrets are deliberately absent — they live only in `secrets.env` (mode 600). [Page 09 →](09-secrets-and-env.md)

**`secrets.env.template`** — the prompt script. Each entry is a comment line (becomes the hint shown
at the prompt) followed by `NAME=placeholder`. `templateVars()` parses it into
`{ name, placeholder, hint }`; names matching `KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL` are
prompted with masked input.

## `hooks/`

**`hooks.json`** — the single source of hook truth:

| Key | Contents |
| --- | --- |
| `version`, `description` | schema version and intent |
| `placeholders` | `{{HOME}}`, `{{STATE_DIR}}`, `{{CORE}}` — resolved by `flatten()` at registration time |
| `hooks` | the four shipped hooks (below) |
| `retired` | why removed generators/hooks are gone; read-only documentation |

| Hook name | `when` | `trigger_event` | Purpose |
| --- | --- | --- | --- |
| `session_style_reminder` | `on_user_prompt` | `UserPromptSubmit` | injects the terse-answer style rule |
| `environment_preflight` | `on_session_start` | `SessionStart` | runs `bin/asb-env-check.sh` to surface missing env/TLS setup |
| `secrets_hygiene` | `on_stop` | `Stop` | runs `bin/asb-secrets-check.sh` to catch secrets about to be written into tracked files |
| `paseo_terminal_display` | `post_tool_use` | `PostToolUse` | keeps terminal agent state visible |

**`hooks/bin/`** — `asb-env-check.sh`, `asb-secrets-check.sh`. Deployed by `deployHookBin()` (mode
755) into the state dir; hook commands reference them through `{{STATE_DIR}}`, never through a repo path.
Registration mechanics, per-tool wiring and the pi extension adapter: [page 10](10-hooks-reference.md).

## `npm/`

**`manifest.json`** — `_description`, `version`, `packages[14]`, `global_install_command`.
`global_install_command` is literally `npm i -g pi-one-ui@latest … @buyong/pi-codex-computer-use@latest`.

| Package | Purpose | Package | Purpose |
| --- | --- | --- | --- |
| `pi-one-ui` | single-file deployment utility | `pi-advisor-flow` | advisor flow for pi |
| `pi-localllm-provider` | local LLM provider for pi | `@abix5/pi-beads` | task tracking (beads) |
| `pi-hashline-edit-pro` | enhanced hashline editing | `pi-btw` | side conversations |
| `ccstatusline` | Claude Code status line | `pi-animations` | TUI animations |
| `pi-subagents` | subagent orchestration | `@sting8k/pi-vcc` | session compaction |
| `pi-browser-harness` | browser automation | `@janvitos/pi-better-prompt` | better prompt UX |
| `@narumitw/pi-stamp` | timestamp utility | `@buyong/pi-codex-computer-use` | computer use for Codex |

**`.npmrc`** — `registry=https://registry.npmjs.org/` plus a comment stating that no private-registry
or scoped auth config ships in this package (that belongs in the developer's own `~/.npmrc`).

## `npm/agents.json` — where the agent CLIs come from

`manifest.json` lists what this package installs *for* the tools; `agents.json` lists the tools
themselves — third-party CLIs that this package configures in depth and deliberately never ships. It
drives `doctor`'s agent rows and everything `--install-agents` does.

```json
{ "tool": "pi", "bin": "pi", "probeCommand": "pi --version",
  "routes": [ { "kind": "brew-formula", "package": "pi-coding-agent",
                "command": ["brew", "install", "pi-coding-agent"], "note": "…" }, … ] }
```

| Field | Meaning |
| --- | --- |
| `tool` / `bin` | Display name, and the executable looked for on PATH. `doctor` prints a row per tool as `<tool> CLI` |
| `probeCommand` | The human-visible way to check the install worked; not used to decide presence |
| `routes[]` | Preference order. The first route whose probe succeeds is the one offered; if none resolve, the tool is reported `unresolvable` and nothing is attempted |
| `routes[].kind` | `brew-formula`, `brew-cask`, `npm-global` or `native` — the four kinds `lib/agents.js` implements, enforced by a test so a new kind cannot ship silently unimplemented |
| `routes[].command` | Run verbatim, with no shell interpretation except in `native`, where the vendor script needs one |
| `routes[].note` | Why this route exists, in the report and in `doctor`'s fix line |

| Tool | Routes, in order | Probe |
| --- | --- | --- |
| `pi` | `brew install pi-coding-agent`, then `npm i -g @earendil-works/pi-coding-agent` | `brew info --json formula`, `npm view` |
| `claude` | `npm i -g @anthropic-ai/claude-code`, then Anthropic's `curl -fsSL https://claude.ai/install.sh \| bash` | `npm view`; the native route is reported **unprobed** because no availability check for a vendor script exists |
| `codex` | `brew install --cask codex`, then `npm i -g @openai/codex` | `brew info --json cask`, `npm view` |

Three policy lines live in the file itself, because they are the reason it exists: nothing here is
vendored (no source copied into `shared-core/tooling/`, none of it a runtime dependency); routes are
used only when the tool is absent and only under `--install-agents`, with the exact command announced
first; and availability is probed rather than guessed, so a renamed formula or an unreachable registry
is *reported*. Its `_verified` line records when the route names and versions were last checked against
the public registry and Homebrew metadata — re-run those checks when you edit a route, the same duty as
[brew inventory](#brew).

## `brew/`

**`formulae.csv`** — **pipe-delimited**, columns `name|type|version|dependency-type|used-by`,
367 rows: type `formula` 273 / `cask` 94; dependency-type `optional` 339 / `core` 23 / `tooling` 5.
Parsed by `detect.parseFormulae()` (shared with Phase 1), planned by `lib/brew.js`.

**`deps.json`** — the reverse map for the tooling that actually needs brew: keys
`pi-coding-agent`, `rtk`, `graphify`, `node`, `gitnexus`, `git-lfs`, `ripgrep`, plus `_stats`.
Each value names the formula/cask and why it is needed, so a missing binary can be explained without
reading `formulae.csv`.

## `prompts/` and `skills/canonical/`

- **`prompts/master/asb-mods-standards.md`** — the canonical standards text.
- **`prompts/adapters/{pi,claude,codex}.md`** — per-agent renderings of the same rules, deployed into
  each agent's prompt directory (`AGENT_PROMPT_DIRS`: pi → `~/.pi/agent/prompts`, claude →
  `~/.claude/…`, codex → `~/.codex/…`).
- **`skills/canonical/{caveman,gitnexus,paseo,ponytail}/SKILL.md`** — canonical skill content,
  deployed to every agent's skill directory (`AGENT_SKILL_DIRS`, same three agents). The suite
  requires each to exist, exceed 500 bytes and carry either a frontmatter `name:` or a top-level heading,
  so a placeholder can never ship as a "skill".

Vendored third-party-style tooling (extensions, packages, scripts, other skills) is a separate tree
with its own policy: [page 07](07-personal-tooling-vendoring.md).
