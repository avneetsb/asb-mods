# 10 — Hooks reference

[← 09 Secrets and environment](09-secrets-and-env.md) · [Home](Home.md) · Next: [11 — Updating and rolling back](11-update-and-rollback.md)

One definition, three registrations. `shared-core/hooks/hooks.json` is the single source of truth;
`lib/hooks.js` translates it into each agent's native mechanism. There is no generator script — the
old shell adapter was removed precisely because it could not cover all three tools (see *Retired*).

## The three targets

| Agent | Where registration lands | Existence gate | Result string |
| --- | --- | --- | --- |
| pi | generated extension `~/.pi/agent/extensions/asb-mods-hooks.ts` | the **agent root** `~/.pi/agent` must exist | `registered` / `up-to-date` / `skipped` |
| Claude Code | the `"hooks"` map inside `~/.claude/settings.json` | that settings file must exist | same |
| Codex | `~/.codex/hooks.json` (written by asb-mods; `config.toml` is never touched) | `~/.codex` must exist | same |

`registerAll()` runs the three and returns the per-tool strings you see in the run summary, e.g.
`hooks: ["pi:registered","claude:up-to-date","codex:skipped"]`. `skipped` means the tool is not
installed — it is never an error.

**Why pi gates on `~/.pi/agent` and not `~/.pi/agent/extensions`:** Phase 3 legitimately deletes the
`extensions` directory (it holds the loose extensions being cut over). Gating on the subdirectory made
the hook phase silently skip pi right after removing it. Gate on the agent root, create the
subdirectory when writing.

## Idempotence: the marker

Every command this package registers is annotated:

```text
<command>  # asb-mods:<hook-name>
```

`MARK = '# asb-mods:'` plus the hook name. Before writing, `alreadyPresent()` searches the serialised
target bucket for that marker. Consequences:

- re-running `asbmods hooks` is a no-op → the tool reports `up-to-date`, nothing duplicated;
- deleting the marker by hand is how you get a duplicate registration on the next run;
- the marker, not a name match, is what identifies "ours", so a hook you wrote yourself with the same
  trigger is left alone.

## The write discipline

All three registrations go through `writePreserving(target, mutate, label, log)`:

```text
read (or start empty) → backupString() once → mutate in memory → write ONLY if serialisation changed
```

Backups land in `file-backups/<basename>.<hash12>.<iso-ts>`, so an unwanted merge is always
recoverable, and a no-op run leaves mtime untouched (which keeps dotfile-sync tools quiet).

## Placeholder resolution — the step that must not be skipped

`hooks.json` commands are written tool- and machine-independent:

```json
{ "action": "bash {{STATE_DIR}}/bin/asb-env-check.sh" }
```

`flatten(defs)` expands `trigger_event` (including the `a|b` form, which becomes two registrations) and
resolves `{{HOME}}`, `{{STATE_DIR}}`, `{{CORE}}` **at registration time** via `resolvePlaceholders`.
Skipping that step registers a literal `{{STATE_DIR}}/bin/...` path — a real bug this codebase has had,
and the reason a fixture-home test asserts the registered string contains the expanded path.

`{{STATE_DIR}}` also respects `XDG_CONFIG_HOME`, which is what lets the suite register into a fixture
without touching the real config directory.

## The pi adapter extension

`piExtensionSource(items)` generates a TypeScript extension. Its runtime semantics:

| Item declared `when` | Fires on | Guard |
| --- | --- | --- |
| `on_session_start` | `session_start` | at most once per process |
| everything else | `turn_end` | at most once per process |

Each hook executes its command through `/bin/bash -lc "<command>"` with an **8 second timeout**, so a
slow or hanging helper cannot wedge an agent session; failures are reported by the agent, not fatal.
The extension is a file under `extensions/`, so it is also *archived* by Phase 2 and *removed* by
Phase 3 like any other loose extension — `asbmods hooks` (or a full run) restores it.

## The four shipped hooks

| Hook | Tool-side trigger | Command | What it protects against |
| --- | --- | --- | --- |
| `session_style_reminder` | `UserPromptSubmit` | inline `printf` of the style rule | answers that drop technical detail when terse mode is on |
| `environment_preflight` | `SessionStart` | `bin/asb-env-check.sh` | a session starting without TLS trust or the model pin |
| `secrets_hygiene` | `Stop` | `bin/asb-secrets-check.sh` | a credential being written into a tracked file |
| `paseo_terminal_display` | `PostToolUse` | terminal state helper | losing track of background agent state |

