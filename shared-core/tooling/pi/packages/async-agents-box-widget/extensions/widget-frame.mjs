/**
 * widget-frame.mjs — put pi-subagents' async-agents widget lines inside the house-style
 * box (same chrome as beads-box-widget / pi-goal-x) without re-deriving any run state.
 *
 * Pure + dependency-free: it receives the lines the upstream component already produced
 * and returns framed lines. Nothing here knows about jobs, status files or pi-subagents
 * internals beyond two presentation strings, both documented below.
 *
 * Contract with upstream (pi-subagents src/tui/render.js, verified 2026-11):
 *  - Header line, expanded multi-run form:  `⠴ Async agents · background`
 *  - Header line, folded/progressive form:   `⠴ Async agents · 2/4 running (3m), 1 queued`
 *    Both are lifted into the box header: spinner + title on the left, the counts tail on
 *    the right. When the expanded form carries no counts, the counters are recovered from
 *    the status glyphs upstream already paints on its own tree rows.
 *  - Status glyphs per row: braille spinner / ● running, ◦ queued, ✓ done, ■ stopped or
 *    paused, ✗ failed. A `+N more (…)` row counts as hidden runs, never as a run.
 *  - RPC mode renders a machine-readable payload whose first line starts with
 *    PI_SUBAGENT_ASYNC_JSON: (async-status-snapshot.js → ASYNC_STATUS_SNAPSHOT_WIDGET_PREFIX).
 *    That payload must reach the host byte-for-byte, so framing is skipped for it.
 *
 * Every returned line has plain display width exactly `width` (box.mjs guarantee), and the
 * whole block never exceeds MAX_TOTAL_LINES or the terminal height minus a margin.
 */

import { boxHeader, boxLine, boxFooter, stripAnsi } from "./box.mjs";

/** RPC-mode marker — a payload line, not UI. Never frame it. */
export const SNAPSHOT_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";

/** Upstream pads every widget line with one leading space; the box supplies its own. */
const UPSTREAM_INSET = 1;

/** `⠴ Async agents · background` / `⠴ Async agents · 2/4 running (3m)` */
const HEADER_RE = /^(?:(\S)\s+)?Async agents\s*\u00b7\s*(.*)$/;

/** Tree branch (├─ / └─) that opens an item row. */
const BRANCH_RE = /^[\u251c\u2514]\u2500\s+/;

/** `+5 more (5 running)` — hidden runs, counted not drawn. */
const MORE_RE = /\+(\d+) more\b/;

/** Non-braille status glyphs → the label upstream itself uses for them. */
const STATUS_GLYPHS = new Map([
  ["\u25cf", "running"], // ● queued-but-active header / active dot
  ["\u25ce", "running"],
  ["\u25e6", "queued"], // ◦
  ["\u2713", "done"], // ✓
  ["\u25a0", "stopped"], // ■ paused or stopped
  ["\u2717", "failed"], // ✗
]);

const isBrailleSpinner = (ch) => ch >= "\u2800" && ch <= "\u28ff";

/** Cap the framed block so the box chrome cannot push the chat viewport over. */
export const MAX_TOTAL_LINES = 14;

function neutralTheme() {
  return { fg: (_c, s) => s, strikethrough: (s) => s };
}

/** pi hands an object with .fg(); accept a bare function defensively (as beads does). */
function asTheme(theme) {
  if (typeof theme === "function") return { fg: (c, s) => theme(c, s), strikethrough: (s) => s };
  if (theme && typeof theme.fg === "function") return { fg: theme.fg.bind(theme), strikethrough: theme.strikethrough?.bind(theme) ?? ((s) => s) };
  return neutralTheme();
}

/** Drop upstream's own one-column inset so the tree sits flush inside the box body. */
function uninset(lines) {
  return lines.map((l) => (l.startsWith(" ".repeat(UPSTREAM_INSET)) ? l.slice(UPSTREAM_INSET) : l));
}

