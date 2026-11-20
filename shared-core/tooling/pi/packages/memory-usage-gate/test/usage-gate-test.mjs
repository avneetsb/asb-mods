/**
 * Behaviour proof for memory-usage-gate v2.
 *
 * The audit that forced v2 measured that a single end-of-run request was ignorable and that the
 * "say so if nothing is durable" line was being taken as an exit. These scenarios pin the three
 * properties that answer it, with real tool_call/turn_end/settle events and a temp state file:
 *
 *   A  a session that did real work but used no memory is nudged, and a second deficient settle
 *      boundary is still answered, while the third is refused — the cost is bounded.
 *   B  a session that changed nothing and stayed short is exempt from writing (but still asked to
 *      read), and the exemption reason is persisted rather than left to the model's wording.
 *   C  when the model complies after a nudge, the state file records that it worked.
 *
 * Each scenario imports the gate with a unique query string. STATE_FILE is a module-level const,
 * so a second `gate()` call on the cached module would keep writing to the first scenario's file —
 * exactly how the first draft of this test failed.
 *
 * Run: node --experimental-strip-types test/usage-gate-test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GATE = path.join(os.homedir(), ".agents/packages/memory-usage-gate/extensions/usage-gate.ts");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-gate-"));

/** One isolated gate instance, writing to its own state file. */
async function freshGate(tag) {
	const stateFile = path.join(tmp, `state-${tag}.json`);
	process.env.MEMORY_USAGE_GATE_STATE = stateFile;
	// Isolate from the operator's installed config: unless the scenario chose a config file,
	// point at one that does not exist so the default posture really is the default.
	process.env.MEMORY_USAGE_GATE_CONFIG = process.env.MEMORY_USAGE_GATE_CONFIG
		?? path.join(tmp, `config-${tag}.absent.json`);
	const mod = await import(`file://${GATE}?case=${tag}`);
	const lifecycle = new Map();
	const pi = {
		events: { on() { return () => {}; }, emit() {} },
		on(name, fn) { if (!lifecycle.has(name)) lifecycle.set(name, []); lifecycle.get(name).push(fn); },
		registerCommand() {}, appendEntry() {}, registerPanel() {}, setActiveTools() {}, setModel() {},
		getActiveTools: () => [],
	};
	const ctx = {
		cwd: process.cwd(),
		sessionManager: { getSessionId: () => `gate-test-${tag}`, getBranch: () => undefined, getEntries: () => [] },
		ui: { setStatus() {}, notify() {} },
	};
	mod.default(pi, ctx);
	const fire = async (name, arg) => {
		let out;
		for (const fn of lifecycle.get(name) ?? []) out = await fn(arg ?? {}, ctx);
		return out;
	};
	const read = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
	return { fire, read, stateFile };
}

const fail = [];
const check = (name, ok, detail) => {
	console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " - " + detail : ""));
	if (!ok) fail.push(name);
};
const askedFor = (res) => (res?.entries ?? []).map((e) => e.content ?? "").join("\n");
const flat = (s) => s.slice(0, 62).replace(/\n/g, " | ");

// ---------- A: deficient session, bounded number of nudge opportunities ----------
{
	const { fire, read } = await freshGate("a");
	await fire("session_start");
	await fire("tool_call", { toolName: "bash", input: { command: "node --test" } }); // real work
	await fire("turn_end");
	await fire("turn_end");

	const n1 = await fire("agent_before_settle", { entries: [] });
	check("A1 nudge continues the run", n1?.continue === true, "continue=" + n1?.continue);
	const t1 = askedFor(n1);
	check("A1 asks for both read and write", /READ memory/.test(t1) && /WRITE memory/.test(t1), flat(t1));
	check("A1 no free opt-out line", !/say so in one line instead/.test(t1), "opt-out phrase absent");

	// The model obeys the read half only.
	await fire("tool_call", { toolName: "mem_context", input: {} });
	const n2 = await fire("agent_before_settle", { entries: [] });
	const t2 = askedFor(n2);
	check("A2 second deficient boundary is answered", n2?.continue === true, "continue=" + n2?.continue);
	check("A2 only the still-missing half is asked", /WRITE memory/.test(t2) && !/READ memory/.test(t2), flat(t2));

	const n3 = await fire("agent_before_settle", { entries: [] });
	check("A3 third boundary is refused (bounded cost)", n3 === undefined, "result=" + JSON.stringify(n3));
	check("A3 state records exactly two nudges", read().counts.nudges === 2, "nudges=" + read().counts.nudges);
	check("A3 reads were counted from real calls", read().counts.recallCalls === 1, "recallCalls=" + read().counts.recallCalls);
}

