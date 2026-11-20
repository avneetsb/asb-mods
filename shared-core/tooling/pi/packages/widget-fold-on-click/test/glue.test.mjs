/**
 * glue.test.mjs — behavioural tests for the setWidget wrapper itself.
 *
 * fold-line.test.mjs proves the line math; this file proves the wiring only a fake pi
 * can exercise: which slots get wrapped, what a click does to render output, that
 * producers keep everything they rely on (update, invalidate, dispose, their own mouse
 * events), and that /fold drives the same state for keyboard-only mode. Node strips the
 * extension's types on import.
 *
 *   node --test test/
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import activate, { __resetFoldsForTest } from "../extensions/widget-fold-on-click.ts";
import { visibleWidth } from "../extensions/fold-line.mjs";

const ESC = String.fromCharCode(27);
const DIM = ESC + "[2m";
const RESET = ESC + "[0m";

beforeEach(() => {
	__resetFoldsForTest(); // `folds` is module state; cases must not inherit each other
});

/** pi's theme surface, minimal: fg(role, text). */
const theme = { fg: (_role, text) => `${DIM}${text}${RESET}` };

/**
 * Stand-in for InteractiveMode's widget maps: one component per key per placement, the
 * factory called immediately with (tui, theme) — the contract verified against pi's
 * setExtensionWidget.
 */
function makeUi() {
	const above = new Map();
	const below = new Map();
	const notices = [];
	let renders = 0;
	const tui = {
		requestRender() {
			renders += 1;
		},
	};
	const ui = {
		theme,
		setWidget(key, content, options) {
			const map = options?.placement === "belowEditor" ? below : above;
			const existing = map.get(key);
			if (content === undefined) {
				existing?.dispose?.();
				map.delete(key);
				return;
			}
			map.set(key, typeof content === "function" ? content(tui, theme) : content);
		},
		notify(message, level) {
			notices.push({ message, level });
		},
	};
	return { ui, above, below, notices, renders: () => renders };
}

/**
 * A producer in pi-goal-x's shape: title + `bodyRows` body lines, in-place update(),
 * invalidate(), dispose(). Counters are ordinary fields so assertions read plain
 * properties.
 */
function makeProducer(label, bodyRows = 3) {
	const rows = Array.from({ length: bodyRows }, (_unused, i) => `│ row ${i + 1} ${label} │`);
	const component = {
		updates: 0,
		invalidations: 0,
		disposed: 0,
		render(width) {
			return [`╭─ ${label} ─ 6 active ╮`, ...rows].map((line) => line.padEnd(Math.min(width, 40)));
		},
		update() {
			component.updates += 1;
		},
		invalidate() {
			component.invalidations += 1;
		},
		dispose() {
			component.disposed += 1;
		},
	};
	return { component, lines: bodyRows + 1 };
}

/** Boot the extension against a fake pi. */
function boot(options = {}) {
	const handlers = [];
	const commands = new Map();
	activate({
		on(_event, handler) {
			handlers.push(handler);
		},
		registerCommand(name, opts) {
			commands.set(name, opts);
		},
		getSettings: () => ({ tuiMode: options.tuiMode ?? "fullscreen" }),
	});
	const env = makeUi();
	const start = async () => {
		for (const handler of handlers) await handler({}, { ui: env.ui });
	};
	/** /fold runs with pi's CommandCtx shape, i.e. { ui, notify }. */
	const fold = (args) => commands.get("fold").handler(args, { ui: env.ui, notify: () => {} });
	return { commands, env, fold, start };
}

const click = (y = 0, extra = {}) => ({ type: "click", button: "left", x: 3, y, ...extra });

/** Mount the three real slot keys the way their producers do. */
function mountAll(env) {
	const producers = {
		goal: makeProducer("pi-goal-x", 4),
		"beads-wip": makeProducer("beads", 3),
		"lens-pane": makeProducer("pi-lens", 2),
	};
	env.ui.setWidget("goal", () => producers.goal.component, { placement: "aboveEditor" });
	env.ui.setWidget("beads-wip", () => producers["beads-wip"].component, { placement: "aboveEditor" });
	env.ui.setWidget("lens-pane", () => producers["lens-pane"].component, { placement: "belowEditor" });
	return {
		producers,
		widgets: {
			goal: env.above.get("goal"),
			beads: env.above.get("beads-wip"),
			lens: env.below.get("lens-pane"),
		},
	};
}

