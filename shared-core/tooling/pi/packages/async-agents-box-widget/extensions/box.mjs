/* Vendored byte-exact from ~/.agents/packages/beads-box-widget/extensions/box.mjs
 * (same author, same house style) so this package stays self-contained: pi loads an
 * extension by file path, and a cross-package relative import would break the moment
 * either package moves. Keep the two copies in sync if the frame spec changes. */
/**
 * Shared box — Unicode box rendering primitives.
 * Dependency-free (no TUI / codegraph deps). Usable by both beads and pi-goal-x.
 *
 * Visual spec: one-tone frame (theme.fg("muted", …)) so chrome is neutral gray.
 * Content inside is colour-coded by the caller. Never emits a line wider
 * than requested terminal width — measurement strips ANSI before counting
 * display columns, so painted strings size identically to plain ones.
 */

// ── width helpers (ANSI-safe, wide-char-aware) ───────────────────────────────

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Strip SGR escapes for measurement/fallback truncation. */
export function stripAnsi(s) {
  return String(s).replace(ANSI_RE, "");
}

// Range tables MUST be [lo, hi] pairs — charWidth destructures them.
const WIDE = [
  [0x1100, 0x115f], // Hangul Jamo init
  [0x2e80, 0xa4cf], // CJK radicals …
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compat ideographs
  [0xfe30, 0xfe6f], // compat formats
  [0xff00, 0xff60], // fullwidth
  [0xffe0, 0xffe6], // fullwidth symbols
  [0x20000, 0x3fffd], // CJK extension B…Z
];

const COMBINING = [
  [0x0300, 0x036f], // combining marks
  [0x1ab0, 0x1aff], // combining diacritics
  [0x20d0, 0x20ff], // combining marks
  [0xfe00, 0xfe0f], // variation selectors
  [0xfe20, 0xfe2f], // compat forms
];

/** Display width of a single Unicode code point (0 = invisible, 2 = wide). */
export function charWidth(cp) {
  if (cp === 0x200d) return 0; // ZWJ
  if (COMBINING.some(([lo, hi]) => cp >= lo && cp <= hi)) return 0;
  if (WIDE.some(([lo, hi]) => cp >= lo && cp <= hi)) return 2;
  return 1;
}

/** Display width of a PLAIN string (no ANSI — callers strip first if painted). */
export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += charWidth(ch.codePointAt(0));
  return w;
}

/** Plain display width of a possibly-painted string. */
function plainWidth(s) {
  return displayWidth(stripAnsi(s));
}

/** Cut a PLAIN string to at most `width` display columns, appending "…" when cut. */
export function truncToWidth(s, width) {
  s = String(s);
  if (width <= 0) return "";
  if (displayWidth(s) <= width) return s;
  const budget = width - 1; // room for ellipsis
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return out + "\u2026";
}

// ── constants & helpers ──────────────────────────────────────────────────────

const H = "\u2500"; // ─
const V = "\u2502"; // │

/** Paint frame chrome — always muted/gray, never accent. */
export function frame(theme, value) {
  return theme.fg("muted", value);
}

/** Trim `value` to `width` display cols; painted input falls back to plain. */
export function fit(value, width) {
  if (plainWidth(value) <= width) return value;
  return truncToWidth(stripAnsi(value), width);
}

// ── box primitives ───────────────────────────────────────────────────────────
// Every primitive returns a line whose PLAIN width is exactly `width`
// (given width >= 6), for any painted-or-plain inputs.

/**
 * Top border + title bar:  `╭─ {left} ──── fill ──── {right} ╮`
 * left/right may already be painted by the caller.
 */
export function boxHeader(theme, width, left, right = "") {
  const inner = Math.max(4, width - 2);
  // right/left may arrive PAINTED — measure with ANSI stripped or every
  // color sequence silently eats fill columns.
  let rc = right ? plainWidth(right) + 3 : 0; // " right ─"
  let lBudget = inner - 2 - rc; // "─ " prefix + right block
  let dropRight = false;
  if (lBudget < 4) {
    // too tight for title + right meta — drop the meta to save the title
    rc = 0;
    lBudget = inner - 2;
    dropRight = true;
  }
  const lSlot = Math.max(1, lBudget);
  // fit() returns painted input untouched when it fits — clamp explicitly so
  // `used`/`fill` describe what actually lands on screen.
  const lText =
    plainWidth(left) <= lSlot ? left : truncToWidth(stripAnsi(left), lSlot);
  const lPre = `${frame(theme, H)} `; // "─ "
  const rBlk = right && !dropRight ? ` ${right} ${frame(theme, H)}` : "";
  const used = plainWidth(lPre) + plainWidth(lText) + rc;
  const fill = Math.max(0, inner - used);
  return `${frame(theme, "\u256d")}${lPre}${lText}${frame(theme, H.repeat(fill))}${rBlk}${frame(theme, "\u256e")}`;
}

/**
 * Content row:  `│ {content padded to inner width} │`
 * content may be painted; over-budget input degrades to plain truncation.
 */
export function boxLine(theme, width, content) {
  const inner = Math.max(2, width - 2);
  const budget = Math.max(0, inner - 1); // leading space
  const contentFit = plainWidth(content) > budget ? truncToWidth(stripAnsi(content), budget) : content;
  const pad = Math.max(0, budget - plainWidth(contentFit));
  return `${frame(theme, V)} ${contentFit}${" ".repeat(pad)}${frame(theme, V)}`;
}

/** Horizontal rule:  `├──────┤` */
export function boxRule(theme, width) {
  return frame(theme, `\u251c${H.repeat(Math.max(1, width - 2))}\u2524`);
}

/**
 * Section rule with label + optional right meta:
 * `├─ Label ─── fill ── right ┤`
 */
export function boxSectionRule(theme, width, label, right = "") {
  const inner = Math.max(4, width - 2);
  const rc = right ? plainWidth(right) + 2 : 0; // " right "
  const labBudget = Math.max(0, inner - 3 - rc); // "─ label " costs 2 + lw + 1
  const labF = fit(label, labBudget);
  const lBlk = `${frame(theme, H)} ${labF} `;
  const fill = Math.max(0, inner - plainWidth(lBlk) - rc);
  const rBlk = right ? ` ${right} ` : "";
  return `${frame(theme, "\u251c")}${lBlk}${frame(theme, H.repeat(fill))}${rBlk}${frame(theme, "\u2524")}`;
}

/**
 * Bottom border + hint:  `╰─ {content} ──── fill ──── {right} ╯`
 * Optional right slot for right-aligned meta.
 */
export function boxFooter(theme, width, content, right = "") {
  const inner = Math.max(4, width - 2);
  const rc = right ? plainWidth(right) + 3 : 0; // " right ─"
  if (!content && !right) return frame(theme, `\u2570${H.repeat(inner)}\u256f`);
  const cBudget = Math.max(0, inner - rc - 1); // leading space
  const cFit = content ? fit(content, cBudget) : "";
  const lBlk = content ? ` ${cFit}` : "";
  const fill = Math.max(0, inner - 1 - plainWidth(lBlk.slice(1)) - rc);
  const rBlk = right ? ` ${right} ${frame(theme, H)}` : "";
  return `${frame(theme, "\u2570")}${lBlk}${frame(theme, H.repeat(fill))}${rBlk}${frame(theme, "\u256f")}`;
}
