/**
 * widget-fold-on-click.ts — click a widget frame's title row to fold it to one line.
 * User-owned extension (local pi package `widget-fold-on-click`).
 *
 * Why this exists: three frames sit around the editor — pi-goal-x's goal dashboard
 * (above), the beads in-progress box (above) and the pi-lens diagnostics pane
 * (below). Only pi-subagents' async-agents widget can be folded by clicking today;
 * pi-goal-x ships no mouse handling at all (verified 2026-11-04 against
 * extensions/widgets/goal-widget.ts + goal-dashboard-renderer.ts: no handleMouse),
 * and beads-box-widget / lens-diagnostic-pane are the operator's own restylings of
 * slots whose upstream owners expose no fold knob. Machine policy forbids editing
 * npm-installed sources, and patching the two owned packages would duplicate the
 * same fold logic three times. So folding is added once, at pi's widget boundary:
 *
 *   - `ctx.ui.setWidget(key, content, options)` (interactive-mode.js
 *     `setExtensionWidget`) keeps one widget per key per placement and, for a
 *     non-array `content`, calls `content(this.ui, theme)` immediately and stores
 *     the returned component. Wrapping that factory wraps whatever the producer
 *     mounts, and producers keep updating their own component in place
 *     (pi-goal-x via `goalWidgetComponentRef.current.update()`), so their live
 *     counters, animations and refresh paths are untouched — this extension holds
 *     no widget data, only a fold flag per key.
 *   - The wrapper is a Proxy over the producer's component: `render` and
 *     `handleMouse` are re-anchored, everything else (`update`, `invalidate`,
 *     `dispose`, prototype methods, `instanceof`) passes through.
 *   - pi hit-tests the render layout and dispatches to each box's component with
 *     component-local coordinates (pi-tui `layout.js` `getLayoutBoxesAt` +
 *     `tui-alt-screen.js` `dispatchMouseToLayout`), so a click on a frame's first
 *     row arrives as `y === 0` no matter how many widgets share the placement.
 *
 * Constraint worth stating out loud: mouse events are captured only by the
 * full-screen (alt-screen) renderer — `tuiMode: "fullscreen"`, pi's default. In
 * `"regular"` mode the terminal owns the mouse and no click ever reaches a widget
 * (docs/tui.md "Handle mouse input"), which is why `/fold` exists as the keyboard
 * path and why `/fold list` reports which renderer is active.
 *
 * Install order matters: this package must load BEFORE the producers, so its
 * session_start handler patches `setWidget` before they mount (pi awaits event
 * handlers in extension load order). settings.json lists it immediately before
 * `npm:pi-goal-x`. If that ordering is ever broken, the affected frame simply
 * stays unfolded-and-unclickable until it re-mounts; `/fold list` says so instead
 * of failing silently.
 *
 * Safety rails: every wrapped render is inside try/catch and falls back to the
 * producer's own lines; a folded line is never wider than the canvas pi asked for;
 * unmount calls (`setWidget(key, undefined)`) pass straight through; and if this
 * package is uninstalled every producer renders exactly as before.
 */

import { buildFoldedLine, isTitleClick } from "./fold-line.mjs";

/**
 * Widget slots this extension folds, keyed by the pi widget key, valued by the
 * short name used in `/fold`. Widgets that already own a click-to-fold gesture
 * (pi-subagents' `subagent-async`) must NOT be added here — two toggles on one
 * click would cancel each other out.
 */
const WIDGET_LABELS: Record<string, string> = {
	goal: "goal", // pi-goal-x — widgets/goal-widget.ts GOAL_WIDGET_KEY, aboveEditor
	"beads-wip": "beads", // @abix5/pi-beads slot, restyled by beads-box-widget, aboveEditor
	"lens-pane": "lens", // lens-diagnostic-pane, belowEditor
};

/** Marks the function we installed, so `/reload` never wraps setWidget twice. */
const PATCHED = "__widgetFoldOnClickPatched";

/**
 * The PATCHED flag is a property pi's `setWidget` signature does not declare, so it
 * is read/written through a plain string-keyed bag. These two helpers are the only
 * place that bag is touched, and `unknown` is the honest input type: callers hand us
 * whatever callable sits on `ui`.
 */
function isPatched(fn: unknown): boolean {
	// SAFETY: PATCHED is a private name we alone set on the function we installed, so
	// reading it off any other callable is always undefined — never a false positive.
	return (fn as Record<string, unknown> | undefined)?.[PATCHED] === true;
}

function markPatched(fn: unknown): void {
	// SAFETY: `fn` is always the wrapper closure created immediately below, a plain
	// mutable object-valued callable we own; tagging it is what makes `/reload` safe.
	(fn as Record<string, unknown>)[PATCHED] = true;
}

