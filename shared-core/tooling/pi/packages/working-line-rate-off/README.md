# working-line-rate-off

Takes the **tokens/sec meter** out of pi's live working line and keeps everything else on it.

```
before  Blanching… · 18m06s · thinking 8m18s · ↑314k ↓26k ⚡31.6 tok/s
after   Blanching… · 18m06s · thinking 8m18s · ↑314k ↓26k
```

One purpose: no `tok/s` in the working line. Touches no upstream file.

## Why a wrapper and not config

The line is composed by **`npm:pi-one-ui`** (the "cc" UI shell; its themes are
`themes/cc-dark.json` / `cc-light.json`), not by pi core, pi-atelier, pi-stamp or
atelier-panel-merger. Verified by raw reads of pi-one-ui 0.9.2:

| fact | where |
| --- | --- |
| the meter is appended here, only while `outputTokensPerSecond > 0` | `extensions/layouts/working-line/working-line.ts:526-530` |
| the finest config knob is `segments.{tool,elapsed,thought,tokens}` — `tokens:false` would delete the ↑/↓ counters too | `extensions/app/config/working-line.ts` (`WorkingLineSegmentsConfig`) |
| the settings overlay offers only enabled + spinner | `extensions/app/settings/controller.ts` (`workingLineEnabled`, `workingLineSpinner`) |
| the composed row reaches pi as spinner frames via `ui.setWorkingIndicator({frames})`, and pi-one-ui re-reads `ctx.ui` per call | `working-line.ts:1343`, `:1447`, `:992` |
| pi hands **one** `uiContext` object to all extensions, so replacing a method on it covers every caller | `interactive-mode.js:1585` → `runner.setUIContext` → `runner.uiContext` |

So: config can hide the whole tokens segment but not the rate alone; ES-module
monkeypatching of `formatWorkingLineTokens` is impossible (read-only export bindings);
zeroing the usage the rate is derived from would corrupt the ↑/↓ counters that must
stay. Wrapping the public facade is the only seam that keeps the counters.

## How it works

`extensions/rate-off.ts` replaces `ui.setWorkingIndicator` and `ui.setWorkingMessage`
once per facade object (marked with a symbol, so a re-install never nests) and rewrites
frame strings before they reach pi:

1. Tokenise the frame into escape runs + visible code points. Frames are styled
   cell-by-cell by pi-one-ui, so the meter text is **never contiguous** in the raw string.
2. Match ` ⚡31.6 tok/s` (also `⚡ ~820 tok/s`, `⚡1.2k tok/s`) on the **visible** text.
   The `⚡` is required: a bare `<n> tok/s` elsewhere on screen is left alone.
3. Delete the matched cells plus only the escape runs strictly between them. The colour
   open before the span and the reset after it survive, so SGR pairing stays balanced.

Payloads with no meter are passed through **by object identity**, so pi's own change
detection is unaffected.

## Known costs

- **Animation drift.** pi-one-ui computes the classic/kitt highlight period over
  `graphemeCells(composed.row)` (`working-line.ts:791`, tiers `L215-240`) — i.e. for the
  *pre-strip* row. The travelling band can therefore run past the shortened end for part
  of its cycle. Cosmetic only.
- **Upgrade coupling.** Stripping is keyed on the `⚡` glyph and the `tok/s` suffix. If
  pi-one-ui changes either, this silently stops matching (the meter comes back) rather
  than damaging anything. Re-run the test suite after any pi-one-ui upgrade.
- A frame carrying two meters can strand a separator (`… ·`). pi-one-ui emits at most one
  meter per frame, at the end, so this does not occur today; the test pins the behaviour.

## Ops

```bash
node --experimental-strip-types test/strip-test.mjs   # 36 assertions
pi install ~/.agents/packages/working-line-rate-off   # register (rewrites ~/.pi/agent/settings.json)
```

Reload = restart pi (extensions load at start).

Kill switch: `WORKING_LINE_RATE_OFF=0` (env). Remove with `pi remove working-line-rate-off`
(or drop the entry from `~/.pi/agent/settings.json` → `packages`).

Escape hatch if you would rather spend zero code and lose the ↑/↓ counters too:
set `components.workingLine.segments.tokens = false` in `~/.pi/agent/pi-one-ui.json`.