/** Classify the runs visible among `lines` from upstream's own status glyphs. */
function countRuns(lines) {
  const counts = new Map();
  let hidden = 0;
  for (const raw of lines) {
    const plain = stripAnsi(raw).trimEnd();
    const more = plain.match(MORE_RE);
    if (more) {
      hidden += Number(more[1]) || 0;
      continue;
    }
    // Only tree item rows are runs. Detail/continuation rows ("│  ⎿ …") describe one,
    // and a layout without branches (single run) exposes no reliable item boundary —
    // there the counters are simply omitted rather than guessed.
    const branch = plain.match(BRANCH_RE);
    if (!branch) continue;
    const body = plain.slice(branch[0].length);
    const ch = [...body][0];
    if (!ch) continue;
    const label = isBrailleSpinner(ch) ? "running" : STATUS_GLYPHS.get(ch);
    if (!label) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return { counts, hidden };
}

const COUNT_ORDER = ["running", "queued", "done", "failed", "stopped"];

function countSegments(counts, hidden) {
  const segs = COUNT_ORDER.filter((k) => counts.get(k)).map((k) => `${counts.get(k)} ${k}`);
  if (hidden > 0) segs.push(`+${hidden} hidden`);
  return segs;
}

/**
 * Frame upstream's lines.
 *
 * innerLines: string[] the upstream component rendered (ANSI allowed)
 * width:      terminal columns of the widget canvas (box occupies all of them)
 * theme:      pi theme ({ fg(color, text) }) — omitted or bare function still renders
 * opts:       { footer?: string, maxLines?: number }
 */
export function frameWidgetLines(innerLines, width, theme, opts = {}) {
  const th = asTheme(theme);
  const fg = th.fg;
  const lines = Array.isArray(innerLines) ? innerLines.filter((l) => typeof l === "string") : [];
  if (lines.length === 0 || !(width > 10)) return lines;

  // RPC payload must reach the host untouched.
  if (stripAnsi(lines[0]).trimStart().startsWith(SNAPSHOT_PREFIX)) return lines;

  const body = uninset(lines);
  const maxTotal = Math.max(6, Math.min(opts.maxLines ?? MAX_TOTAL_LINES, (process.stdout.rows || 40) - 6));

  // ── lift upstream's header line into the box title ─────────────────────────
  let head = null;
  const first = stripAnsi(body[0]).trim();
  const m = first.match(HEADER_RE);
  if (m) {
    head = { glyph: m[1] ?? "", tail: (m[2] ?? "").trim() };
    body.shift();
  }

  const isTag = head?.tail === "background";
  const derived = countRuns(body);
  const segs =
    head?.tail && !isTag
      ? head.tail.split(/,\s*/).map((s) => s.trim()).filter(Boolean) // upstream's own counters
      : countSegments(derived.counts, derived.hidden);

  // ⦿ keeps the panel identity (house style); upstream's own aggregate glyph — spinner
  // while any run is active, ● active, ○ idle — rides in front of the counters instead
  // of sitting next to ⦿, where two leading symbols read as a typo.
  const left = [
    fg("accent", "\u29BF async agents"),
    isTag ? ` ${fg("dim", "\u00b7 background")}` : "",
  ].join("");
  const right = [head?.glyph ? fg("accent", head.glyph) : "", segs.length ? fg("muted", segs.join(" \u00b7 ")) : ""]
    .filter(Boolean)
    .join(" ");

  // ── body rows: cap, then wrap each in │ … │ ───────────────────────────────
  const budget = Math.max(1, maxTotal - 2); // box header + footer
  let rows = body;
  if (rows.length > budget) {
    const dropped = rows.length - (budget - 1);
    rows = [...rows.slice(0, budget - 1), fg("dim", `+${dropped} more`)].slice(0, budget);
  }

  const out = [boxHeader(th, width, left, right)];
  // Folded upstream gives just its header line: keep that a genuine one-liner rather
  // than boxing an empty body (upstream's fold-to-one-line contract, unchanged).
  if (rows.length === 0) return out;
  for (const r of rows) out.push(boxLine(th, width, r));
  out.push(boxFooter(th, width, opts.footer ?? "click title to fold \u00b7 subagent status"));
  return out;
}

/**
 * Map a pointer event from framed coordinates back to the upstream component's own
 * rows: row 0 is our title bar, so a click there or on the first body row reaches
 * upstream's header click (which folds the widget to its one-line live status).
 * Returns null when the event should not reach the inner component at all.
 */
export function mapFramePointer(event) {
  if (!event || typeof event.y !== "number") return null;
  if (event.type !== "click") return { ...event, y: Math.max(0, event.y - 1) };
  if (event.y > 1) return { ...event, y: event.y - 1 };
  if (event.button !== undefined && event.button !== 0) return null;
  if (event.shift || event.alt || event.ctrl) return null;
  return { ...event, type: "click", button: 0, y: 0 };
}
