/**
 * lens-diagnostic-pane.ts — pi-goal-x–styled diagnostics pane for pi-lens.
 * User-owned extension (custom, local pi package `lens-diagnostic-pane`).
 *
 * Why this exists: pi-lens mounts its own below-editor widget ("pi-lens ●6E !9W"
 * + stacked finding lines) which is dense and unframed. pi-goal-x proves the
 * house style the operator likes: rounded box, one-tone gray chrome, section
 * rules with a right-aligned progress bar, colour-coded content, and total
 * silence when there is nothing to report. This component re-renders the SAME
 * findings pi-lens already publishes in that style. It touches no pi-lens code.
 *
 * Data source (verified 2026-10-29 against pi-lens dist/index.js):
 *   pi.events "pilens:diagnostics" v1 — published after every analysis round:
 *     { v:1, source:"pi-lens", cwd, seq, ts,
 *       files: [ { path, diagnostics: [ { severity, line?, rule?, message,
 *                  uri?, stale? } ], truncated? } ] }
 *   An empty `diagnostics` array means the file became clean. Publishing is on
 *   unless PI_LENS_BUS_PUBLISH=0 (pi-lens dist isBusPublishEnabled).
 *
 * Layout mirrors pi-goal-x's dashboard spec (goal-dashboard-renderer.ts §5):
 *   broad frames in theme muted, accent brand, mdHeading ids, error/warning
 *   content colors, `█░` progress bar showing fixed-vs-affected files, and a
 *   footer with the last-update time + project name. Responsive row budgets at
 *   widths 100/70/50; box unregisters entirely when nothing is outstanding.
 *
 * Companion config (required, applied once): ~/.pi-lens/config.json
 *   { "widget": { "visible": false } }   ← hides pi-lens' native widget
 * (`/lens-widget-toggle` remains a session-only override and would show both;
 * run it again to hide the native one.)
 *
 * Known limitation: state is session-scoped. The pane appears when the first
 * pilens:diagnostics payload of the session lands (pi-lens re-analyses on
 * touch), it cannot restore yesterday's dirty files — the bus replays nothing.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const BUS_EVENT = "pilens:diagnostics";
const BUS_VERSION = 1;
const WIDGET_KEY = "lens-pane";

/* ── width-safe text helpers (self-contained; no pi-tui runtime import) ───── */

const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]|\u001b\]8;;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

function stripAnsi(value: string): string {
	return value.replace(ANSI_RE, "");
}

