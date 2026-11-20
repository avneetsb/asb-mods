/**
 * Width-invariant sweep — the class of bug that once crashed pi's render
 * loop (flat range tables) and another time overflowed the terminal: every
 * line widgetLines emits must have display width EXACTLY equal to the canvas
 * it was given, for plain and painted themes, across all sane widths.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { widgetLines, formatAge } from "../extensions/widget-lines.mjs";
import { charWidth, displayWidth, truncToWidth } from "../extensions/box.mjs";

const STRIP = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const plainW = (s) => {
  let w = 0;
  for (const ch of STRIP(s)) w += charWidth(ch.codePointAt(0));
  return w;
};

const PAINTED = {
  fg: (color, text) => { void color; return `\x1b[38;5;7m${text}\x1b[39m`; },
  strikethrough: (s) => `\x1b[9m${s}\x1b[29m`,
};
const PLAIN_THEME = { fg: (_c, t) => t, strikethrough: (s) => s };

const ENTRIES = [
  { id: "modular-trading-au0.25.4.4", repo: "modular-trading", title: "Verify financial reconciliation end-to-end", priority: 1, age: "3d" },
  { id: "modular-trading-h81", repo: "modular-trading", title: "Define grid, spacing and layout tokens for the dashboard", priority: 1, age: "2d" },
  { id: "mtr-bfp.4.3", repo: "modular-trading", title: "Add the approved Codex escalation path with tests and docs", priority: 2, age: "1d" },
  { id: "x1", repo: "r", title: "wide 漢字 タイトル mixing fullwidth chars", priority: 0, age: "5m" },
];

function state(extra = {}) {
  return { entries: ENTRIES, closedCount: 0, readyCount: 77, ...extra };
}

test("exact canvas width across all sizes, painted + plain", () => {
  for (const theme of [PAINTED, PLAIN_THEME]) {
    for (let width = 12; width <= 200; width++) {
      const lines = widgetLines(state(), width, theme);
      assert.ok(lines.length > 0, `width ${width}: expected lines`);
      for (const l of lines) {
        assert.equal(
          plainW(l),
          width,
          `width ${width}: line renders ${plainW(l)} cols: "${STRIP(l).slice(0, 80)}"`,
        );
      }
    }
  }
});

test("closed rows render struck and stay box-width", () => {
  const st = state({
    entries: [...ENTRIES, { ...ENTRIES[0], id: "closed-1", closed: true }],
    closedCount: 1,
  });
  for (const l of widgetLines(st, 90, PAINTED)) {
    assert.equal(plainW(l), 90);
  }
});

test("+N more line replaces footer when >6 rows", () => {
  const many = {
    entries: Array.from({ length: 9 }, (_, i) => ({ ...ENTRIES[1], id: `repo-id-${i}` })),
    closedCount: 0,
    readyCount: 5,
  };
  const lines = widgetLines(many, 90, PAINTED);
  const plain = lines.map(STRIP);
  assert.ok(plain.some((l) => l.includes("+3 more")), "expected +3 more line");
  assert.ok(!plain.some((l) => l.includes("bd ready · beads_list")), "footer must be replaced by +more line");
  for (const l of lines) assert.equal(plainW(l), 90);
});

test("empty or tiny states emit nothing", () => {
  assert.deepEqual(widgetLines({ entries: [] }, 90, PAINTED), []);
  assert.deepEqual(widgetLines(state(), 10, PAINTED), []);
  assert.deepEqual(widgetLines(state(), 90, null), []);
});

test("charWidth takes code points (regression: flat range tables crashed render)", () => {
  assert.equal(charWidth(0x20), 1);
  assert.equal(charWidth(0x4e2d), 2); // 中
  assert.equal(charWidth(0x0301), 0); // combining acute
  assert.equal(displayWidth("a中b"), 4);
});

test("truncToWidth appends ellipsis only when cutting", () => {
  assert.equal(truncToWidth("abcdef", 10), "abcdef");
  const t = truncToWidth("abcdefghijk", 6);
  assert.equal(displayWidth(t), 6);
  assert.ok(t.endsWith("\u2026"));
});

test("formatAge buckets", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  assert.equal(formatAge("2026-01-01T11:45:00Z", now), "15m");
  assert.equal(formatAge("2026-01-01T09:00:00Z", now), "3h");
  assert.equal(formatAge("2025-12-29T12:00:00Z", now), "3d");
  assert.equal(formatAge("nonsense", now), "");
});

test("open rows keep the full age at the border (regression: glyph fragment measured one cell narrow, boxLine clamp ate the age)", () => {
  // Titles sized so body+gap nearly fills the row — the exact condition where
  // the old "\u25d0 " paint-vs-"1" text mismatch overflowed by one cell and the
  // right-border clamp chopped "12d" down to "1\u2026".
  const st = {
    entries: [
      { id: "modular-trading-au0.25.4.4", repo: "modular-trading", title: "Verify financial reconciliation, cross-mode parity and bounded read performance", priority: 1, age: "12d" },
      { id: "modular-trading-h81", repo: "modular-trading", title: "Define grid, spacing, typography and financial formatting primitives", priority: 1, age: "12d" },
      { id: "modular-trading-bfp.4.3", repo: "modular-trading", title: "Add the approved Codex onboarding adapter", priority: 2, age: "8d" },
    ],
    closedCount: 0,
    readyCount: 77,
  };
  for (const width of [80, 145, 217]) {
    const lines = widgetLines(st, width, PLAIN_THEME);
    const rows = lines.slice(1, 4);
    for (const row of rows) {
      const plain = STRIP(row);
      assert.equal(plainW(plain), width, `width ${width}: row not exact: ${JSON.stringify(plain.slice(-30))}`);
      // age intact at the right border: row ends "<age> │", never a chopped ellipsis
      assert.match(plain, /(12d|8d) +\u2502$/, `width ${width}: age chopped: ${JSON.stringify(plain.slice(-40))}`);
      // and the ONLY ellipsis allowed on these rows is a title cut, never next to the border
      assert.ok(!/\u2026 ?\u2502$/.test(plain), `width ${width}: ellipsis eaten into border: ${JSON.stringify(plain.slice(-40))}`);
    }
  }
});
