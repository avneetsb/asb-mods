# beads-box-widget

Renders the beads "in progress" above-editor panel as a bordered box in
pi-goal-x's house style (rounded frame, muted gray chrome, accent brand,
colour-coded rows) instead of `@abix5/pi-beads`' plain unframed lines.

## Why a slot-takeover extension exists

`@abix5/pi-beads` draws its widget with `ctx.ui.setWidget("beads-wip", …)` and
offers **no config knob** to disable or restyle it (verified against v0.2.2:
the only env var is `PI_BEADS_ROOT`; an env redirect that hid the widget would
also break the beads tools). Machine policy forbids editing npm-installed
packages, so the panel is replaced at pi's widget-API boundary instead:

* Widget slots live in one global map keyed by the widget key — last writer
  wins (pi 1.4.0 `interactive-mode.js` `setExtensionWidget`:
  `targetMap.set(key, component)`).
* pi dispatches events by awaiting handlers sequentially in extension load
  order (`runner.js` `emit()`), and this package is installed **after**
  `npm:@abix5/pi-beads` in `~/.pi/agent/settings.json` → our handlers observe
  every upstream re-render and take the slot back.

Upstream re-render triggers and our reclaim points:

| upstream trigger | ours |
| --- | --- |
| `session_start` (after 2 `bd` subprocesses) | `session_start` + 600 ms settle margin |
| `agent_start` (synchronous) | `agent_start` (later in dispatch order, + margin) |
| inside write tools (sync render + delayed one after `bd ready`) | `tool_execution_end` for `/^beads/i` tools + 450 ms margin |
| `session_compact` | `session_compact` + margin |

Worst case if a timing margin loses: the plain upstream panel stays visible
until the next reclaim point — cosmetic only, no duplicated panels.

## Data source

Public `bd` CLI only (same commands upstream uses):

* `bd where`, `bd repo list` → umbrella + member repos (honours `PI_BEADS_ROOT`)
* `bd list --status in_progress --json -n 50` per repo dir → active rows
* `bd ready --json` → header ready count

Closed-this-session rows (shown struck-through for one turn) are tracked by
diffing the in-progress set across `bd`-touching tool runs — independently of
upstream's internal state.

## Files

* `extensions/beads-box-widget.ts` — lifecycle glue, `bd` fetching, slot takeover
* `extensions/widget-lines.mjs` — row/header/footer composition for the box
* `extensions/box.mjs` — box primitives; ANSI-stripped width math, `[lo,hi]`
  pair range tables, exact-`width` output invariant (a flat-array range table
  here once crashed pi's render loop — see git-blame-worthy comment inline)

## Layout spec

`width >= 14`: `╭─ ⦿ beads ─── N active · M ready ╮` /
`│ ├─ ◐ P1 <id> [repo] <title> <age> │` rows / `╰─ bd ready · beads_list ─╯`.
Max 6 rows, `+N more` line replaces the footer when truncated. Priority colors:
P0 default, P1 error, P2 warning, P3/P4 muted. Closed rows: `✓`, muted,
strike-through. Lines are padded/truncated to exact terminal width; content is
ANSI-safe.

## Tests

```bash
node --test test/
```

Width-invariant sweep over `widgetLines` (every emitted line's display width
must equal the requested canvas at widths 20–200, plain + painted themes),
plus regression tests for the crash class (code-point args to `charWidth`).
