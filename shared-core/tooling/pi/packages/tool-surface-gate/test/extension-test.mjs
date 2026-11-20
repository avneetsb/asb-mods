// Extension-level tests against a fake pi harness (no real session, no network).
// Hermetic: HOME is pointed at a temp dir so the real ~/.pi/agent/tool-surface-gate.json is not read.
// Run: node --test test/extension-test.mjs   (needs node_modules/typebox -> pi's copy, see README)
import test, { afterEach, before } from "node:test";
import { ensureTypeboxShim } from "./typebox-shim.mjs";

// Under pi the extension's `import { Type } from "typebox"` is satisfied by loader aliases; bare
// node has none, so link pi's installed copy before the first dynamic import (see typebox-shim.mjs).
before(() => ensureTypeboxShim());

// The extension reads HOME/env when it is *called*, not only at import, so a case's HOME and
// TOOL_SURFACE_GATE must stay in place until the test has invoked the factory. Restoring per case
// keeps the suite hermetic without leaking a temp HOME into later tests.
const ENV_SNAPSHOT = { home: process.env.HOME, kill: process.env.TOOL_SURFACE_GATE };
afterEach(() => {
	if (ENV_SNAPSHOT.home === undefined) delete process.env.HOME;
	else process.env.HOME = ENV_SNAPSHOT.home;
	if (ENV_SNAPSHOT.kill === undefined) delete process.env.TOOL_SURFACE_GATE;
	else process.env.TOOL_SURFACE_GATE = ENV_SNAPSHOT.kill;
});
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TOOL_NAMES = [
	"read",
	"bash",
	"write",
	"grep",
	"replace",
	"insert",
	"copy",
	"move",
	"outline",
	"mcp",
	"tool_search",
	"memory_config",
	"mem_save",
	"mem_update",
	"mem_search",
	"mem_context",
	"mem_review",
	"mem_get_observation",
	"mem_current_project",
	"mem_session_summary",
	"notify_user",
	"tools_wake",
	// park candidates (subset of the built-in default families)
	"mem_judge",
	"preview_export",
	"act_ui",
	"find_roots",
	"create_goal",
	"source_check",
];

function fakePi({ active = [...TOOL_NAMES], branch = [], setActiveThrows = null } = {}) {
	const state = { active: [...active], tools: [], handlers: {}, setCalls: 0, throwOnce: setActiveThrows };
	const registered = TOOL_NAMES.map((name) => ({ name }));
	return {
		state,
		registerTool(def) {
			state.tools.push(def);
		},
		on(event, handler) {
			(state.handlers[event] ??= []).push(handler);
		},
		getAllTools: () => registered,
		getActiveTools: () => [...state.active],
		setActiveTools: (names) => {
			state.setCalls += 1;
			// Persistent failure: real pi rejects a renamed tool on every call.
			if (state.throwOnce) throw state.throwOnce;
			state.active = [...names];
		},
		toolRegistry: { register() {}, unregister() {} },
		sessionManager: { getBranch: () => branch },
	};
}

async function loadExtension({ homeContents, env = {} } = {}) {
	const home = mkdtempSync(path.join(os.tmpdir(), "tsg-home-"));
	if (homeContents) {
		// The extension reads $HOME/.pi/agent/tool-surface-gate.json — mirror that layout in the temp HOME.
		mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(path.join(home, ".pi", "agent", "tool-surface-gate.json"), homeContents);
	}
	process.env.HOME = home;
	if (env.TOOL_SURFACE_GATE !== undefined) process.env.TOOL_SURFACE_GATE = env.TOOL_SURFACE_GATE;
	else delete process.env.TOOL_SURFACE_GATE;
	// Fresh module instance per case so the module-level CONFIG_PATH is re-read.
	const url = new URL(`../extensions/tool-surface-gate.js?case=${Math.random()}`, import.meta.url).href;
	const mod = await import(url);
	return mod.default;
}

function textOf(result) {
	return result.content.map((part) => part.text ?? "").join(" ");
}

test("kill switch TOOL_SURFACE_GATE=0 registers nothing", async () => {
	const setup = fakePi();
	const extend = await loadExtension({ env: { TOOL_SURFACE_GATE: "0" } });
	extend(setup);
	assert.equal(setup.state.tools.length, 0);
	assert.equal(Object.keys(setup.state.handlers).length, 0);
});

test("config enabled:false registers nothing", async () => {
	const setup = fakePi();
	const extend = await loadExtension({ homeContents: JSON.stringify({ enabled: false }) });
	extend(setup);
	assert.equal(setup.state.tools.length, 0);
});

test("registers exactly the tools_wake loader and three lifecycle hooks", async () => {
	const setup = fakePi();
	(await loadExtension())(setup);
	assert.deepEqual(
		setup.state.tools.map((tool) => tool.name),
		["tools_wake"],
	);
	assert.deepEqual(Object.keys(setup.state.handlers).sort(), ["before_agent_start", "session_start", "session_tree"]);
	assert.match(setup.state.tools[0].description, /computer-use-ui/);
	assert.ok(setup.state.tools[0].promptSnippet.length > 0);
});

