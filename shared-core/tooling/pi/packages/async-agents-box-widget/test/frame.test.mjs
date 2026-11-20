/**
 * frame.test.mjs — box-frame invariants for the async-agents widget wrapper.
 *
 * Run: node test/frame.test.mjs   (no deps; asserts on strings only)
 *
 * The contract worth testing is presentation, not run state: every emitted line must be
 * exactly `width` display columns (a single wide/off-by-one line breaks pi's whole widget
 * column), upstream's header must be lifted rather than duplicated, counters must never be
 * invented, the RPC payload must survive byte-for-byte, and a framing failure must fall
 * back to upstream's raw lines.
 */

import assert from "node:assert/strict";
import { frameWidgetLines, mapFramePointer, SNAPSHOT_PREFIX } from "../extensions/widget-frame.mjs";
import { stripAnsi, displayWidth } from "../extensions/box.mjs";

const theme = {
  fg: (color, text) => `\x1b[38;5;7m${text}\x1b[0m`,
  strikethrough: (s) => `\x1b[9m${s}\x1b[0m`,
};

/** Upstream pads each line with one leading + trailing space and pads out to width. */
const pad = (line, width) => {
  const text = ` ${line}`;
  return `${text}${" ".repeat(Math.max(0, width - displayWidth(text)))}`;
};

const expandedTree = (width) => [
  pad("\u2834 Async agents \u00b7 background", width),
  pad("\u251c\u2500 \u2834 delegate [fresh] \u00b7 2 tool uses \u00b7 152k window \u00b7 136k spent \u00b7 4m0s", width),
  pad("\u2502  \u23bf active but long-running \u00b7 last activity 1m ago \u00b7 1 turns \u00b7 2 tools", width),
  pad("\u251c\u2500 \u2834 delegate [fresh] \u00b7 2 tool uses \u00b7 127k spent \u00b7 4m33s", width),
  pad("\u251c\u2500 \u2713 delegate [fresh] \u00b7 done \u00b7 12s", width),
  pad("\u2514\u2500 +5 more (5 running)", width),
];

const foldedLine = (width) => [pad("\u2834 Async agents \u00b7 2/4 running (4m), 1 queued", width)];

const singleRun = (width) => [
  pad("\u2834 delegate [fresh] \u00b7 2 tool uses \u00b7 136k spent \u00b7 4m0s", width),
  pad("  \u23bf editing src/app.ts", width),
];

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
};

// ── width invariance across terminals and content shapes ─────────────────────
check("every line is exactly `width` columns (many widths x layouts)", () => {
  const layouts = [expandedTree, foldedLine, singleRun];
  for (const build of layouts) {
    for (let width = 16; width <= 220; width += 3) {
      const out = frameWidgetLines(build(width - 3), width, theme);
      assert.ok(out.length >= 1, `expected at least the box header at width ${width}`);
      for (const line of out) {
        const plain = stripAnsi(line);
        assert.equal(displayWidth(plain), width, `width ${width}: got ${displayWidth(plain)} for ${JSON.stringify(plain)}`);
      }
    }
  }
});

// ── header lift, not duplication ─────────────────────────────────────────────
check("expanded header becomes the box title; no second 'Async agents' row", () => {
  const width = 100;
  const out = frameWidgetLines(expandedTree(width - 3), width, theme);
  const plain = out.map(stripAnsi);
  assert.match(plain[0], /async agents/);
  assert.match(plain[0], /background/);
  assert.equal(plain.slice(1).filter((l) => /Async agents/.test(l)).length, 0);
  assert.ok(plain[1].includes("\u251c\u2500"), "first body row keeps upstream's tree branch");
});

// ── counters: upstream's own when present, derived otherwise, never invented ──
check("folded header counters move to the title bar verbatim", () => {
  const width = 90;
  const out = frameWidgetLines(foldedLine(width - 3), width, theme);
  const header = stripAnsi(out[0]);
  assert.match(header, /2\/4 running \(4m\)/);
  assert.match(header, /1 queued/);
  assert.equal(out.length, 1, "folded box stays the one-line status it was");
});

check("expanded counters derive from upstream's status glyphs", () => {
  const width = 120;
  const header = stripAnsi(frameWidgetLines(expandedTree(width - 3), width, theme)[0]);
  assert.match(header, /2 running/);
  assert.match(header, /1 done/);
  assert.match(header, /\+5 hidden/);
});

check("single-run layout shows no counters rather than guessed ones", () => {
  const width = 100;
  const header = stripAnsi(frameWidgetLines(singleRun(width - 3), width, theme)[0]);
  assert.doesNotMatch(header, /\d+ (running|done|queued|failed|stopped)/);
});

// ── RPC payload passthrough ──────────────────────────────────────────────────
check("PI_SUBAGENT_ASYNC_JSON payload is returned untouched", () => {
  const payload = [SNAPSHOT_PREFIX + '{"version":1,"jobs":[]}'];
  const out = frameWidgetLines(payload, 120, theme);
  assert.deepEqual(out, payload);
});

// ── height bound: chrome must not eat the viewport ───────────────────────────
check("row cap bounds total height and reports the drop", () => {
  const width = 80;
  const many = [pad("\u2834 Async agents \u00b7 background", width - 3)];
  for (let i = 0; i < 40; i++) many.push(pad(`\u251c\u2500 \u2834 delegate run ${i}`, width - 3));
  many.push(pad("\u2514\u2500 \u2717 delegate run 40", width - 3));
  const out = frameWidgetLines(many, width, theme, { maxLines: 12 });
  assert.ok(out.length <= 12, `height ${out.length} exceeded cap`);
  assert.match(stripAnsi(out[out.length - 2]), /\+\d+ more/);
});

// ── pointer remap: the title bar still folds ─────────────────────────────────
check("click on the title or first body row reaches upstream's fold", () => {
  assert.deepEqual(mapFramePointer({ type: "click", button: 0, y: 0 }), { type: "click", button: 0, y: 0 });
  assert.deepEqual(mapFramePointer({ type: "click", button: 0, y: 1 }).y, 0);
  assert.equal(mapFramePointer({ type: "click", button: 2, y: 1 }), null);
  assert.equal(mapFramePointer({ type: "click", button: 0, y: 1, shift: true }), null);
  assert.equal(mapFramePointer({ type: "click", button: 0, y: 4 }).y, 3);
});

// ── degraded themes still produce a box ──────────────────────────────────────
check("missing theme.fg still frames (structure beats colour)", () => {
  const out = frameWidgetLines(expandedTree(77), 80, undefined);
  assert.equal(out.length, 7);
  for (const line of out) assert.equal(displayWidth(stripAnsi(line)), 80);
});

process.stdout.write(`\n${passed} checks passed\n`);