test("session_start patches setWidget exactly once", async () => {
	const { env, start } = boot();
	const before = env.ui.setWidget;
	await start();
	assert.notEqual(env.ui.setWidget, before, "setWidget replaced");
	const patched = env.ui.setWidget;
	await start(); // a second session_start (e.g. /reload) must not stack wrappers
	assert.equal(env.ui.setWidget, patched, "no double-wrap");
});

test("all three frames fold on a title click and unfold on the next", async () => {
	const { env, start } = boot();
	await start();
	const { producers, widgets } = mountAll(env);

	for (const [name, widget, producer] of [
		["goal", widgets.goal, producers.goal],
		["beads", widgets.beads, producers["beads-wip"]],
		["lens", widgets.lens, producers["lens-pane"]],
	]) {
		const open = widget.render(80);
		assert.equal(open.length, producer.lines, `${name} renders its own rows`);

		assert.deepEqual(widget.handleMouse(click(0)), { handled: true }, `${name} consumed the click`);

		const folded = widget.render(80);
		assert.equal(folded.length, 1, `${name} folded to one line`);
		assert.match(folded[0], /6 active/, `${name} kept its counters`);
		assert.match(folded[0], /▸ folded/, `${name} advertises the folded state`);
		assert.ok(visibleWidth(folded[0]) <= 80, `${name} stays inside the canvas`);

		widget.handleMouse(click(0));
		assert.equal(widget.render(80).length, open.length, `${name} unfolded back`);
	}

	const repaints = env.renders();
	widgets.goal.handleMouse(click(0));
	assert.ok(env.renders() > repaints, "toggle asked pi to repaint");
	widgets.goal.handleMouse(click(0));

	// The producer never had to know: its own methods still reach it.
	widgets.goal.update();
	assert.equal(producers.goal.component.updates, 1, "update() passed through the Proxy");
	widgets.goal.invalidate();
	assert.equal(producers.goal.component.invalidations, 1, "invalidate() passed through too");
});

test("only the title row toggles; other gestures and producers keep their events", async () => {
	const { env, start } = boot();
	await start();
	const { widgets } = mountAll(env);
	const goal = widgets.goal;

	const untouched = goal.render(80).length;
	for (const event of [
		click(1),
		click(0, { button: "right" }),
		click(0, { shift: true }),
		{ type: "wheel", button: "none", y: 0, wheelDelta: -1 },
		{ type: "press", button: "left", y: 0 },
	]) {
		assert.equal(goal.handleMouse(event), undefined, `event ${JSON.stringify(event)} not consumed`);
	}
	assert.equal(goal.render(80).length, untouched, "still expanded");

	// A producer that owns mouse handling keeps it for everything but the title row.
	let innerCalls = 0;
	env.ui.setWidget(
		"goal",
		() => ({
			render: () => ["╭─ goal ─╮", "│ body │"],
			handleMouse: (event) => {
				innerCalls += 1;
				return { forwarded: true, event };
			},
		}),
		{ placement: "aboveEditor" },
	);
	const replaced = env.above.get("goal");
	assert.deepEqual(replaced.handleMouse(click(2)), { forwarded: true, event: click(2) });
	assert.equal(innerCalls, 1, "producer's own handler ran");
	assert.deepEqual(replaced.handleMouse(click(0)), { handled: true }, "title row is ours");
});

test("non-allowlisted slots pass through completely untouched", async () => {
	const { env, start } = boot();
	await start();
	const producer = makeProducer("subagent-async");
	env.ui.setWidget("subagent-async", () => producer.component, { placement: "aboveEditor" });
	const mounted = env.above.get("subagent-async");

	assert.equal(mounted, producer.component, "same object identity, no Proxy");
	assert.equal(mounted.handleMouse, undefined, "no fold gesture invented");
	assert.equal(mounted.render(80).length, producer.lines);
});

