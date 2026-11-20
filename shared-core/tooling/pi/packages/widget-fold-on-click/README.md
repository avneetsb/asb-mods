# widget-fold-on-click

Click a widget frame's **title row** to fold that frame down to a single line, in any
of the three frames that surround pi's editor:

| Frame | Producer | Slot key | Placement |
| --- | --- | --- | --- |
| `pi-goal-x ─ …` goal dashboard | `npm:pi-goal-x` | `goal` | aboveEditor |
| `⦿ beads ─ N active · M ready` | `npm:@abix5/pi-beads`, restyled by `beads-box-widget` | `beads-wip` | aboveEditor |
| `pi-lens ●44E !6W ─ Findings …` | `lens-diagnostic-pane` | `lens-pane` | belowEditor |

Folded, a frame keeps its own title row (so live counters such as `6 active · 40
ready` or `●44E !6W` stay readable) with a dim `▸ folded` marker where the rule
dashes used to be. Click the same row again to expand.

The folded row below is real `buildFoldedLine` output for that beads title at canvas
width 64; the expanded frame is illustrative (beads draws its own body):

```text
╭─ ⦿ beads ─── 6 active · 40 ready ─────────────────── ▸ folded╮     ← folded (1 row)

╭─ ⦿ beads ─── 6 active · 40 ready ──────────────────────────────╮    ← expanded
│ ├─ ◐ P1 automated-trading-q8xk [automated-trading] Shared …    │
│ …                                                               │
╰─ bd ready · beads_list ─────────────────────────────────────────╯
```

## Requirements and controls

* **Mouse needs full-screen mode.** pi captures mouse input only in its alt-screen
  renderer — `tuiMode: "fullscreen"`, which is pi's default (`docs/tui.md`, "Handle
  mouse input"). With `"regular"` the terminal owns scrollback and no click reaches a
  widget; use `/fold`.
* **Keyboard path:** `/fold` (status), `/fold all`, `/fold none`, `/fold goal beads
  lens` (toggle named frames). Names accepted: `goal`, `beads`, `lens` (or the raw
  slot keys `goal`, `beads-wip`, `lens-pane`; `pane` also resolves to `lens-pane`).
* Only an unmodified **left** click on the frame's **first row** toggles — right
  click, middle click, wheel, modified clicks and body rows are passed back to the
  producer untouched.

## Why a boundary extension instead of three feature patches

pi-goal-x has no mouse handling at all (verified 2026-11-04: no `handleMouse` anywhere
in `extensions/widgets/goal-widget.ts` or `goal-dashboard-renderer.ts`; the dashboard
only folds *internally* via `Ctrl+Shift+T`/`getExpanded`, which reorders detail rather
than hiding the frame). `@abix5/pi-beads` exposes no fold or hide knob for its widget.
Those are npm-owned, and machine policy keeps them untouched; the two slot owners this
machine does own (`beads-box-widget`, `lens-diagnostic-pane`) would each need a copy of
the same fold logic, and none of them could cover the third.

So folding is added once, at pi's widget boundary:

* `ctx.ui.setWidget(key, content, options)` (pi `interactive-mode.js`
  `setExtensionWidget`) keeps one widget per key per placement and, for non-array
  `content`, calls `content(this.ui, theme)` immediately and stores the returned
  component. Patching `setWidget` and wrapping that factory therefore folds whatever a
  producer mounts.
* Producers keep updating **their own** component in place (pi-goal-x via
  `goalWidgetComponentRef.current.update()`; pi-subagents likewise), so their live
  counters, spinner animation and refresh paths are unaffected. This extension owns no
  widget data — only a `collapsed` flag per key plus the `tui`/`theme` handed to the
  factory.
* The wrapper is a `Proxy` over the producer's component: `render` and `handleMouse`
  are re-anchored, everything else (`update`, `invalidate`, `dispose`, prototype
  methods, `instanceof`) passes through.
* pi hit-tests the render layout and dispatches mouse events to each box's component
  with **component-local** coordinates (pi-tui `layout.js` `getLayoutBoxesAt` →
  `tui-alt-screen.js` `dispatchMouseToLayout`), so the title row is always `y === 0`
  regardless of how many widgets share a placement.

## Install order (the one fragile bit)

pi awaits event handlers in extension load order, and this extension patches
`setWidget` from its own `session_start` handler. It must therefore load **before** the
producers: `~/.pi/agent/settings.json` lists `../../.agents/packages/widget-fold-on-click`
immediately before `npm:pi-goal-x` (and so also before `@abix5/pi-beads`,
`beads-box-widget`, `lens-diagnostic-pane`).

If that ordering is ever broken, the symptom is bounded and self-reporting: a frame
mounted before the patch simply stays unfolded-and-unclickable until it re-mounts, and
`/fold list` prints `… (not mounted right now)` for it instead of failing silently.
Re-mounting happens naturally on `/reload`, goal focus changes, or the next beads
re-render.

Deliberately **not** folded: pi-subagents' `subagent-async` widget, which already owns a
click-to-fold header (its own toggle lives at `src/tui/render.js` `handleMouse`). Adding
it here would put two toggles on one click and cancel them out.

## Folding rules (what the folded line guarantees)

* Never wider than the canvas pi supplied — an over-wide widget line corrupts the layout.
* The producer's title bytes are kept as a prefix, colouring included (ANSI sequences
  are stepped over, never cut in half; glyphs move as code points).
* The marker is placed by **eating rule dashes**, because these frames pad their title
  to the full terminal width; an appended marker would essentially never fit. Test
  `folding eats rule dashes, not the producer's text` pins that.
* Too narrow for any marker → the title is clamped, since an overflowing line costs
  more than a missing hint.

## State and safety rails

* Fold state is per key, in memory, for the session (not persisted across restarts).
  Producers re-mount their slots freely — `beads-box-widget` reclaims `beads-wip` from
  upstream on each render — and the choice survives that churn.
* Every wrapped `render` is inside try/catch and falls back to the producer's own
  lines; unmount calls (`setWidget(key, undefined)`) pass straight through; the patch is
  marked so `/reload` never wraps twice; and uninstalling this package returns every
  producer to its exact prior rendering.

## Files

* `extensions/widget-fold-on-click.ts` — `/fold` command, `setWidget` patch, Proxy wrapper
* `extensions/fold-line.mjs` — pure helpers: ANSI-safe width math, `buildFoldedLine`, `isTitleClick`
* `test/fold-line.test.mjs` — 10 tests on the pure helpers: the width invariant swept
  over canvases 20–200, ANSI/wide-glyph/astral handling, click-gesture negative cases
* `test/glue.test.mjs` — 9 tests that run the real extension against a fake pi: which
  slots get wrapped, click → one row → click back, `/fold list|all|none|names` wording,
  producer `update`/`invalidate`/`dispose` pass-through, a takeover re-mount keeping the
  fold, unmount honesty, and that neither a throwing producer nor a broken theme can
  blank a frame

```bash
node --test test/        # 19 tests; needs no install

npm install && npm run check   # strict tsc --noEmit (devDeps: typescript, @types/node)
```

## Extending

Add a slot to `WIDGET_LABELS` (key → short name) and reload. Check first that the
widget does not already own a click-to-fold gesture — see the exclusion above.