// ---------- B: nothing changed, session stayed short → writing is excused ----------
{
	const { fire, read } = await freshGate("b");
	await fire("session_start");
	await fire("tool_call", { toolName: "read", input: { path: "README.md" } });
	await fire("turn_end");
	await fire("turn_end"); // MIN_TURNS is 2, so the gate is allowed to speak now

	const nb = await fire("agent_before_settle", { entries: [] });
	const tb = askedFor(nb);
	check("B1 read is still required", /READ memory/.test(tb), "asked: " + flat(tb));
	check("B2 write excused without mutations", !/WRITE memory/.test(tb), "no WRITE demand");
	check("B3 exemption reason persisted", /no mutations/.test(read().counts.exempt), "exempt=" + read().counts.exempt);
}

// ---------- C: compliance after a nudge is recorded ----------
{
	const { fire, read } = await freshGate("c");
	await fire("session_start");
	for (let i = 0; i < 3; i++) await fire("tool_call", { toolName: "edit", input: {} });
	await fire("turn_end");
	await fire("turn_end");

	const nc = await fire("agent_before_settle", { entries: [] });
	check("C1 nudged for writes", /WRITE memory/.test(askedFor(nc)), "nudge issued");
	check("C1 not yet worked", read().counts.nudgeWorked === false, "nudgeWorked=" + read().counts.nudgeWorked);

	await fire("tool_call", { toolName: "mem_save", input: { content: "x", scope: "project", topic_key: "sl:test:one" } });
	await fire("tool_call", { toolName: "mcp__mnemosyne", input: { tool: "mnemosyne_remember_canonical" } });
	const c = read();
	check("C2 writes counted across both stores", c.counts.writeCalls === 2, "writeCalls=" + c.counts.writeCalls);
	check("C3 nudgeWorked recorded", c.counts.nudgeWorked === true, "nudgeWorked=" + c.counts.nudgeWorked);

	// Reads satisfied too → a later boundary asks for nothing at all.
	await fire("tool_call", { toolName: "mem_search", input: { query: "gate" } });
	const after = await fire("agent_before_settle", { entries: [] });
	check("C4 nothing asked once satisfied", after === undefined, "result=" + JSON.stringify(after));
	check("C4 history keeps one row per session", read().history.filter((h) => h.sessionId === "gate-test-c").length === 1, "history=" + read().history.length);
}

// ---------- D: name-baked MCP names (no inner `tool` argument) are credited ----------
{
	const { fire, read } = await freshGate("d");
	await fire("session_start");
	await fire("tool_call", { toolName: "mcp__mnemosyne__mnemosyne_recall", input: { query: "gate" } });
	await fire("tool_call", { toolName: "mcp__mnemosyne__mnemosyne_shared_recall", input: { query: "gate" } });
	await fire("tool_call", { toolName: "mcp__mnemosyne__mnemosyne_remember_canonical", input: {} });
	await fire("turn_end");
	const d = read().counts;
	check("D1 name-baked recalls counted", d.recallCalls === 2, "recallCalls=" + d.recallCalls);
	check("D2 name-baked write counted", d.writeCalls === 1, "writeCalls=" + d.writeCalls);
	check("D3 all three counted as mnemosyne", d.mnemosyneCalls === 3, "mnemosyneCalls=" + d.mnemosyneCalls);
	const nd = await fire("agent_before_settle", { entries: [] });
	check("D4 read half satisfied by mnemosyne alone",
		nd === undefined || !/READ memory/.test(askedFor(nd)), "asked: " + flat(askedFor(nd)));
}

