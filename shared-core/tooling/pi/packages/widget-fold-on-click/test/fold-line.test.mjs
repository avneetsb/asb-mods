/**
 * fold-line.test.mjs — unit tests for widget-fold-on-click's pure helpers.
 *
 * The invariants a live TUI punishes hardest: a folded line must never be wider
 * than the canvas pi handed the widget, must keep the producer's own bytes at the
 * front (so its colouring and counters survive), must stay visible as a folded
 * state, and the click gesture must not fire on a modified button, a wheel event,
 * or a row below the title.
 *
 *   node --test test/
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	buildFoldedLine,
	isTitleClick,
	lastCornerIndex,
	stripAnsi,
	truncateStyledToWidth,
	visibleWidth,
} from "../extensions/fold-line.mjs";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const RED = ESC + "[31m";
const RESET = ESC + "[0m";
const DIM = ESC + "[2m";
const OSC_LINK = ESC + "]8;;https://example.com" + BEL + "text" + ESC + "]8;;" + BEL;

/**
 * A widget title row in the house shape: coloured brand text, a muted dash rule,
 * closed by ╮ — padded to EXACTLY `width`, the same invariant beads-box-widget
 * enforces (that padding is why folding has to eat dashes rather than append).
 */
function frame(label, width) {
	const room = Math.max(0, width - 2); // one column for the space, one for ╮
	const cut = visibleWidth(label) <= room ? label : truncateStyledToWidth(label, room - 1);
	const inner = `${RED}${cut}${RESET} `;
	const rule = Math.max(0, width - visibleWidth(inner) - 1);
	return inner + "─".repeat(rule) + "╮";
}

test("visibleWidth ignores ANSI and counts wide glyphs", () => {
	assert.equal(visibleWidth(`${RED}abc${RESET}`), 3);
	assert.equal(visibleWidth("日本語"), 6);
	assert.equal(visibleWidth(OSC_LINK), 4, "hyperlink shows its 4 visible chars");
	assert.equal(stripAnsi(`${RED}x${RESET}`), "x");
});

test("truncateStyledToWidth cuts by columns, never inside an escape or a pair", () => {
	const line = `${RED}日本語 abc${RESET}`;
	const cut = truncateStyledToWidth(line, 5);
	assert.equal(cut, `${RED}日本`, "cuts at the first glyph that would not fit, so no ragged tail");
	assert.ok(cut.startsWith(RED), "colour code carried whole, not sliced");
	assert.equal(truncateStyledToWidth("😀ab", 2), "😀", "astral glyph moves as one code point");
	assert.equal(visibleWidth(truncateStyledToWidth(line, 0)), 0, "budget 0 draws nothing; a carried colour code is invisible");
});

test("lastCornerIndex finds the frame corner past escape sequences", () => {
	const line = frame("goal", 40);
	assert.ok(lastCornerIndex(line) > 0);
	assert.equal(visibleWidth(line.slice(0, lastCornerIndex(line))), visibleWidth(line) - 1);
	// A colour code must never be mistaken for content: no corner here.
	assert.equal(lastCornerIndex(`${RED}plain${RESET}`), -1);
});

test("folding eats rule dashes, not the producer's text", () => {
	const line = frame("⦿ beads ─── 6 active · 40 ready", 70);
	const folded = buildFoldedLine(line, 70);

	assert.match(stripAnsi(folded), /6 active · 40 ready/, "counters still readable");
	assert.match(stripAnsi(folded), /▸ folded/, "folded state is visible");
	assert.ok(folded.startsWith(RED), "original colouring preserved byte-for-byte");
	assert.ok(folded.endsWith("╮"), "frame stays closed");
	assert.equal(visibleWidth(folded), 70, "still flush to the canvas");
	const runOf = (s) => Math.max(0, ...(stripAnsi(s).match(/─+/g) ?? []).map((run) => run.length));
	assert.ok(runOf(folded) < runOf(line), "the rule gave its columns to the marker");
});