type MouseEventLike = {
	type?: string;
	button?: string;
	x?: number;
	y?: number;
	shift?: boolean;
	alt?: boolean;
	ctrl?: boolean;
};

type Component = {
	render?: (width: number) => string[];
	handleMouse?: (event: MouseEventLike) => unknown;
	dispose?: () => void;
} & Record<string, unknown>;

type TuiLike = { requestRender?: () => void } & Record<string, unknown>;

type Theme =
	| ((color: string, text: string) => string)
	| { fg?: (color: string, text: string) => string }
	| undefined;

type WidgetFactory = (tui: TuiLike, theme: Theme) => Component;

type UiLike = {
	setWidget?: (key: string, content?: unknown, options?: { placement?: string }) => void;
	/** Alt-screen-only capability probe (TuiAltScreen defines it, TuiMainScreen does not). */
	getScreenLines?: () => unknown;
	[k: string]: unknown;
};

type StartCtx = { ui?: UiLike };

type CommandCtx = { ui?: UiLike; notify?: (message: string, type?: "info" | "warning" | "error") => void };

type PiExt = {
	on(event: "session_start", handler: (event?: unknown, ctx?: StartCtx) => void | Promise<void>): void;
	registerCommand(
		name: string,
		options: { description?: string; handler: (args: string, ctx: CommandCtx) => void | Promise<void> },
	): void;
	getSettings?: () => { tuiMode?: string };
	[k: string]: unknown;
};

/** Fold state, one per widget KEY (not per component): producers re-mount their
 *  slot freely (beads-box-widget reclaims `beads-wip` from upstream on every
 *  render; pi-goal-x re-registers on focus changes), and the operator's choice
 *  should survive that churn within the session. */
type FoldState = {
	key: string;
	label: string;
	collapsed: boolean;
	mounted: boolean;
	tui?: TuiLike;
	theme?: Theme;
};

const folds = new Map<string, FoldState>();

function foldState(key: string): FoldState {
	let state = folds.get(key);
	if (!state) {
		state = { key, label: WIDGET_LABELS[key] ?? key, collapsed: false, mounted: false };
		folds.set(key, state);
	}
	return state;
}

/**
 * Test-only: forget every remembered fold. `folds` is module state, so without this a
 * case that clicks a frame leaves the next case starting folded. pi only ever loads the
 * default export; this named export exists for `node --test`.
 */
export function __resetFoldsForTest(): void {
	folds.clear();
}

function dimText(theme: Theme, text: string): string {
	try {
		if (typeof theme === "function") return theme("dim", text);
		if (theme && typeof theme.fg === "function") return theme.fg("dim", text);
	} catch {
		/* theme unavailable — marker stays unstyled */
	}
	return text;
}

/**
 * Pass-through Proxy that owns exactly two behaviours: render (folded → one line)
 * and handleMouse (title click → toggle).
 */
function wrapComponent(inner: Component, state: FoldState): Component {
	if (!inner || typeof inner.render !== "function") return inner;
	state.mounted = true;

	const handler: ProxyHandler<Component> = {
		get(target, prop, _receiver) {
			if (prop === "render") {
				return (width: number): string[] => {
					let lines: string[] = [];
					try {
						lines = target.render?.(width) ?? [];
					} catch {
						return [];
					}
					if (!state.collapsed || lines.length === 0) return lines;
					try {
						return [
							buildFoldedLine(lines[0], width, {
								decorate: (text: string) => dimText(state.theme, text),
							}),
						];
					} catch {
						return lines; // folding must never blank a producer's panel
					}
				};
			}
			if (prop === "handleMouse") {
				return (event: MouseEventLike) => {
					if (isTitleClick(event)) {
						state.collapsed = !state.collapsed;
						try {
							state.tui?.requestRender?.();
						} catch {
							/* render request is best-effort; a later tick repaints */
						}
						return { handled: true };
					}
					return target.handleMouse?.(event); // everything else stays the owner's
				};
			}
			const value = target[prop as keyof Component];
			return typeof value === "function"
				? (value as (...args: unknown[]) => unknown).bind(target)
				: value;
		},
		set(target, prop, value) {
			return Reflect.set(target, prop, value);
		},
	};

	return new Proxy(inner, handler);
}

/** Capture (tui, theme) for repaint + styling, then wrap what the producer mounts. */
function wrapFactory(factory: WidgetFactory, state: FoldState): WidgetFactory {
	return (tui, theme) => {
		state.tui = tui;
		state.theme = theme;
		return wrapComponent(factory(tui, theme), state);
	};
}