// ---------- E: hard posture refuses non-memory work after an ignored nudge ----------
async function hardGate(tag) {
	const prev = process.env.MEMORY_USAGE_GATE_ENFORCE;
	process.env.MEMORY_USAGE_GATE_ENFORCE = "hard";
	try {
		return await freshGate(tag); // consts are read at module init, so set env before import
	} finally {
		if (prev === undefined) delete process.env.MEMORY_USAGE_GATE_ENFORCE;
		else process.env.MEMORY_USAGE_GATE_ENFORCE = prev;
	}
}
{
	const { fire, read } = await hardGate("e");
	await fire("session_start");
	// Real work, no memory use, then a settle boundary the model ignores.
	await fire("tool_call", { toolName: "edit", input: {} });
	await fire("turn_end");
	await fire("turn_end");
	const ne = await fire("agent_before_settle", { entries: [] });
	check("E1 nudged first", ne?.continue === true, "continue=" + ne?.continue);

	const b1 = await fire("tool_call", { toolName: "bash", input: { command: "make" } });
	check("E2 non-memory call refused after ignored nudge", b1?.block === true, "result=" + JSON.stringify(b1));
	check("E2 refusal names the gate and the outstanding need",
		/Memory usage gate \(block 1\/2\)/.test(b1?.reason ?? "") && /WRITE memory/.test(b1?.reason ?? ""),
		flat(b1?.reason ?? ""));
	check("E2 refusal carries verified counts", /deliberate writes 0, lifecycle captures 0/.test(b1?.reason ?? ""), flat(b1?.reason ?? ""));

	// Memory calls are never the thing being refused.
	await fire("tool_call", { toolName: "mem_save", input: { content: "x", scope: "project", topic_key: "sl:e" } });
	const afterSave = read().counts;
	check("E3 memory call passed through and was counted", afterSave.writeCalls === 1 && afterSave.blocks === 1,
		"writeCalls=" + afterSave.writeCalls + " blocks=" + afterSave.blocks);

	const b2 = await fire("tool_call", { toolName: "bash", input: { command: "make" } });
	check("E4 second refusal allowed while needs outstanding", b2?.block === true && /block 2\/2/.test(b2?.reason ?? ""),
		flat(b2?.reason ?? ""));

	const b3 = await fire("tool_call", { toolName: "bash", input: { command: "make" } });
	check("E5 third call allowed (cost bounded, never wedged)", b3 === undefined, "result=" + JSON.stringify(b3));
	check("E5 state records exactly two blocks", read().counts.blocks === 2, "blocks=" + read().counts.blocks);
}

// ---------- F: default posture still cannot block anything ----------
{
	const { fire, read } = await freshGate("f"); // no ENFORCE env → nudge posture
	await fire("session_start");
	await fire("tool_call", { toolName: "edit", input: {} });
	await fire("turn_end");
	await fire("turn_end");
	await fire("agent_before_settle", { entries: [] });
	const calls = [];
	for (let i = 0; i < 4; i++) calls.push(await fire("tool_call", { toolName: "bash", input: { command: "make" } }));
	check("F1 nudge posture never blocks", calls.every((c) => c === undefined), "results=" + JSON.stringify(calls));
	check("F2 blocks counter stays 0", read().counts.blocks === 0, "blocks=" + read().counts.blocks);
}