test("a slot reclaimed by a takeover extension inherits the fold choice", async () => {
	const { env, start } = boot();
	await start();
	const { widgets } = mountAll(env);
	widgets.beads.handleMouse(click(0)); // operator folds beads

	// beads-box-widget reclaims the slot: pi disposes the old component, stores the new.
	const replacement = makeProducer("beads", 5);
	env.ui.setWidget("beads-wip", () => replacement.component, { placement: "aboveEditor" });
	const reclaimed = env.above.get("beads-wip");

	assert.equal(reclaimed.render(80).length, 1, "still folded after re-mount");
	reclaimed.handleMouse(click(0));
	assert.equal(reclaimed.render(80).length, replacement.lines, "unfold shows the new owner's rows");
});

test("unmounting passes through and keeps /fold honest", async () => {
	const { env, fold, start } = boot();
	await start();
	mountAll(env);

	env.ui.setWidget("lens-pane", undefined, { placement: "belowEditor" });
	assert.equal(env.below.has("lens-pane"), false, "widget really removed");

	await fold("lens");
	assert.match(env.notices.at(-1).message, /lens: not mounted right now/, env.notices.at(-1).message);
});

test("/fold drives the same state as a click, in keyboard-only mode", async () => {
	const { env, fold, start } = boot({ tuiMode: "regular" });
	await start();
	const { widgets } = mountAll(env);

	await fold("goal");
	assert.equal(widgets.goal.render(80).length, 1, "toggled by name");
	assert.match(env.notices.at(-1).message, /goal\s+folded/, env.notices.at(-1).message);
	await fold("list");
	assert.match(env.notices.at(-1).message, /goal\s+folded/, env.notices.at(-1).message);
	assert.match(env.notices.at(-1).message, /tuiMode/, "list explains why clicks won't land in regular mode");

	await fold("all");
	assert.equal(widgets.beads.render(80).length, 1);
	assert.match(env.notices.at(-1).message, /folded \d+ of 3 frames/, env.notices.at(-1).message);

	await fold("none");
	assert.equal(widgets.goal.render(80).length, 5, "expanded again");
	assert.match(env.notices.at(-1).message, /expanded \d+ of 3 frames/, env.notices.at(-1).message);

	await fold("bogus");
	assert.match(env.notices.at(-1).message, /unknown frame/, env.notices.at(-1).message);

	await fold("");
	assert.match(env.notices.at(-1).message, /goal\s+open/, env.notices.at(-1).message);
});

test("a broken producer cannot take the frame down with it", async () => {
	const { env, start } = boot();
	await start();
	env.ui.setWidget(
		"goal",
		() => ({
			render() {
				throw new Error("producer exploded");
			},
		}),
		{ placement: "aboveEditor" },
	);
	const goal = env.above.get("goal");
	assert.deepEqual(goal.render(80), [], "expanded: empty rather than throwing");
	goal.handleMouse(click(0));
	assert.deepEqual(goal.render(80), [], "folded: still empty rather than throwing");
});

test("a theme that cannot style the marker still folds", async () => {
	const handlers = [];
	activate({
		on: (_event, handler) => handlers.push(handler),
		registerCommand: () => {},
		getSettings: () => ({}),
	});
	const ui = {
		notify: () => {},
		setWidget(_key, content) {
			ui.widget = content(
				{ requestRender: () => {} },
				{
					fg: () => {
						throw new Error("no theme yet");
					},
				},
			);
		},
	};
	await handlers[0]({}, { ui });
	ui.setWidget("goal", () => ({ render: () => ["╭─ pi-goal-x ─ 3 tasks ╮", "│ x │"] }), {
		placement: "aboveEditor",
	});
	ui.widget.handleMouse(click(0));

	const folded = ui.widget.render(40);
	assert.equal(folded.length, 1);
	assert.match(folded[0], /▸ folded/, "marker falls back to unstyled text");
	assert.match(folded[0], /3 tasks/, "counters survive a broken theme");
});
