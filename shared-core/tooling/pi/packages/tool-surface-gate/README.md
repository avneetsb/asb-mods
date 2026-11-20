# tool-surface-gate

One purpose: stop paying prompt tokens for tools this machine never calls.

Pi declares every registered tool to the model on every session. On this machine that was
**140 active tools ≈ 105.5k prompt tokens** (95.7k inside the tool block + ~9.8k in the
`<tool_guidelines>` block), and most of it was dead weight. This extension measures which
tools are unused, parks them at session start, and gives the model one small tool
(`tools_wake`) to bring any of them back when it actually needs them.

It touches **no upstream code**. It only calls pi's public dynamic-tool API —
`pi.getAllTools()` / `pi.getActiveTools()` / `pi.setActiveTools()` — the same mechanism
pi-web-access uses for its `web_enable` loader.

## What gets parked

Families live in `~/.pi/agent/tool-surface-gate.json` (edit that file to change the policy;
the code's built-in defaults are identical). Every name below measured **0 calls across the
~120 sessions** indexed in `~/.pi/agent/sessions`:

| family | tools | decl chars | why safe to park |
| --- | --- | --- | --- |
| `computer-use-ui` | `find_roots observe_ui search_ui expand_ui inspect_ui act_ui read_text wait_for` | ~4.7k | macOS UI automation (`@injaneity/pi-computer-use`), never used, duplicate of browser + shell paths |
| `computer-use-browser` | `launch_browser navigate_browser evaluate_browser` | ~2.9k | second CDP launcher; the `browser_*` harness already drives Chrome |
| `engram-admin` | `mem_judge mem_judge_many mem_compare mem_pin mem_unpin mem_list_projects mem_doctor mem_capture_passive mem_save_prompt mem_search_prompts mem_suggest_topic_key mem_session_start mem_session_end` | ~6.4k | engram judging/admin/lifecycle; the memory path AGENTS.md mandates (`mem_save`, `mem_update`, `mem_search`, `mem_context`, `mem_review`) stays active |
| `goal-admin` | `create_goal set_goal_tasks goal_question goal_questionnaire` | ~3.8k | pi-goal-x goals are created through `/goal-direct` & friends, not model tools |
| `preview` | `preview_export` | ~2.3k | 5 calls ever; wake it when the user asks for a PDF/PNG |
| `source-check` | `source_check` | ~0.8k | `web_search` + `fetch_content` cover it |
| `chrome-devtools` | `mcp__chrome_devtools` | ~0.6k | 0 calls; the generic `mcp` gateway still reaches that server |

Total: **34 tools, ~21.5k declaration chars ≈ 5.4k tokens** off the declared surface, plus the
matching `<tool_guidelines>` rows (another ~2.5k tokens) for the 31 tools that had no proxy —
so roughly **8k tokens saved on every session, ~37% of the tool block**, and 19 fewer schema
objects to re-send per turn.

Nothing else changes: `mcp`, `tool_search`, every core file/shell tool, the memory tools
AGENTS.md requires, and all MCP proxies except chrome-devtools stay active. `DEFAULT_KEEP` in
the extension is a hard guardrail — a config family cannot park a keep-listed tool.

## Waking a parked tool

`tools_wake` is always active and costs ~0.4k tokens:

- `{"family": "preview"}` → wakes that family, available on the next model request
- `{"tools": ["mem_doctor", "preview_export"]}` → wake specific tools
- `{}` → report what is parked

If `tools_wake` itself is not registered (e.g. this extension failed to load), the gate parks
**nothing** — there is no way back, so it stays out of the way.

## Safety properties

- **Never yanks a tool mid-conversation.** Parking only removes tools the transcript never
  declared (`lib/park.js:declaredFromBranch`). In a resumed or in-flight session with no
  tool-change records, nothing is parked at all. Once a family is woken, the transcript records
  it, so the per-turn re-check does not park it again.
- **Re-checks before every turn** (`before_agent_start`) because MCP proxies register after
  `session_start` — that is how `mcp__chrome_devtools` gets parked too. The call is idempotent.
- **Fails open.** Any throw from pi's API logs one `[tool-surface-gate]` line and disables the
  gate for that session; tools stay as pi chose them.
- **Kill switches**: `TOOL_SURFACE_GATE=0` (env, checked before anything registers), or
  `{"enabled": false}` in the config file.

## Not doing this by config, and why a package was justified

Checked first, per the modification policy: `defaultTools` / `excludeTools` exist in pi's
settings schema but are **not wired into `AgentSession`** in pi 1.5.2 (`dist/core/agent-session.js`
never reads them; `DEFAULT_TOOLS` is a fixed list), so the only supported config knob would turn
*all 27 core tools* off or on at once — the two tools worth disabling there (`symbol_search`,
`project_report`) are already lazy via pi-lens `tools.lazy=true`. `pi-lens`, `gentle-engram`,
`pi-goal-x` and `@injaneity/pi-computer-use` expose **no per-tool enable switches** (verified by
reading their sources). A user-owned extension on the public API is the remaining route.

## Verify

```bash
# unit tests (pure logic, no pi needed)
node --test ~/.agents/packages/tool-surface-gate/test/gate-test.mjs

# extension-level test (needs pi's node_modules for `typebox`)
NODE_PATH=~/.pi/agent/npm/node_modules node --test ~/.agents/packages/tool-surface-gate/test/extension-test.mjs

# live: how many tools are active now (compare before/after enabling)
pi --mode json --print 'reply with the word ok only' >/dev/null  # then check the session file's tool count
```

Registered as a local pi package: `pi install ~/.agents/packages/tool-surface-gate`, listed in
`~/.pi/agent/settings.json` → `packages`. Restart pi for the manifest to take effect.

## Layout

- `extensions/tool-surface-gate.js` — pi wiring: config load, park pass, `tools_wake` tool
- `lib/park.js` — pure, unit-tested decision logic (no pi imports)
- `test/gate-test.mjs`, `test/extension-test.mjs` — logic + fake-`pi` harness tests