// ---------- G: the component's own config file selects the posture (no env involved) ----------
{
	const cfg = path.join(tmp, "config-g.json");
	fs.writeFileSync(cfg, JSON.stringify({ enforce: "hard", maxBlocks: 1 }));
	const prevCfg = process.env.MEMORY_USAGE_GATE_CONFIG;
	const prevEnforce = process.env.MEMORY_USAGE_GATE_ENFORCE;
	delete process.env.MEMORY_USAGE_GATE_ENFORCE; // config file must be the only signal
	process.env.MEMORY_USAGE_GATE_CONFIG = cfg;
	let fire, read;
	try {
		({ fire, read } = await freshGate("g"));
	} finally {
		process.env.MEMORY_USAGE_GATE_CONFIG = prevCfg;
		if (prevEnforce !== undefined) process.env.MEMORY_USAGE_GATE_ENFORCE = prevEnforce;
	}
	await fire("session_start");
	await fire("tool_call", { toolName: "edit", input: {} });
	await fire("turn_end");
	await fire("turn_end");
	await fire("agent_before_settle", { entries: [] });
	const b1 = await fire("tool_call", { toolName: "bash", input: { command: "make" } });
	check("G1 config file posture enforced", b1?.block === true, "result=" + JSON.stringify(b1));
	check("G2 config maxBlocks honoured", /block 1\/1/.test(b1?.reason ?? ""), flat(b1?.reason ?? ""));
	const b2 = await fire("tool_call", { toolName: "bash", input: { command: "make" } });
	check("G3 stops after the configured budget", b2 === undefined, "result=" + JSON.stringify(b2));
	check("G3 blocks recorded", read().counts.blocks === 1, "blocks=" + read().counts.blocks);
}

// ---------- H: memory used through a shell CLI counts ----------
{
	const { fire, read } = await freshGate("h");
	await fire("session_start");
	const a = await fire("tool_call", { toolName: "bash", input: { command: "engram save --topic x --scope project \"note\"" } });
	check("H1 engram CLI save credited", read().counts.writeCalls === 1, "writes=" + read().counts.writeCalls);
	await fire("tool_call", { toolName: "bash", input: { command: "mnemosyne recall 'gate' | head -3" } });
	check("H2 mnemosyne CLI recall credited", read().counts.recallCalls === 1, "recalls=" + read().counts.recallCalls);
	await fire("tool_call", { toolName: "bash", input: { command: "ls -1 | wc -l" } });
	check("H3 unrelated shell stays unclassified", read().counts.writeCalls === 1 && read().counts.recallCalls === 1,
		"w=" + read().counts.writeCalls + " r=" + read().counts.recallCalls);
	await fire("tool_call", { toolName: "mcp__gitnexus__query", input: { search_query: "engram save is not a shell call" } });
	check("H4 non-shell tool naming the verbs is not credited", read().counts.writeCalls === 1,
		"w=" + read().counts.writeCalls);
}


// ---------- I: escalation does not depend on the session ever settling ----------
{
	const prevEnforce = process.env.MEMORY_USAGE_GATE_ENFORCE;
	process.env.MEMORY_USAGE_GATE_ENFORCE = "hard";
	let fire, read;
	try {
		({ fire, read } = await freshGate("i"));
	} finally {
		if (prevEnforce === undefined) delete process.env.MEMORY_USAGE_GATE_ENFORCE;
		else process.env.MEMORY_USAGE_GATE_ENFORCE = prevEnforce;
	}
	await fire("session_start");
	// Six turns of mutating work and no memory use; agent_before_settle is never fired,
	// which is exactly the live failure shape of a long-running session.
	for (let i = 0; i < 6; i++) {
		await fire("tool_call", { toolName: "edit", input: {} });
		await fire("turn_end");
	}
	const b = await fire("tool_call", { toolName: "bash", input: { command: "make" } });
	check("I1 sustained work refused with no nudge ever emitted", b?.block === true,
		"result=" + JSON.stringify(b));
	check("I1 refusal needed no prior nudge", read().counts.nudges === 0,
		"nudges=" + read().counts.nudges);
	check("I1 refusal names the outstanding write need", /WRITE memory/.test(b?.reason ?? ""),
		flat(b?.reason ?? ""));
	const mem = await fire("tool_call", { toolName: "mem_context", input: {} });
	check("I2 memory calls are never the refused thing", mem === undefined,
		"result=" + JSON.stringify(mem));
}

