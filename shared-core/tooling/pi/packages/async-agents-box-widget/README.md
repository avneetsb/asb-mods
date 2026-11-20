# async-agents-box-widget

Renders pi-subagents' **Async agents** above-editor panel as a bordered box in the same
house style as `beads-box-widget` / pi-goal-x — rounded frame, muted gray chrome, accent
title, right-aligned live counters — instead of its bare `⠴ Async agents · background`
tree of lines.

```text
╭─ ⦿ async agents · background ─────── ⠴ 3 running · 1 done · +5 hidden ─╮
│ ├─ ⠼ delegate [fresh] · 2 tool uses · 152k window · 136k spent · 4m0s  │
│ │  ⎿ active but long-running · last activity 1m ago · 1 turns · 2 tools│
│ ├─ ✓ delegate [fresh] · done · 12s                                     │
│ └─ +5 more (5 running)                                                 │
╰ click title to fold · subagent status ─────────────────────────────────╯
```

## Why a wrapper extension exists

pi-subagents has three config knobs for this widget (`asyncWidget`,
`asyncWidgetCollapsed`, `asyncWidgetLayout` — `docs/configuration.md`); all of them hide,
fold or relayout it. None restyles it, and machine policy keeps npm-installed packages
untouched. So the panel is restyled at pi's widget boundary:

* `ctx.ui.setWidget(key, content, options)` (pi 1.4.0 `interactive-mode.js` →
  `setExtensionWidget`) holds one widget per key per placement, defaults to
  `placement: "aboveEditor"`, and for a non-array `content` calls `content(this.ui, theme)`
  immediately, storing the returned component.
* pi-subagents mounts its widget as a factory under key `subagent-async`
  (`src/shared/types.js` → `WIDGET_KEY`) and afterwards updates **the already-mounted
  component in place** (`asyncWidgetUpdates`, `render.js` `renderWidget`) rather than
  calling `setWidget` again — deliberately, so progress cannot reorder widgets.

Consequence: wrapping that factory once is enough. This extension holds **no run state**;
the framed lines are pi-subagents' own output, so the 1 s spinner animation, folding,
token/tool stats and live progress all keep working, and the package cannot drift from
upstream's run model.

`setWidget` is wrapped per `ctx.ui` at `session_start`, guarded by a marker property so a
`/reload` never double-wraps. Everything else about the component passes through a `Proxy`
over pi-subagents' own instance — `instanceof`, prototype methods, and `dispose()` (which
clears their update/invalidation maps) included. Only two members are re-anchored:

* `render` — asks the inner component for its lines at `width - 3` (the box body budget),
  then frames them.
* `handleMouse` — shifts rows by the title bar, so a click on the box title still reaches
  upstream's header click (its fold toggle).

### Escape hatches and failure modes

* Framing is inside `try/catch` per frame: any throw falls back to upstream's raw lines,
  so a framing bug can never hide run state.
* RPC mode renders a machine-readable payload (`PI_SUBAGENT_ASYNC_JSON:…`,
  `async-status-snapshot.js`); it is passed through **unframed** so hosts keep their
  byte-for-byte contract.
* `asyncWidget: false` in pi-subagents' config still turns the widget off entirely, and
  uninstalling this package restores the original panel. No upstream file is modified.

## Counters (never invented)

| state | source |
| --- | --- |
| folded / progressive header (`⠴ Async agents · 2/4 running (4m), 1 queued`) | upstream's own counters, lifted verbatim into the title bar |
| expanded header (`· background`, no counters) | counts derived from the status glyphs upstream already paints on its tree rows (braille/`●` running, `◦` queued, `✓` done, `■` stopped, `✗` failed) plus its own `+N more (…)` row as `+N hidden` |
| single-run layout (no branch rows) | counters omitted rather than guessed |

Upstream's first line is **lifted**, not duplicated: the box never shows "async agents" twice.
Folded mode stays a genuine one-liner (title bar only, no empty body, no footer).

## Files

* `extensions/async-agents-box-widget.ts` — the `setWidget` wrapper + component Proxy
* `extensions/widget-frame.mjs` — pure framing: header lift, counters, row cap, pointer remap
* `extensions/box.mjs` — box primitives, **vendored byte-exact from beads-box-widget** (pi loads
  extensions by path, so a cross-package relative import would break if either package moves;
  keep the two copies in sync if the frame spec changes)

Height is bounded (`MAX_TOTAL_LINES = 14`, also capped at terminal rows − 6) because
upstream sizes its own block against the viewport and would not know about the two chrome
lines we add; surplus rows collapse into a `+N more` line.

## Tests

```bash
node --test test/          # or: node test/frame.test.mjs
```

Width-invariant sweep (every emitted line's display width must equal the requested canvas,
widths 16–220, painted and unpainted themes), header-lift and counter-provenance checks,
RPC passthrough, height cap, and the pointer remap.
