/**
 * fold-line.mjs — pure, testable helpers for widget-fold-on-click.
 *
 * Self-contained ANSI-aware width math (no pi-tui runtime import), same rules as
 * the operator's other widget wrappers (lens-diagnostic-pane, beads-box-widget):
 * pi resets styling after every line and a widget line wider than the supplied
 * canvas corrupts the layout, so folding must never widen a line.
 *
 * Why re-flow rather than append: those frames pad their title row to the full
 * terminal width (`╭─ pi-lens ●44E !6W ───…───╮`), so there is never free room at
 * the end of it. Folding therefore shortens the rule and puts the marker where the
 * eaten columns were — text survives, dashes go, and the folded state is visible.
 *
 * Control characters come from String.fromCharCode so this source stays free of
 * escape sequences (a literal ESC in a regex is invisible and easy to corrupt).
 */

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const BACKSLASH = String.fromCharCode(92);

/** Zero- and double-width table (mirrors lens-diagnostic-pane charWidth). */
function charWidth(cp) {
	if (
		cp === 0x200b ||
		(cp >= 0x300 && cp <= 0x36f) ||
		(cp >= 0x1ab0 && cp <= 0x1aff) ||
		(cp >= 0x200c && cp <= 0x200f)
	) {
		return 0;
	}
	return cp >= 0x1100 &&
		(cp <= 0x115f ||
			cp === 0x2329 ||
			cp === 0x232a ||
			(cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
			(cp >= 0xac00 && cp <= 0xd7a3) ||
			(cp >= 0xf900 && cp <= 0xfaff) ||
			(cp >= 0xfe30 && cp <= 0xfe6f) ||
			(cp >= 0xff00 && cp <= 0xff60) ||
			(cp >= 0xffe0 && cp <= 0xffe6) ||
			(cp >= 0x1f300 && cp <= 0x1f64f) ||
			(cp >= 0x1f900 && cp <= 0x1f9ff) ||
			(cp >= 0x20000 && cp <= 0x3fffd))
		? 2
		: 1;
}

/** Index just past the escape sequence starting at `i` (CSI, or OSC-8 hyperlink). */
function skipEscape(value, i) {
	const next = value[i + 1];
	if (next === "]") {
		for (let j = i + 2; j < value.length; j += 1) {
			if (value[j] === BEL) return j + 1;
			if (value[j] === ESC && value[j + 1] === BACKSLASH) return j + 2;
		}
		return value.length;
	}
	if (next !== "[") return i + 1;
	let j = i + 2;
	while (j < value.length && (value[j] === ";" || (value[j] >= "0" && value[j] <= "?"))) j += 1;
	if (j < value.length) j += 1; // CSI final byte
	return j;
}

export function stripAnsi(value) {
	const text = String(value);
	let out = "";
	for (let i = 0; i < text.length; ) {
		if (text[i] === ESC) {
			i = skipEscape(text, i);
			continue;
		}
		out += text[i];
		i += 1;
	}
	return out;
}

export function visibleWidth(value) {
	let width = 0;
	for (const ch of stripAnsi(value)) width += charWidth(ch.codePointAt(0));
	return width;
}

/**
 * Column-safe cut of a *styled* line: escape sequences are carried whole (never cut
 * in half), glyphs move as code points (no split surrogate pairs), wide glyphs cost
 * two columns. Styling opened before the cut stays open — pi resets every rendered
 * line, and re-emitting a reset here would rewrite the producer's bytes.
 */
export function truncateStyledToWidth(value, budget) {
	const limit = Math.max(0, Math.floor(budget));
	let out = "";
	let width = 0;
	for (let i = 0; i < value.length; ) {
		if (value[i] === ESC) {
			const next = skipEscape(value, i);
			out += value.slice(i, next);
			i = next;
			continue;
		}
		const cp = value.codePointAt(i);
		const glyph = String.fromCodePoint(cp);
		const advance = charWidth(cp);
		if (width + advance > limit) break;
		out += glyph;
		width += advance;
		i += glyph.length;
	}
	return out;
}

const CORNERS = new Set(["╮", "┐", "┓", "╗"]);

/**
 * Index of the frame's top-right corner in a *styled* line — escape sequences are
 * stepped over, so a colour code is never mistaken for content — or -1 when the
 * widget is unframed.
 */
export function lastCornerIndex(line) {
	let last = -1;
	for (let i = 0; i < line.length; ) {
		if (line[i] === ESC) {
			i = skipEscape(line, i);
			continue;
		}
		if (CORNERS.has(line[i])) last = i;
		i += 1;
	}
	return last;
}

/**
 * The single line a folded frame shows: the producer's own title (so its live
 * counters — "6 active · 40 ready", "●44E !6W" — stay readable) shortened as needed
 * to make room for a dim marker before the closing corner. Guarantees: never wider
 * than `width`, prefix of the original title preserved byte-for-byte (colouring
 * included), corner kept when the frame had one. In a canvas too narrow for any
 * marker the title is simply clamped, because an overflowing line costs more than a
 * missing hint.
 */
export function buildFoldedLine(line, width, options = {}) {
	const { marker = " ▸ folded", shortMarker = " ▸", decorate } = options;
	if (typeof line !== "string" || line.length === 0) return line;

	const paint = (text) => {
		if (typeof decorate !== "function") return text;
		try {
			const painted = decorate(text);
			return typeof painted === "string" && painted.length > 0 ? painted : text;
		} catch {
			return text; // a broken theme must not lose the line
		}
	};

	const budget = Math.max(0, Math.floor(width));
	const corner = lastCornerIndex(line);
	const head = corner >= 0 ? line.slice(0, corner) : line;
	const tail = corner >= 0 ? line.slice(corner) : "";
	const tailWidth = visibleWidth(tail);

	for (const text of [paint(marker), paint(shortMarker)]) {
		const room = budget - tailWidth - visibleWidth(text);
		if (room < 1) continue;
		const shown = visibleWidth(head) <= room ? head : truncateStyledToWidth(head, room);
		const candidate = shown + text + tail;
		if (visibleWidth(candidate) <= budget) return candidate;
	}

	return visibleWidth(line) <= budget ? line : truncateStyledToWidth(line, budget);
}

/**
 * The one gesture this extension owns: an unmodified left click on the frame's
 * title row (component-local y === 0) — the same hit rule pi-subagents uses on its
 * async-agents header, so panels behave alike.
 */
export function isTitleClick(event) {
	return (
		!!event &&
		event.type === "click" &&
		event.button === "left" &&
		event.y === 0 &&
		!event.shift &&
		!event.alt &&
		!event.ctrl
	);
}