// ---------- J: the escalation threshold is configurable ----------
{
	const prevEnforce = process.env.MEMORY_USAGE_GATE_ENFORCE;
	const prevEsc = process.env.MEMORY_USAGE_GATE_ESCALATE_TURNS;
	process.env.MEMORY_USAGE_GATE_ENFORCE = "hard";
	process.env.MEMORY_USAGE_GATE_ESCALATE_TURNS = "99";
	let fire, read;
	try {
		({ fire, read } = await freshGate("j"));
	} finally {
		if (prevEnforce === undefined) delete process.env.MEMORY_USAGE_GATE_ENFORCE;
		else process.env.MEMORY_USAGE_GATE_ENFORCE = prevEnforce;
		if (prevEsc === undefined) delete process.env.MEMORY_USAGE_GATE_ESCALATE_TURNS;
	}
	await fire("session_start");
	for (let i = 0; i < 8; i++) {
		await fire("tool_call", { toolName: "edit", input: {} });
		await fire("turn_end");
	}
	const under = await fire("tool_call", { toolName: "bash", input: { command: "make" } });
	check("J1 raise the threshold and escalation stays silent", under === undefined,
		"result=" + JSON.stringify(under));
	check("J1 nothing blocked", read().counts.blocks === 0, "blocks=" + read().counts.blocks);
}

// ---------- K: an automatic lifecycle capture cannot satisfy the write demand ----------
{
	// Three nudge opportunities so K3 asks at a real boundary instead of hitting the bounded
	// refusal path, where an empty answer would make the assertion pass vacuously.
	const prevNudges = process.env.MEMORY_USAGE_GATE_MAX_NUDGES;
	process.env.MEMORY_USAGE_GATE_MAX_NUDGES = "3";
	let fire, read;
	try {
		({ fire, read } = await freshGate("k"));
	} finally {
		if (prevNudges === undefined) delete process.env.MEMORY_USAGE_GATE_MAX_NUDGES;
		else process.env.MEMORY_USAGE_GATE_MAX_NUDGES = prevNudges;
	}
	await fire("session_start");
	await fire("tool_call", { toolName: "write", input: { path: "notes.md" } }); // real work: no exemption
	await fire("turn_end");
	await fire("turn_end");

	const k1 = await fire("agent_before_settle", { entries: [] });
	check("K1 write demanded with nothing saved", /WRITE memory/.test(askedFor(k1)), flat(askedFor(k1)));

	// The demand is answered with a lifecycle capture: a real store row, but no finding.
	await fire("tool_call", { toolName: "mem_session_summary", input: { content: "summary" } });
	const k2 = await fire("agent_before_settle", { entries: [] });
	const tk2 = askedFor(k2);
	check("K2 capture leaves WRITE outstanding", k2?.continue === true && /WRITE memory/.test(tk2),
		"continue=" + k2?.continue + " asked=" + flat(tk2));
	check("K2 capture counted as auto not deliberate", read().counts.autoWrites === 1 && read().counts.writeCalls === 0,
		"auto=" + read().counts.autoWrites + " deliberate=" + read().counts.writeCalls);
	check("K2 demand text names the exclusion", /does not count: it records no finding/.test(tk2), flat(tk2));

	// Deliberate saves (REQUIRED_SAVES defaults to 2) close the write half.
	await fire("tool_call", { toolName: "mem_save", input: { title: "a", content: "a" } });
	await fire("tool_call", { toolName: "mem_save", input: { title: "b", content: "b" } });
	const k3 = await fire("agent_before_settle", { entries: [] });
	const tk3 = askedFor(k3);
	check("K3 deliberate saves satisfy the write half", k3?.continue === true && /READ memory/.test(tk3) && !/WRITE memory/.test(tk3),
		"continue=" + k3?.continue + " asked=" + flat(tk3));
	check("K3 the two kinds stay separated in state", read().counts.writeCalls === 2 && read().counts.autoWrites === 1,
		"deliberate=" + read().counts.writeCalls + " auto=" + read().counts.autoWrites);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail.length === 0 ? "USAGE GATE PASS" : "USAGE GATE FAIL (" + fail.length + ")");
process.exit(fail.length === 0 ? 0 : 1);