function cleanInline(value: string): string {
	return stripAnsi(value)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function charWidth(cp: number): number {
	return (
		cp === 0x200b ||
		(cp >= 0x300 && cp <= 0x36f) ||
		(cp >= 0x1ab0 && cp <= 0x1aff) ||
		(cp >= 0x200c && cp <= 0x200f)
	)
		? 0
		: cp >= 0x1100 &&
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

function visibleWidth(value: string): number {
	let w = 0;
	for (const ch of stripAnsi(value)) w += charWidth(ch.codePointAt(0) ?? 0);
	return w;
}

function fitWidth(value: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(value) <= width) return value;
	// ANSI-aware truncate: rebuild the styled string until the budget, keeping
	// escape sequences free. (Content here is short and mostly unstyled; the
	// simple pass over codepoints with escape carry-through is sufficient.)
	let out = "";
	let used = 0;
	let i = 0;
	const chars = Array.from(value);
	while (i < chars.length) {
		const ch = chars[i]!;
		if (ch === "\u001b") {
			const end = chars.findIndex((c, j) => j > i && /[A-Za-z]/.test(c));
			if (end > 0) {
				out += chars.slice(i, end + 1).join("");
				i = end + 1;
				continue;
			}
		}
		const cw = charWidth(ch.codePointAt(0) ?? 0);
		if (used + cw > width - 1) break;
		out += ch;
		used += cw;
		i++;
	}
	return out + "…";
}

/* ── state (built from pilens:diagnostics payloads; session-scoped) ───────── */

interface PaneFinding {
	severity: "error" | "warning";
	line?: number;
	rule?: string;
	message: string;
	stale: boolean;
}

interface PaneFile {
	path: string; // normalized absolute path
	findings: PaneFinding[];
	truncated: boolean;
	updatedAt: number;
}

export interface PaneState {
	cwd: string;
	files: Map<string, PaneFile>; // only files with open findings
	fixedCount: number; // files reported clean this session
	lastUpdate: number; // ts of last applied payload
	dedupeKey: string; // `${seq}:${ts}` of last applied payload
}

function createState(cwd: string): PaneState {
	return { cwd, files: new Map(), fixedCount: 0, lastUpdate: 0, dedupeKey: "" };
}

function normalizeCwd(value: string): string {
	return value.replace(/\/+$/, "");
}

interface BusDiagnosticItem {
	severity?: unknown;
	line?: unknown;
	rule?: unknown;
	message?: unknown;
	stale?: unknown;
}
interface BusFileEntry {
	path?: unknown;
	diagnostics?: unknown;
	truncated?: unknown;
}
interface BusPayload {
	v?: unknown;
	source?: unknown;
	cwd?: unknown;
	seq?: unknown;
	ts?: unknown;
	files?: unknown;
}

/** Apply one pilens:diagnostics payload. Returns true if state changed. */
export function applyPayload(state: PaneState, data: unknown, now: number): boolean {
	const p = data as BusPayload | undefined;
	if (!p || p.v !== BUS_VERSION || p.source !== "pi-lens") return false;
	if (typeof p.cwd !== "string" || normalizeCwd(p.cwd) !== state.cwd) return false;
	if (!Array.isArray(p.files)) return false;
	const dedupeKey = `${typeof p.seq === "number" ? p.seq : ""}:${typeof p.ts === "number" ? p.ts : ""}`;
	if (dedupeKey === state.dedupeKey) return false; // exact re-delivery
	state.dedupeKey = dedupeKey;

	let changed = false;
	for (const raw of p.files as BusFileEntry[]) {
		if (!raw || typeof raw.path !== "string" || !raw.path) continue;
		const diagsRaw = Array.isArray(raw.diagnostics) ? (raw.diagnostics as BusDiagnosticItem[]) : [];
		const findings: PaneFinding[] = [];
		for (const d of diagsRaw) {
			const sev = d?.severity;
			if (sev !== "error" && sev !== "warning") continue; // info/hint stay out of the pane
			const message = cleanInline(typeof d.message === "string" ? d.message : "");
			if (!message) continue;
			findings.push({
				severity: sev,
				line: typeof d.line === "number" && d.line > 0 ? d.line : undefined,
				rule: typeof d.rule === "string" && d.rule ? cleanInline(d.rule) : undefined,
				message,
				stale: d.stale === true,
			});
		}
		const key = raw.path;
		if (findings.length === 0) {
			if (state.files.delete(key)) {
				state.fixedCount += 1;
				changed = true;
			}
			continue;
		}
		findings.sort((a, b) => (a.severity === b.severity ? (a.line ?? 0) - (b.line ?? 0) : a.severity === "error" ? -1 : 1));
		const prev = state.files.get(key);
		const next: PaneFile = {
			path: key,
			findings,
			truncated: raw.truncated === true,
			updatedAt: typeof p.ts === "number" ? p.ts : now,
		};
		if (
			!prev ||
			prev.truncated !== next.truncated ||
			prev.findings.length !== next.findings.length ||
			prev.findings.some((f, i) => {
				const n = next.findings[i]!;
				return f.severity !== n.severity || f.line !== n.line || f.rule !== n.rule || f.message !== n.message;
			})
		) {
			state.files.set(key, next);
			changed = true;
		}
	}
	if (changed) state.lastUpdate = typeof p.ts === "number" && p.ts > 0 ? p.ts : now;
	return changed;
}

/* ── theme shim (structurally compatible with pi's Theme) ───────────────────── */

type ColorName = "accent" | "muted" | "dim" | "error" | "warning" | "success" | "mdHeading";
interface FgTheme {
	fg(color: ColorName, text: string): string;
}

/* ── box renderer (goal-x dashboard style: frames muted, ids amber-ish,
      content color-coded, right-aligned meta always survives truncation) ───── */

const H = "─";
const V = "│";

function frame(t: FgTheme, value: string): string {
	return t.fg("muted", value);
}

function boxHeader(t: FgTheme, width: number, left: string, right = ""): string {
	const inner = Math.max(4, width - 2);
	const l = `${frame(t, H)} ${left}`;
	const r = right ? ` ${right} ${frame(t, H)}` : "";
	const fixed = visibleWidth(l) + visibleWidth(r);
	if (fixed > inner - 2) {
		const budget = Math.max(4, inner - visibleWidth(r) - 4);
		const l2 = `${frame(t, H)} ${fitWidth(l, budget)}`;
		const fill = Math.max(1, inner - visibleWidth(l2) - visibleWidth(r));
		return `${frame(t, "╭")}${l2}${frame(t, H.repeat(fill))}${r}${frame(t, "╮")}`;
	}
	const fill = Math.max(1, inner - fixed);
	return `${frame(t, "╭")}${l}${frame(t, H.repeat(fill))}${r}${frame(t, "╮")}`;
}

function boxLine(t: FgTheme, width: number, content: string): string {
	const inner = Math.max(2, width - 2);
	const contentFit = fitWidth(content, inner - 1);
	const pad = Math.max(0, inner - 1 - visibleWidth(contentFit));
	return `${frame(t, V)} ${contentFit}${" ".repeat(pad)}${frame(t, V)}`;
}

function boxSectionRule(t: FgTheme, width: number, label: string, right = ""): string {
	const inner = Math.max(4, width - 2);
	const left = frame(t, `${H} ${label} `);
	const r = right ? ` ${right} ` : "";
	let l = left;
	if (visibleWidth(left) + visibleWidth(r) > inner) {
		const budget = Math.max(4, inner - visibleWidth(r) - 3);
		l = frame(t, `${H} ${fitWidth(label, budget)} `);
	}
	const fill = Math.max(0, inner - visibleWidth(l) - visibleWidth(r));
	return `${frame(t, "├")}${l}${frame(t, H.repeat(fill))}${r}${frame(t, "┤")}`;
}

function boxFooter(t: FgTheme, width: number, content: string, right = ""): string {
	const inner = Math.max(4, width - 2);
	const r = right ? ` ${right} ${frame(t, H)}` : "";
	if (!content && !r) return frame(t, `╰${H.repeat(inner)}╯`);
	const l = content ? frame(t, `${H} ${fitWidth(content, Math.max(0, inner - 4 - visibleWidth(r)))}`) : "";
	const fill = Math.max(1, inner - visibleWidth(l) - visibleWidth(r));
	return `${frame(t, "╰")}${l}${frame(t, H.repeat(fill))}${r}${frame(t, "╯")}`;
}

function progressBar(t: FgTheme, pct: number, barWidth: number): string {
	const safeBar = Math.max(2, barWidth);
	const filled = Math.min(safeBar, Math.max(0, Math.round((pct / 100) * safeBar)));
	return `[${t.fg("muted", "█".repeat(filled))}${t.fg("dim", "░".repeat(safeBar - filled))}]`;
}

function summarize(files: Iterable<PaneFile>): { errors: number; warnings: number } {
	let errors = 0;
	let warnings = 0;
	for (const f of files) {
		for (const d of f.findings) {
			if (d.severity === "error") errors += 1;
			else warnings += 1;
		}
	}
	return { errors, warnings };
}

function shortPath(absolute: string, cwd: string): string {
	const rel = absolute.startsWith(cwd + "/") ? absolute.slice(cwd.length + 1) : absolute;
	return rel || absolute;
}

function formatClock(ts: number): string {
	if (!ts) return "—";
	const d = new Date(ts);
	const two = (n: number) => String(n).padStart(2, "0");
	return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

interface LayoutSpec {
	maxFiles: number;
	perFile: number;
	barWidth: number;
	showDiagLines: boolean;
}

function specFor(width: number): LayoutSpec {
	if (width >= 100) return { maxFiles: 4, perFile: 2, barWidth: 8, showDiagLines: true };
	if (width >= 70) return { maxFiles: 3, perFile: 2, barWidth: 6, showDiagLines: true };
	if (width >= 50) return { maxFiles: 2, perFile: 1, barWidth: 5, showDiagLines: true };
	return { maxFiles: 1, perFile: 0, barWidth: 4, showDiagLines: false };
}

/** Pure view builder — exported for the demo/unit harness. */
export function buildPaneLines(state: PaneState, t: FgTheme, widthRaw: number): string[] {
	const width = Math.max(20, Math.floor(widthRaw || 80));
	const spec = specFor(width);
	const files = [...state.files.values()].sort(
		(a, b) => b.updatedAt - a.updatedAt || shortPath(a.path, state.cwd).localeCompare(shortPath(b.path, state.cwd)),
	);
	const counts = summarize(files);
	const shown = files.slice(0, spec.maxFiles);
	const totalTracked = state.fixedCount + state.files.size;
	const pct = totalTracked > 0 ? (state.fixedCount / totalTracked) * 100 : 0;

	const summary =
		counts.errors > 0
			? `${t.fg("error", `●${counts.errors}E`)}${counts.warnings > 0 ? ` ${t.fg("warning", `!${counts.warnings}W`)}` : ""}`
			: `${t.fg("warning", `!${counts.warnings}W`)}`;

	const lines: string[] = [];
	lines.push(boxHeader(t, width, `${t.fg("accent", "pi-lens")} ${t.fg("muted", "─")} ${summary}`, t.fg("muted", `${state.files.size} file${state.files.size === 1 ? "" : "s"}`)));
	lines.push(boxSectionRule(t, width, `Findings · ${state.files.size} open`, totalTracked > 0 ? `${t.fg("success", `✓${state.fixedCount}`)}${t.fg("dim", `/${totalTracked}`)} ${progressBar(t, pct, spec.barWidth)}` : ""));

	for (const f of shown) {
		const fc = summarize([f]);
		const marker = fc.errors > 0 ? t.fg("error", "●") : t.fg("warning", "!");
		const countsText = [fc.errors > 0 ? t.fg("error", `${fc.errors}E`) : "", fc.warnings > 0 ? t.fg("warning", `${fc.warnings}W`) : ""].filter(Boolean).join(" ");
		lines.push(boxLine(t, width, `${marker} ${t.fg("mdHeading", fitWidth(shortPath(f.path, state.cwd), Math.max(8, width - 24)))} ${countsText}`));
		if (spec.showDiagLines) {
			for (const d of f.findings.slice(0, spec.perFile)) {
				const sev = d.severity === "error" ? t.fg("error", "●") : t.fg("warning", "!");
				const loc = d.line != null ? t.fg(d.stale ? ("dim" as ColorName) : ("mdHeading" as ColorName), `L${d.line}`) : "";
				const rule = d.rule ? ` ${t.fg("dim", d.rule)}` : "";
				lines.push(boxLine(t, width, `  ${sev} ${loc}${rule} ${fitWidth(d.message, Math.max(8, width - 18))}${d.stale ? t.fg("dim", " ⟲") : ""}`));
			}
			const hidden = f.findings.length - spec.perFile;
			if (hidden > 0 || f.truncated) {
				const moreText = hidden > 0 ? `+${hidden} more` : "+more";
				lines.push(boxLine(t, width, `  ${t.fg("dim", f.truncated ? `${moreText} (capped by pi-lens)` : moreText)}`));
			}
		}
	}
	const moreFiles = state.files.size - shown.length;
	if (moreFiles > 0) lines.push(boxLine(t, width, t.fg("dim", `+${moreFiles} more file${moreFiles === 1 ? "" : "s"}`)));

	const projectName = state.cwd.split("/").filter(Boolean).pop() ?? state.cwd;
	lines.push(boxFooter(t, width, `updated ${formatClock(state.lastUpdate)}`, t.fg("dim", projectName)));
	return lines;
}

/* ── pi wiring ─────────────────────────────────────────────────────────────── */

export default function (pi: ExtensionAPI): void {
	if (!pi?.events) return;

	let state = createState(normalizeCwd(process.cwd()));
	let lastCtx: ExtensionContext | undefined;
	let registered = false;
	let tuiRef: { requestRender?: () => void } | undefined;

	function setWidgetGone(ctx: ExtensionContext | undefined): void {
		if (!registered || !ctx?.ui) return;
		try {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			/* best effort */
		}
		registered = false;
		tuiRef = undefined;
	}

	function sync(ctx: ExtensionContext | undefined): void {
		if (!ctx?.ui || ctx.hasUI === false) return;
		lastCtx = ctx;
		if (state.files.size === 0) {
			setWidgetGone(ctx);
			return;
		}
		if (!registered) {
			try {
				ctx.ui.setWidget(
					WIDGET_KEY,
					(tui: unknown, theme: FgTheme) => {
						tuiRef = tui as { requestRender?: () => void };
						return {
							render: (w: number) => buildPaneLines(state, theme, w),
							invalidate() {},
						};
					},
					{ placement: "belowEditor" },
				);
				registered = true;
			} catch {
				registered = false;
			}
			return;
		}
		try {
			tuiRef?.requestRender?.();
		} catch {
			/* host will repaint anyway */
		}
	}

	pi.events.on(BUS_EVENT, (data: unknown) => {
		if (applyPayload(state, data, Date.now())) sync(lastCtx);
	});

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		const cwd = normalizeCwd(typeof ctx?.cwd === "string" ? ctx.cwd : state.cwd);
		if (cwd !== state.cwd) {
			setWidgetGone(lastCtx ?? ctx);
			state = createState(cwd);
		}
		sync(ctx);
	});

	pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
		sync(ctx);
	});

	pi.on("session_shutdown", async () => {
		setWidgetGone(lastCtx);
	});
}
