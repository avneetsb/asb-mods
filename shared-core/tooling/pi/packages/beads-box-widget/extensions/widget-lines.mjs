/**
 * beads-box-widget — boxed "in progress" rows for the beads WIP panel.
 * Renders a bordered box in pi-goal-x's house style via ./box.mjs.
 *
 * state: {
 *   entries: [{ id, repo?, title?, priority?, age?, closed? }, ...],
 *   closedCount?: number,          // closed this SESSION (header counter)
 *   readyCount?: number | null,    // null/undefined => segment omitted, never "0"
 * }
 * width: terminal columns (already adjusted by caller)
 * theme: { fg(color, text), strikethrough(text) } — pi's theme; omitted => plain
 */

import {
  boxHeader, boxLine, boxFooter,
  displayWidth, truncToWidth, stripAnsi,
} from "./box.mjs";

/** Age of a started_at timestamp as "12m" / "3h" / "2d"; "" when unknown. */
export function formatAge(startedAt, now = Date.now()) {
  const t = Date.parse(startedAt ?? "");
  if (!Number.isFinite(t)) return "";
  const min = Math.floor((now - t) / 60000);
  if (!Number.isFinite(min) || min < 0) return "";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}


/**
 * Lay fragments left→right inside `bodyWidth`. Each fragment has `text` and
 * optional `paint(theme) → string`. The text is cut to fit; the paint receives
 * the already-cut piece. Returns `{ plain, text, width }` twins.
 */
function assemble(frags, bodyWidth, th) {
  let used = 0;
  let plain = "";
  let out = "";
  for (const f of frags) {
    if (!f.text) continue;
    if (used >= bodyWidth) break;
    const piece = truncToWidth(f.text, bodyWidth - used);
    if (!piece) break;
    plain += piece;
    out += f.paint ? f.paint(piece, th) : piece;
    used += displayWidth(piece);
  }
  return { plain, text: out, width: used };
}

/** Pad a string to exactly `target` display columns (ANSI-aware). */
function padTo(str, target) {
  const w = displayWidth(stripAnsi(str));
  return str + " ".repeat(Math.max(0, target - w));
}

const MAX_ROWS = 6;

const prioColor = [undefined, "error", "warning", "muted", "muted"]; // 0..4

function emitPad(_fg, prio) {
  return prio !== undefined ? `P${prio} ` : "";
}

export function widgetLines(state, width, theme) {
  // pi hands theme as an object with .fg(); accept a bare function defensively.
  const th =
    typeof theme === "function" ? { fg: theme, strikethrough: (s) => s } : theme;
  if (!th || typeof th.fg !== "function") return [];
  const fg = th.fg.bind(th);

  const all = Array.isArray(state?.entries) ? state.entries : [];
  if (all.length === 0 || !(width > 10)) return [];

  const active = all.filter((e) => !e.closed);
  const ordered = [...active, ...all.filter((e) => e.closed)];
  const shown = ordered.slice(0, MAX_ROWS);
  const hidden = ordered.length - shown.length;

  // ---- header ----
  const segs = [`${active.length} active`];
  if (state?.closedCount > 0) segs.push(`${state.closedCount} done`);
  if (Number.isFinite(state?.readyCount))
    segs.push(`${state.readyCount} ready`);

  const header = boxHeader(
    th,
    width,
    `${fg("accent", "\u29BF beads")}`,
    fg("muted", segs.join(" \u00b7 "))
  );

  // ---- body sizing: box chrome costs "│ " left and " │" right → 3 cols ----
  const ageW = shown.reduce((max, e) => {
    const a = e.age ? String(e.age).length : 0;
    return Math.max(max, a);
  }, 0);
  const reserve = ageW > 0 && width - 3 - (ageW + 2) > 10 ? ageW + 2 : 0;
  const bodyWidth = Math.max(4, width - 3 - reserve);

  // ---- column widths (plain only, for alignment) ----
  const idW = shown.reduce((max, e) => Math.max(max, String(e.id ?? "").length), 0);
  const repoW = shown.reduce((max, e) => {
    const cell = e.repo ? `[${e.repo}]` : "";
    return Math.max(max, cell.length);
  }, 0);

  const rows = shown.map((e, i) => {
    const last = i === shown.length - 1 && hidden === 0;
    const prioStr = emitPad(fg, e.priority);
    const repoCell = e.repo ? `[${e.repo}]` : "";

    if (e.closed) {
      // Closed rows: monochrome muted + strike-through
      const body = assemble(
        [
          { text: last ? "\u2514\u2500 " : "\u251c\u2500 ", paint: (t) => fg("dim", t) },
          { text: "\u2713 ", paint: (t) => fg("success", t) },
          { text: prioStr, paint: (t) => fg(prioColor[e.priority] || "muted", t) },
          { text: `${padTo(e.id ?? "", idW)}  `, paint: (t) => fg("muted", t) },
          { text: repoW ? `${padTo(repoCell, repoW)} ` : "", paint: (t) => repoCell ? fg("dim", t) : t },
          { text: e.title || "", paint: (t) => fg("muted", th.strikethrough ? th.strikethrough(t) : t) },
        ],
        bodyWidth,
        th
      );
      const age = e.age ? fg("dim", e.age) : "";
      return age && reserve ? body.text + " ".repeat(Math.max(1, bodyWidth - body.width + 1)) + age : body.text;
    }

    // Open row: priority symbol in priority color, id muted, title in text
    const prioCol = prioColor[e.priority] || "muted";
    const body = assemble(
      [
        { text: last ? "\u2514\u2500 " : "\u251c\u2500 ", paint: (t) => fg("dim", t) },
        { text: "\u25d0 ", paint: (t) => fg(prioCol, t) },
        { text: prioStr, paint: (t) => fg(prioCol, t) },
        { text: `${padTo(String(e.id ?? ""), idW)}  `, paint: (t) => fg("muted", t) },
        { text: repoW ? `${padTo(repoCell, repoW)} ` : "", paint: (t) => repoCell ? fg("dim", t) : t },
        { text: e.title || "", paint: (t) => fg("text", t) },
      ],
      bodyWidth,
      th
    );
    const age = e.age ? fg("dim", e.age) : "";
    return age && reserve ? body.text + " ".repeat(Math.max(1, bodyWidth - body.width + 1)) + age : body.text;
  });

  // ---- assemble output (rows get the │ chrome from boxLine) ----
  const lines = [header, ...rows.map((r) => boxLine(th, width, r))];

  // ---- "more" row or footer ----
  if (hidden > 0) {
    lines.push(boxLine(th, width, fg("dim", truncToWidth(`+${hidden} more`, bodyWidth))));
  } else if (rows.length > 0) {
    lines.push(boxFooter(th, width, "bd ready · beads_list"));
  }

  return lines;
}