test("fresh session parks unused families and keeps core + memory tools", async () => {
	const setup = fakePi();
	(await loadExtension())(setup);
	await setup.state.handlers.session_start[0]({}, setup);
	const active = new Set(setup.state.active);
	for (const parked of ["mem_judge", "preview_export", "act_ui", "find_roots", "create_goal", "source_check"]) {
		assert.ok(!active.has(parked), `${parked} should be parked`);
	}
	for (const kept of ["read", "bash", "mcp", "tool_search", "mem_save", "mem_search", "memory_config", "tools_wake"]) {
		assert.ok(active.has(kept), `${kept} must stay active`);
	}
});

test("wake by family activates it and reports success", async () => {
	const setup = fakePi();
	(await loadExtension())(setup);
	await setup.state.handlers.session_start[0]({}, setup);
	const loader = setup.state.tools[0];
	const result = await loader.execute("t1", { family: "preview" });
	assert.ok(!result.isError, textOf(result));
	assert.match(textOf(result), /Awoke 1 tool/);
	assert.ok(setup.state.active.includes("preview_export"));
});

test("wake by explicit tool list works across families", async () => {
	const setup = fakePi();
	(await loadExtension())(setup);
	await setup.state.handlers.session_start[0]({}, setup);
	const result = await setup.state.tools[0].execute("t2", { tools: ["mem_judge", "create_goal"] });
	assert.ok(!result.isError, textOf(result));
	assert.ok(setup.state.active.includes("mem_judge") && setup.state.active.includes("create_goal"));
});

test("wake with no args reports parked state instead of failing", async () => {
	const setup = fakePi();
	(await loadExtension())(setup);
	await setup.state.handlers.session_start[0]({}, setup);
	const result = await setup.state.tools[0].execute("t3", {});
	assert.ok(!result.isError, textOf(result));
	assert.match(textOf(result), /Parked: /);
});

test("unknown family is an error with the family list", async () => {
	const setup = fakePi();
	(await loadExtension())(setup);
	const result = await setup.state.tools[0].execute("t4", { family: "does-not-exist" });
	assert.ok(result.isError);
	assert.match(textOf(result), /Families:/);
});

test("unregistered tool name is refused rather than half-activated", async () => {
	const setup = fakePi();
	(await loadExtension())(setup);
	const result = await setup.state.tools[0].execute("t5", { tools: ["mcp__chrome_devtools"] });
	assert.ok(result.isError);
	assert.match(textOf(result), /Not registered/);
});

test("in-progress session (no tool-change records) parks nothing", async () => {
	const branch = [{ message: { role: "user", content: "working" } }, { message: { role: "assistant" } }];
	const setup = fakePi({ branch });
	(await loadExtension())(setup);
	await setup.state.handlers.before_agent_start[0]({}, setup);
	const active = new Set(setup.state.active);
	for (const name of ["mem_judge", "preview_export", "create_goal"]) {
		assert.ok(active.has(name), `${name} must not be yanked mid-session`);
	}
});

test("per-turn re-check parks MCP proxies that appear after session_start", async () => {
	const setup = fakePi();
	(await loadExtension())(setup);
	await setup.state.handlers.session_start[0]({}, setup); // MCP proxies not registered yet
	const before = setup.state.setCalls;
	// Simulate the gateway having registered the chrome-devtools proxy.
	setup.getAllTools = () => [...TOOL_NAMES, "mcp__chrome_devtools"].map((name) => ({ name }));
	setup.state.active.push("mcp__chrome_devtools");
	await setup.state.handlers.before_agent_start[0]({}, setup);
	assert.ok(setup.state.setCalls > before, "expected a second activation pass");
	assert.ok(!setup.state.active.includes("mcp__chrome_devtools"));
});

test("setActiveTools failure fails open and warns once", async () => {
	const setup = fakePi({ setActiveThrows: new Error("renamed tools are not supported") });
	const lines = [];
	const original = console.error;
	console.error = (line) => lines.push(String(line));
	try {
		const extend = await loadExtension();
		extend(setup);
		await setup.state.handlers.session_start[0]({}, setup);
		await setup.state.handlers.before_agent_start[0]({}, setup);
	} finally {
		console.error = original;
	}
	assert.equal(setup.state.active.includes("mem_judge"), true, "tools stay as pi chose them");
	assert.equal(lines.filter((line) => line.includes("tool-surface-gate")).length, 1);
});

test("wake survives a re-park cycle: waking twice is idempotent", async () => {
	const setup = fakePi();
	(await loadExtension())(setup);
	await setup.state.handlers.session_start[0]({}, setup);
	const loader = setup.state.tools[0];
	const first = await loader.execute("t6", { family: "preview" });
	const second = await loader.execute("t7", { family: "preview" });
	assert.ok(!first.isError && !second.isError, `${textOf(first)} / ${textOf(second)}`);
	assert.ok(setup.state.active.includes("preview_export"), "woken tool stays active across repeat wakes");
	assert.deepEqual(
		setup.state.active.filter((name) => name === "preview_export"),
		["preview_export"],
		"no duplicate entries in the active set",
	);
});
