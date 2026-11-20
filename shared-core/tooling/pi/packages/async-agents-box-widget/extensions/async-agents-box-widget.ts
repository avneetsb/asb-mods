/**
 * async-agents-box-widget.ts — draw pi-subagents' async-agents widget as a bordered box
 * (the beads-box-widget / pi-goal-x house style) instead of its bare tree of lines.
 *
 * Why this exists: the async widget is the only above-editor panel on this machine still
 * rendered without chrome, and pi-subagents exposes no config knob to restyle it — its
 * options (`asyncWidget`, `asyncWidgetCollapsed`, `asyncWidgetLayout`) only hide, fold or
 * relayout it (docs/configuration.md). Policy keeps upstream npm packages untouched, so the
 * panel is restyled at pi's widget boundary rather than by patching upstream code.
 *
 * Mechanism (verified against pi 1.4.0 dist/modes/interactive/interactive-mode.js):
 *   - `ctx.ui.setWidget(key, content, options)` (there: setExtensionWidget) keeps ONE widget
 *     per key per placement, default placement "aboveEditor", and for a non-array `content`
 *     it calls `content(this.ui, theme)` immediately and stores the returned component.
 *   - pi-subagents mounts its widget as a factory (`buildWidgetComponent`) under the key
 *     "subagent-async" (src/shared/types.js WIDGET_KEY), and afterwards keeps updating the
 *     ALREADY-MOUNTED component in place (`asyncWidgetUpdates`) instead of re-calling
 *     setWidget, precisely so progress cannot reorder widgets. So intercepting the factory
 *     once is enough: live updates, folding and the 1s spinner animation keep flowing
 *     through the component we wrap, and this extension owns no run state at all.
 *   - Wrapping is done with a Proxy over pi-subagents' own component, so `instanceof`,
 *     prototype methods, `dispose()` (which clears their update/invalidation maps) and any
 *     future component field all pass through untouched. Only `render` and `handleMouse`
 *     are re-anchored: render frames the lines, handleMouse shifts rows by the title bar so
 *     a click on the box title still reaches upstream's header click (its fold toggle).
 *
 * Safety rails: every framing step is inside try/catch and falls back to upstream's raw
 * lines, an RPC-mode payload line (PI_SUBAGENT_ASYNC_JSON:) is passed through unframed so
 * machine readers keep their contract, and if this extension is uninstalled (or the patch
 * never lands) pi-subagents renders its own panel exactly as before. `asyncWidget: false`
 * in pi-subagents' config still turns the whole widget off, framing included.
 */

import { frameWidgetLines, mapFramePointer } from "./widget-frame.mjs";

/** pi-subagents' widget key (src/shared/types.js: export const WIDGET_KEY). */
const WIDGET_KEY = "subagent-async";

/** Marks a ui whose setWidget is already wrapped (idempotent across /reload). */
const PATCHED = "__asyncAgentsBoxPatched";

type Theme = { fg?: (color: string, text: string) => string } | ((color: string, text: string) => string);

type Component = {
	render?: (width: number) => string[];
	handleMouse?: (event: MouseEventLike) => unknown;
	dispose?: () => void;
} & Record<string, unknown>;

type MouseEventLike = { type?: string; y?: number; button?: number; shift?: boolean; alt?: boolean; ctrl?: boolean };

type WidgetFactory = (tui: unknown, theme: Theme) => Component;

type UiLike = {
	setWidget?: (key: string, content?: unknown, options?: { placement?: string }) => void;
	[k: string]: unknown;
};

type StartCtx = { ui?: UiLike };

type PiExt = {
	on(
		event: "session_start",
		handler: (event?: unknown, ctx?: StartCtx) => void | Promise<void>,
	): void;
};

/** Render upstream's lines inside the box; never let a framing bug hide run state. */
function renderFramed(inner: Component, width: number, theme: Theme | undefined): string[] {
	const innerWidth = Math.max(12, width - 3); // boxLine body budget = width - 3
	try {
		const lines = inner.render?.(innerWidth) ?? [];
		const framed = frameWidgetLines(lines, width, theme);
		return framed.length > 0 ? framed : lines;
	} catch {
		try {
			return inner.render?.(width) ?? [];
		} catch {
			return [];
		}
	}
}

/**
 * Wrap a mounted component: pass everything through, re-anchor render (framed) and
 * handleMouse (row offset by the title bar).
 */
function wrapComponent(inner: Component, theme: Theme | undefined): Component {
	if (!inner || typeof inner.render !== "function") return inner;
	const handler: ProxyHandler<Component> = {
		get(target, prop, _receiver) {
			if (prop === "render") return (width: number) => renderFramed(target, width, theme);
			if (prop === "handleMouse") {
				if (typeof target.handleMouse !== "function") return undefined;
				return (event: MouseEventLike) => {
					const mapped = mapFramePointer(event);
					return mapped ? target.handleMouse?.(mapped) : undefined;
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

/** Wrap the factory so the component pi mounts is the framed one. */
function wrapFactory(factory: WidgetFactory): WidgetFactory {
	return (tui, theme) => wrapComponent(factory(tui, theme), theme);
}

export default function activate(pi: PiExt) {
	pi.on("session_start", async (_event: unknown, ctx?: StartCtx) => {
		try {
			const ui = ctx?.ui;
			if (!ui || typeof ui.setWidget !== "function") return; // subagents / headless: nothing to frame
			// The marker lives on the wrapped function, not the ui: a /reload keeps this ui
			// object with our wrapper installed, and must not wrap it a second time.
			// SAFETY: PATCHED is a private name we alone set, on the function we installed,
			// so reading it off any other callable is always undefined — never a false hit.
			if ((ui.setWidget as unknown as Record<string, unknown>)[PATCHED] === true) return;

			const original = ui.setWidget.bind(ui);
			const patched = (key: string, content?: unknown, options?: { placement?: string }) => {
				if (key !== WIDGET_KEY || typeof content !== "function") {
					return original(key, content, options);
				}
				try {
					// SAFETY: the guard above already proved content is a function, and pi only
					// ever calls setWidget's callable content as (tui, theme) => component.
					return original(key, wrapFactory(content as WidgetFactory), options);
				} catch {
					return original(key, content, options); // framing never eats the widget
				}
			};
			patched[PATCHED] = true;

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