Helper scripts are deployed by `deployHookBin()` with mode 755 and referenced only through
`{{STATE_DIR}}`, never a repo path — so the package checkout can move or be deleted after install.

## Adding a hook

1. Add an entry under `hooks` in `shared-core/hooks/hooks.json`:
   `when`, `trigger_event` (use `a|b` for two triggers), and either an inline `action` or a command
   that calls a helper you ship under `hooks/bin/`.
2. Reference paths only as `{{HOME}}`, `{{STATE_DIR}}`, `{{CORE}}`.
3. `asbmods hooks` → expect `registered` for every installed tool.
4. Run it again → expect `up-to-date` for all three (this is the idempotence proof).
5. Verify in each tool's own format:

```bash
grep -n 'asb-mods:' ~/.claude/settings.json | head
python3 -c "import json;print(list(json.load(open('$HOME/.codex/hooks.json'))))"
grep -n 'asb-mods:' ~/.pi/agent/extensions/asb-mods-hooks.ts | head
find ~/.config/asb-mods -name 'asb-*check.sh' -exec ls -l {} +
```

## Retired mechanisms

`hooks.json → retired` records why removed things stay removed:

- **the shell adapter generator** — it had no pi case, read `schema.events` while the schema actually
  exposed `schema.hooks`, and its non-pi branches only wrote discovery reports. `lib/hooks.js`
  registers all three tools for real; a test asserts the generator file is gone.
- **plugin-cache hooks** (ponytail, obsidian-connect, impeccable, a database probe) — those belonged to
  third-party plugin installs, which are outside this package's scope (see the `claudePlugins` /
  `claudeHooks` denials on [page 07](07-personal-tooling-vendoring.md)).

## What the pi adapter cannot do yet (measured, not assumed)

The generated extension is real and works, but its mapping is coarser than Claude's or Codex's, and
the difference is behavioural, not cosmetic:

| Shared hook (`when`) | Claude / Codex | pi today | Consequence |
| --- | --- | --- | --- |
| `on_session_start` | fires at session start | `pi.on("session_start")` | equivalent |
| `on_user_prompt` | fires on **every** prompt | collapsed into `turn_end`, and a `fired` Set lets each hook run **once per process** | the style reminder runs once per session, not once per prompt |
| `post_tool_use` | fires after each tool call | same collapsed `turn_end`, once per process | a hook meant to act before the TUI renders (the terminal-label hook) runs after the session ends — i.e. never usefully |
| `on_stop` | fires at stop | same collapsed `turn_end`, once per process | close enough to be honest, not equal |

Two more limits. Failures are reported with `ctx.ui.notify` **only when `ctx.hasUI`**, so the same
hook failing in a headless run prints nothing at all. And pi's own event set is richer than the
adapter uses — `input`, `turn_start`, `tool_call`, `tool_result`, `agent_end`, `agent_start` all
exist upstream — so this is a shortcut in `piExtensionSource()`, not a ceiling pi imposes.

Planned correction (0.3.2): map `on_user_prompt → input`, `post_tool_use → tool_result`,
`on_stop → agent_end`, keep `on_session_start → session_start`; drop the unconditional once-per-process
gate in favour of an explicit `once: true` on hooks that mean it; and print hook failures to
`stderr` when there is no UI, because a silent hook is indistinguishable from an absent one. Until
that lands, treat pi as receiving **session-start semantics** for every hook, and do not rely on a pi
hook to guard something before it happens.

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| hook never fires in pi, file exists | generated extension was removed by a cutover and not re-registered | `asbmods hooks` |
| registered command contains a literal `{{STATE_DIR}}` | placeholder resolution skipped for a new field | route the new field through `flatten()`'s resolution |
| duplicated hook entries in Claude settings | marker comment edited or deleted by hand | remove the duplicates, re-run `asbmods hooks` |
| `claude:skipped` unexpectedly | `~/.claude/settings.json` does not exist yet (tool installed, never run) | start Claude Code once, then `asbmods hooks` |
| helper "permission denied" | hook bin deployed without 755 (hand-copied) | `asbmods install` to redeploy, or `chmod 755` the file in the state dir |
| hook output missing but no error | 8 s timeout hit, or the helper exits non-zero quietly | run the helper directly from the state dir and time it |