test("width invariant holds from a roomy canvas down to an absurd one", () => {
	const wide = frame("pi-lens ●44E !6W ─ Findings · 7 open", 80);

	for (const width of [80, 60, 45, 30, 20, 12, 4]) {
		const folded = buildFoldedLine(wide, width);
		assert.ok(visibleWidth(folded) <= width, `width ${width} overflowed: ${visibleWidth(folded)}`);
	}

	// Marker still advertised well past the point where appending would have failed.
	assert.match(stripAnsi(buildFoldedLine(wide, 45)), /▸ folded/);
	assert.match(stripAnsi(buildFoldedLine(wide, 24)), /▸/);

	// A canvas too narrow for any hint clamps the title instead of overflowing it.
	assert.ok(visibleWidth(buildFoldedLine(wide, 6)) <= 6);
});

test("unframed widget lines fold the same way", () => {
	const plain = "⠴ Async agents · background";
	const folded = buildFoldedLine(plain, 60);
	assert.ok(stripAnsi(folded).startsWith("⠴ Async agents"), "producer text kept in front");
	assert.match(stripAnsi(folded), /▸ folded/);
	assert.ok(visibleWidth(folded) <= 60);
	assert.ok(visibleWidth(buildFoldedLine(plain, 10)) <= 10);
});

test("decorate paints the marker, and a broken decorate cannot lose the line", () => {
	const line = frame("goal", 50);

	const painted = buildFoldedLine(line, 50, { decorate: (text) => `${DIM}${text}${RESET}` });
	assert.ok(painted.includes(DIM), "marker dimmed");
	assert.match(stripAnsi(painted), /▸ folded/);
	assert.equal(visibleWidth(painted), 50);

	const broken = buildFoldedLine(line, 50, {
		decorate: () => {
			throw new Error("theme blew up");
		},
	});
	assert.equal(visibleWidth(broken), 50, "still an exact-width line");
	assert.match(stripAnsi(broken), /▸ folded/, "marker falls back to unstyled");
});

test("degenerate inputs cannot throw", () => {
	assert.equal(buildFoldedLine("", 40), "");
	assert.equal(buildFoldedLine(undefined, 40), undefined);
	assert.equal(buildFoldedLine(null, 40), null);
	assert.equal(buildFoldedLine("x", 0), "");
	assert.equal(visibleWidth(buildFoldedLine("日本語", 1)), 0);
});

test("isTitleClick accepts only an unmodified left click on the title row", () => {
	const click = { type: "click", button: "left", x: 4, y: 0 };
	assert.equal(isTitleClick(click), true);

	assert.equal(isTitleClick({ ...click, y: 1 }), false, "body rows belong to the widget");
	assert.equal(isTitleClick({ ...click, button: "right" }), false);
	assert.equal(isTitleClick({ ...click, button: "middle" }), false);
	assert.equal(isTitleClick({ ...click, type: "wheel", button: "none" }), false);
	assert.equal(isTitleClick({ ...click, type: "press" }), false, "press must not toggle before click");
	assert.equal(isTitleClick({ ...click, shift: true }), false);
	assert.equal(isTitleClick({ ...click, alt: true }), false);
	assert.equal(isTitleClick({ ...click, ctrl: true }), false);
	assert.equal(isTitleClick(undefined), false);
	assert.equal(isTitleClick({}), false);
});

test("full canvas sweep 20..200 never breaks the width invariant", () => {
	for (let width = 20; width <= 200; width += 1) {
		const line = frame("pi-goal-x ─ Implement, verify and close beads", width);
		assert.equal(visibleWidth(line), width, `fixture must be exact at ${width}`);
		const folded = buildFoldedLine(line, width);
		assert.ok(visibleWidth(folded) <= width, `width ${width} overflowed: ${visibleWidth(folded)}`);
		if (width >= 40) {
			assert.match(stripAnsi(folded), /▸ folded/, `width ${width} lost the fold hint`);
		}
	}
});
