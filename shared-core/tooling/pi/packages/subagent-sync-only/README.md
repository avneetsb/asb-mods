# subagent-sync-only

Forbids asynchronous (background) subagent delegation in every pi session.
Every `subagent` launch is rewritten to `async: false`, so delegation stays
synchronous inside the calling session and its result arrives in the same tool
call. Launches that are deferred by construction (scheduled runs) are refused,
since they have no synchronous form.

One purpose. No upstream file is read into the build or edited; the rewrite
happens at pi's documented interception point.

## Layers (both required)

1. `~/.pi/agent/extensions/subagent/config.json` -> `{ "asyncByDefault": false }`
   Changes pi-subagents' default so omitted `async` means foreground.
2. This package -> forces `async: false` on every launch and refuses
   `action:"schedule.create"`. Needed because the config key only moves the
   default: an explicit `async:true` still backgrounds, and workflow-script
   calls background whenever `async` is omitted.

Why no upstream-only fix (pi-subagents 0.88.0, verified on this machine):

- `asyncByDefault: false` - default only; explicit `async:true` still wins.
- `maxActiveAsyncRunsPerSession: 0` - means UNLIMITED, not zero
  (`docs/configuration.md`: "Unset or `0` keeps the existing unlimited behavior").
- `disabledFeatures` - has no `async`/`background` feature group
  (`docs/configuration.md` table).

## Mechanism

`pi.on("tool_call")`, per pi docs (extensions.md, Tool Events):
`event.input` is mutable and "Mutations of `event.input` affect actual tool
execution". Calls with no `action` are launches (single child, `tasks`,
`chain`, `count`, workflow script) and get `async: false`. Control actions
(`status`, `stop`, `steer`, ...) launch nothing and are left alone.

## Known limits

- An agent defined background-only rejects `async: false` itself, so such a
  launch errors naming that agent. Fail-closed by design.
- Nested delegation performed by a child session is coerced only if that child
  loads this package too (foreground children inherit the parent extension
  set); pi-subagents' own `subagent_command` escape hatch is outside this hook.
- `/run`, `/prompt-workflow` and RPC entry points are user-driven, not model
  delegation; the `asyncByDefault` config covers their defaults.

## Files

- `extensions/sync-only.js` - the hook (`coerceSubagentCall` is pure/exported).
- `test/coerce-test.mjs` - `node test/coerce-test.mjs` (no deps).
- Kill switch: `SUBAGENT_SYNC_ONLY=0`. Status: `/subagent-sync`.
