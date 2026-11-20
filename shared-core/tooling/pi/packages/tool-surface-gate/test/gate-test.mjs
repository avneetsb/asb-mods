// Pure-logic tests for lib/park.js — no pi, no network. Run: node --test test/gate-test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { computeNextActive, declaredFromBranch } from "../lib/park.js";

const FAMILY = ["mem_judge", "preview_export", "act_ui"];

test("declaredFromBranch: returns null when the transcript has no tool-change records", () => {
	assert.equal(declaredFromBranch([{ message: { role: "user" } }, { message: { role: "assistant" } }]), null);
	assert.equal(declaredFromBranch([]), null);
	assert.equal(declaredFromBranch(undefined), null);
});

test("declaredFromBranch: reads string and object tool entries, removal wins", () => {
	const branch = [
		{ message: { role: "system", toolsAdded: [{ name: "preview_export" }, "act_ui"] } },
		{ message: { role: "system", toolsRemoved: ["act_ui"] } },
	];
	const declared = declaredFromBranch(branch);
	assert.deepEqual([...declared], ["preview_export"]);
});

test("fresh session parks family tools and keeps the loader", () => {
	const registered = ["read", "bash", ...FAMILY, "tools_wake"];
	const active = ["read", "bash", ...FAMILY];
	const { next, parked, reason } = computeNextActive({ registered, active, familyTools: FAMILY, loaderName: "tools_wake" });
	assert.deepEqual(parked, FAMILY);
	assert.deepEqual(next, ["read", "bash", "tools_wake"]);
	assert.equal(reason, "parked-fresh-session");
});

test("loader is appended when pi left it out of the active set", () => {
	const registered = ["read", "mem_judge", "tools_wake"];
	const { next } = computeNextActive({ registered, active: ["read", "mem_judge"], familyTools: FAMILY, loaderName: "tools_wake" });
	assert.ok(next.includes("tools_wake"));
});

test("in-progress session with no tool-change records parks nothing", () => {
	const registered = ["read", ...FAMILY, "tools_wake"];
	const active = ["read", ...FAMILY];
	const { next, parked, reason } = computeNextActive({ registered, active, familyTools: FAMILY, branchHasContent: true, loaderName: "tools_wake" });
	assert.deepEqual(parked, []);
	assert.equal(next.filter((name) => FAMILY.includes(name)).length, FAMILY.length);
	assert.equal(reason, "session-in-progress");
});

test("transcript-declared tools survive the per-turn re-check (no yank after wake)", () => {
	const registered = ["read", ...FAMILY, "tools_wake"];
	const active = ["read", ...FAMILY, "tools_wake"];
	const declared = new Set(["preview_export"]);
	const { parked } = computeNextActive({ registered, active, familyTools: FAMILY, declared, branchHasContent: true, loaderName: "tools_wake" });
	assert.deepEqual(parked, ["mem_judge", "act_ui"]);
});

test("keep list wins over family membership", () => {
	const registered = ["read", ...FAMILY, "tools_wake"];
	const active = ["read", ...FAMILY];
	const { parked } = computeNextActive({ registered, active, familyTools: FAMILY, keep: ["preview_export"], loaderName: "tools_wake" });
	assert.ok(!parked.includes("preview_export"));
	assert.deepEqual(parked, ["mem_judge", "act_ui"]);
});

test("family tools that are not registered are ignored", () => {
	const { next, parked } = computeNextActive({ registered: ["read", "tools_wake"], active: ["read"], familyTools: FAMILY, loaderName: "tools_wake" });
	assert.deepEqual(parked, []);
	assert.deepEqual(next, ["read", "tools_wake"]);
});

test("keep list wins over a family that names the same tool", () => {
	const registered = ["read", ...FAMILY, "tools_wake"];
	const active = ["read", ...FAMILY];
	const { next, parked } = computeNextActive({
		registered,
		active,
		familyTools: ["read", ...FAMILY],
		keep: ["read"],
		loaderName: "tools_wake",
	});
	assert.ok(next.includes("read"), "a kept tool survives even though the family listed it");
	assert.deepEqual(parked, FAMILY);
});

test("the loader is never parked, even when a family names it and nothing is kept", () => {
	const registered = ["read", "tools_wake", ...FAMILY];
	const active = ["read", ...FAMILY];
	const { next, parked } = computeNextActive({
		registered,
		active,
		familyTools: ["tools_wake", ...FAMILY],
		keep: [],
		loaderName: "tools_wake",
	});
	assert.ok(next.includes("tools_wake"), "the tool that wakes families must stay callable");
	assert.deepEqual(parked, FAMILY);
});