function resolveKey(token: string): string | undefined {
	const needle = token.trim().toLowerCase();
	if (!needle) return undefined;
	if (WIDGET_LABELS[needle]) return needle; // full widget key
	const found = Object.keys(WIDGET_LABELS).find((key) => WIDGET_LABELS[key] === needle);
	if (found) return found; // short label ("beads" → "beads-wip")
	if (needle === "pane") return "lens-pane";
	return undefined;
}

function report(ui: UiLike | undefined, message: string): void {
	const notify = ui?.notify;
	if (typeof notify === "function") {
		notify.call(ui, message, "info");
		return;
	}
	// Headless / non-TUI: still tell the operator what happened.
	process.stdout.write(message + String.fromCharCode(10));
}

function describe(state: FoldState): string {
	const mark = state.collapsed ? "folded" : "open";
	const hooked = state.mounted ? "" : " (not mounted right now)";
	return `${state.label.padEnd(6)} ${mark}${hooked}`;
}

function fullscreenActive(ui: UiLike | undefined, pi: PiExt): boolean {
	if (typeof ui?.getScreenLines === "function") return true;
	if (ui && Object.prototype.hasOwnProperty.call(ui, "getScreenLines")) return false;
	try {
		return pi.getSettings?.()?.tuiMode !== "regular";
	} catch {
		return true;
	}
}

export default function activate(pi: PiExt) {
	pi.registerCommand("fold", {
		description:
			"Fold/unfold the goal, beads and lens frames (click a frame title in fullscreen; /fold [list|all|none|names])",
		handler: async (args: string, ctx: CommandCtx) => {
			const ui = ctx?.ui;
			const tokens = String(args ?? "")
				.trim()
				.toLowerCase()
				.split(/\s+/)
				.filter(Boolean);

			const mounted = [...folds.values()];
			const hint = fullscreenActive(ui, pi)
				? "click a frame title to toggle"
				: 'mouse needs tuiMode "fullscreen" — use /fold here';

			if (tokens.length === 0 || tokens[0] === "list") {
				const body = mounted.length > 0 ? mounted.map(describe).join(" · ") : "no frames mounted yet";
				report(ctx?.ui, `fold: ${body} — ${hint}`);
				return;
			}

			if (tokens[0] === "all" || tokens[0] === "none") {
				const collapse = tokens[0] === "all";
				const touched = mounted.filter((state) => state.mounted && state.collapsed !== collapse);
				for (const state of touched) state.collapsed = collapse;
				try {
					mounted.find((state) => state.mounted)?.tui?.requestRender?.();
				} catch {
					/* best-effort repaint */
				}
				report(
					ctx?.ui,
					`${collapse ? "folded" : "expanded"} ${touched.length} of ${mounted.filter((s) => s.mounted).length} frames`,
				);
				return;
			}

			const lines: string[] = [];
			for (const token of tokens) {
				const key = resolveKey(token);
				if (!key) {
					lines.push(`${token}: unknown frame (try ${Object.values(WIDGET_LABELS).join(", ")})`);
					continue;
				}
				const state = foldState(key);
				if (!state.mounted) {
					lines.push(`${state.label}: not mounted right now`);
					continue;
				}
				state.collapsed = !state.collapsed;
				try {
					state.tui?.requestRender?.();
				} catch {
					/* best-effort repaint */
				}
				lines.push(describe(state));
			}
			report(ctx?.ui, `fold: ${lines.join(" · ")}`);
		},
	});

	pi.on("session_start", async (_event: unknown, ctx?: StartCtx) => {
		try {
			const ui = ctx?.ui;
			if (!ui || typeof ui.setWidget !== "function") return; // RPC/headless: no widgets
			if (isPatched(ui.setWidget)) return;

			const original = ui.setWidget.bind(ui);
			const patched = (key: string, content?: unknown, options?: { placement?: string }) => {
				if (typeof key !== "string" || !(key in WIDGET_LABELS)) return original(key, content, options);
				if (typeof content !== "function") {
					foldState(key).mounted = false; // unmount: keep /fold list honest
					return original(key, content, options);
				}
				try {
					// SAFETY: pi only ever calls setWidget's callable content as
					// (tui, theme) => component.
					return original(key, wrapFactory(content as WidgetFactory, foldState(key)), options);
				} catch {
					return original(key, content, options); // folding never eats the widget
				}
			};
			markPatched(patched);

			Object.defineProperty(ui, "setWidget", {
				value: patched,
				writable: true,
				configurable: true,
				enumerable: true,
			});
		} catch {
			/* never break session start */
		}
	});
}
