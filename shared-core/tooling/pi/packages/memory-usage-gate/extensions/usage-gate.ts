/**
 * memory-usage-gate — extensions/usage-gate.ts
 *
 * Purpose: make the memory stack demonstrably USED, not merely seeded.
 *
 * The measured problem, twice. Baseline (2026-11-12): engram held 656 observations across 767
 * sessions with almost no recall. After the first version of this gate, an independent audit
 * (2026-11-13) re-derived the same shape from disk: the six freshest sessions still recorded 0
 * recall calls and 0 durable saves, and of the two sessions that did fire, one answered the nudge
 * with reads only. So an instruction and a single end-of-run request are both too weak, and the
 * wording that let a session opt out with "nothing durable here" was doing exactly that.
 *
 * What changed in v2, and why each part is bounded:
 *
 *  • Two stages instead of one. `agent_before_settle` may request one continuation; the first
 *    version spent that single chance on a message the model could (and did) ignore. Now up to
 *    MEMORY_USAGE_GATE_MAX_NUDGES (default 2, hard ceiling 3) settle boundaries in a session may
 *    each request one continuation, and only for what is still missing at that moment. A session
 *    therefore pays at most two extra provider requests, and a session that complies pays none.
 *  • The exemption is earned instead of offered. A session is excused from writing only when it
 *    did no durable work — measured as zero mutating tool calls (edit/write/replace/move/copy and
 *    bash/git/state-changing commands) and fewer than MEMORY_USAGE_GATE_WORK_TURNS turns. Saying
 *  • Writes must be DELIBERATE to satisfy the write demand (v3). `mem_session_summary` and
 *    `mem_session_finalize` are automatic lifecycle captures, so they land in `autoWrites`
 *    instead of `writeCalls`: the audit of 2026-11-13 re-derived a session whose gate
 *    writeCalls came entirely from those two tools while its deliberate engram rows were 1 —
 *    the demand was met without a single finding being recorded. Both fields are persisted.
 *    "nothing durable here" is no longer itself an exit; it only works when the disk agrees.
 *  • Compliance is recorded, not assumed. `nudgeWorked` says whether the counts actually moved
 *    after a nudge, and `exempt` records the reason an exemption was granted. The rail and the
 *    measurement script read this file, so "recall and saves really happen" is answered from disk.
 *
 * Two counts are tracked, both from real tool calls (never from intent):
 *   recall — mem_context / mem_search / mem_get_observation / mem_timeline / mem_review, and the
 *            mnemosyne recall tools reached through the MCP proxy (`mcp__mnemosyne` with tool=…)
 *   write  — mem_save / mem_update / mem_consolidate, and mnemosyne remember/store/triple_add
 *
 * Everything goes to ~/.pi/agent/memory-usage-gate/state.json: the live session plus a bounded
 * history, keyed by pi session id.
 *
 * Failure posture: in the default nudge posture this extension can never block a session; setting MEMORY_USAGE_GATE_ENFORCE=hard lets it refuse up to MEMORY_USAGE_GATE_MAX_BLOCKS (default 2) non-memory tool calls per session, once a nudge has already been ignored Every nudge costs one provider
 * request and the count is capped; state writes are best-effort; an unreadable store changes
 * nothing about the session itself.
 *
 * Env:
 *   MEMORY_USAGE_GATE=0                  disable entirely
 *   MEMORY_USAGE_GATE_MIN_TURNS=<n>      turns before the gate may fire, default 2
 *   MEMORY_USAGE_GATE_SAVES=<n>          required durable saves, default 2
 *   MEMORY_USAGE_GATE_MAX_NUDGES=<n>     settle boundaries that may request a continuation,
 *                                        default 2 (ceiling 3)
 *   MEMORY_USAGE_GATE_WORK_TURNS=<n>     turns at which a session counts as having done work
 *   MEMORY_USAGE_GATE_ESCALATE_TURNS=<n>  turns of real work after which hard posture may
 *   refuse a non-memory call even when no settle nudge was ever emitted (default WORK_TURNS)
 *                                        even with no mutations, default 6
 *   MEMORY_USAGE_GATE_HISTORY=<n>        sessions kept in the history file, default 60
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DISABLED = process.env.MEMORY_USAGE_GATE === "0";
const MIN_TURNS = Math.max(1, Number(process.env.MEMORY_USAGE_GATE_MIN_TURNS ?? 2) || 2);
const REQUIRED_SAVES = Math.max(0, Number(process.env.MEMORY_USAGE_GATE_SAVES ?? 2) || 0);
const MAX_NUDGES = Math.min(3, Math.max(1, Number(process.env.MEMORY_USAGE_GATE_MAX_NUDGES ?? 2) || 2));
const WORK_TURNS = Math.max(1, Number(process.env.MEMORY_USAGE_GATE_WORK_TURNS ?? 6) || 6);
const HISTORY_MAX = Math.max(1, Number(process.env.MEMORY_USAGE_GATE_HISTORY ?? 60) || 60);

// Resolution order: explicit file, then explicit directory, then the default location. The first
// v2 draft computed the directory with path.dirname(process.env.MEMORY_USAGE_GATE_STATE) whenever
// the DIR var was set, which throws on dirname(undefined) — caught by the gate's own test fixture.
const STATE_FILE =
	process.env.MEMORY_USAGE_GATE_STATE ??
	path.join(
		process.env.MEMORY_USAGE_GATE_STATE_DIR ?? path.join(os.homedir(), ".pi", "agent", "memory-usage-gate"),
		"state.json",
	);

/** Engram read tools. mem_save* is deliberately NOT here — reading and writing are counted apart. */
const ENGRAM_RECALL = new Set(["mem_search", "mem_search_prompts", "mem_context", "mem_get_observation", "mem_timeline", "mem_review", "mem_doctor"]);
/** Engram durable writes. */
const ENGRAM_WRITE = new Set(["mem_save", "mem_update", "mem_consolidate", "mem_save_prompt", "mem_session_summary", "mem_session_finalize"]);
/**
 * Automatic lifecycle captures. They do write real rows, but the session did not choose to
 * record a finding, so they cannot satisfy the write demand: the audit of 2026-11-13
 * re-derived a session whose entire writeCalls came from these two tools while it held one
 * deliberate engram row. Counted separately as autoWrites.
 */
const AUTO_WRITE = new Set(["mem_session_summary", "mem_session_finalize"]);

/** Mnemosyne tool names as passed in `input.tool` when the call goes through the MCP proxy. */
const MNEMO_RECALL = ["mnemosyne_recall", "mnemosyne_recall_canonical", "mnemosyne_shared_recall", "mnemosyne_search", "mnemosyne_get", "mnemosyne_list"];
const MNEMO_WRITE = ["mnemosyne_remember_canonical", "mnemosyne_shared_remember", "mnemosyne_triple_add", "mnemosyne_store", "mnemosyne_update", "mnemosyne_remember"];

/**
 * Tool names that change something, so a session using them cannot claim it produced nothing
 * durable. `bash` is included on purpose: a session that ran the suite or committed has evidence.
 */
const MUTATING_TOOLS = new Set([
	"edit", "write", "replace", "replace_match", "insert", "copy", "move", "undo_last_change",
	"str_replace", "create_file", "notebook_edit", "apply_patch", "bash",
]);

/** Counts for one session. Persisted, so a restart can still tell what a session did. */
/**
 * Enforcement posture. "nudge" (default) asks and accepts being ignored. "hard" additionally
 * refuses non-memory tool calls — only after a nudge was already ignored, only while memory
 * needs are outstanding, and at most MAX_BLOCKS times per session.
 * Posture comes from MEMORY_USAGE_GATE_ENFORCE, else this component's own config file
 * (~/.pi/agent/memory-usage-gate.json: {"enforce":"hard","maxBlocks":2}), else nudge.
 */
const CONFIG_FILE = process.env.MEMORY_USAGE_GATE_CONFIG
	?? path.join(os.homedir(), ".pi", "agent", "memory-usage-gate.json");

function readPosture(): { enforce: string; maxBlocks: number; escalateTurns: number } {
	let file: { enforce?: unknown; maxBlocks?: unknown; escalateTurns?: unknown } = {};
	try {
		file = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as typeof file;
	} catch {
		file = {}; // absent or malformed config just means "use env/defaults"
	}
	const enforce = (process.env.MEMORY_USAGE_GATE_ENFORCE ?? String(file.enforce ?? "nudge"))
		.trim().toLowerCase();
	const maxBlocks = Math.min(4,
		Math.max(1, Number(process.env.MEMORY_USAGE_GATE_MAX_BLOCKS ?? file.maxBlocks ?? 2) || 2));
	// Escalation used to require an already-ignored nudge, but pi emits
	// agent_before_settle only when the agent stops: a session that never settles is
	// never asked, and one that ends right after the nudge has no later call to refuse.
	// So after this many turns of real work, `hard` posture may refuse outright.
	const escalateTurns = Math.max(1,
		Number(process.env.MEMORY_USAGE_GATE_ESCALATE_TURNS ?? file.escalateTurns
			?? WORK_TURNS) || WORK_TURNS);
	return { enforce, maxBlocks, escalateTurns };
}

const { enforce: ENFORCE, maxBlocks: MAX_BLOCKS, escalateTurns: ESCALATE_TURNS } = readPosture();

interface SessionCounts {
	sessionId: string;
	turns: number;
	recallCalls: number;
	writeCalls: number;
	/** Deliberate durable writes; lifecycle captures land in autoWrites instead. */
	autoWrites: number;
	mnemosyneCalls: number;
	mutations: number;
	nudges: number;
	/** Tool calls refused by hard enforcement this session. */
	blocks: number;
	/** True once a nudge demonstrably moved the missing counters. */
	nudgeWorked: boolean;
	/** Why the session was excused from writing, when it was. */
	exempt: string;
	startedAt: string;
	updatedAt: string;
}

interface State {
	sessionId: string;
	counts: SessionCounts;
	history: SessionCounts[];
}

function nowIso(): string {
	return new Date().toISOString();
}

function freshCounts(sessionId: string): SessionCounts {
	return {
		sessionId,
		turns: 0,
		recallCalls: 0,
		writeCalls: 0,
		autoWrites: 0,
		mnemosyneCalls: 0,
		mutations: 0,
		nudges: 0,
		blocks: 0,
		nudgeWorked: false,
		exempt: "",
		startedAt: nowIso(),
		updatedAt: nowIso(),
	};
}

function readState(): State | undefined {
	try {
		return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as State;
	} catch {
		return undefined;
	}
}

/**
 * Classify one tool call. The MCP proxy hides the real operation behind one tool name, so the
 * inner `tool` argument decides whether `mcp__mnemosyne` was a read or a write.
 */
/**
 * Memory used through a shell CLI. engram's mem_* tools are package tools and are absent in
 * `pi -p` sessions, where the same stores are reached with `engram save` / `mnemosyne store`;
 * not crediting those made real CLI-saved memories read as zero usage.
 */
const CLI_WRITE = /\b(engram\s+save|mnemosyne\s+(store|update))\b/;
const CLI_RECALL = /\b(engram\s+(search|context|timeline)|mnemosyne\s+recall)\b/;
const SHELL_TOOL = /(^|__)bash$/;

function classify(toolName: string, input: unknown): { recall: boolean; write: boolean; mnemosyne: boolean; auto?: boolean } {

	// Shell commands: credit memory CLI invocations (see CLI_WRITE / CLI_RECALL).
	const command = (input as { command?: unknown } | undefined)?.command;
	if (typeof command === "string" && SHELL_TOOL.test(toolName)) {
		const recall = CLI_RECALL.test(command);
		const write = CLI_WRITE.test(command);
		if (recall || write) return { recall, write, mnemosyne: false };
	}

	if (ENGRAM_RECALL.has(toolName)) return { recall: true, write: false, mnemosyne: false };
	if (ENGRAM_WRITE.has(toolName)) return { recall: false, write: true, mnemosyne: false, auto: AUTO_WRITE.has(toolName) };
	const inner = (input as { tool?: unknown } | undefined)?.tool;
	// Name-baked MCP tools (mcp__mnemosyne__mnemosyne_recall) carry no inner `tool`
	// argument, so classify those from the tool name itself.
	if (toolName.includes("mnemosyne") && typeof inner !== "string") {
		const recall = MNEMO_RECALL.some((n) => toolName.includes(n));
		const write = MNEMO_WRITE.some((n) => toolName.includes(n));
		if (recall || write) return { recall, write, mnemosyne: true };
	}
	if (typeof inner === "string" && (toolName.includes("mnemosyne") || toolName === "mcp")) {
		const recall = MNEMO_RECALL.some((n) => inner.includes(n));
		const write = MNEMO_WRITE.some((n) => inner.includes(n));
		return { recall, write, mnemosyne: true };
	}
	return { recall: false, write: false, mnemosyne: false };
}

/**
 * Did this session do work whose result deserves to outlive it? Mutating calls answer that far
 * better than a sentence the model can write, which is why the old opt-out line was removed.
 */
function didRealWork(c: SessionCounts): boolean {
	return c.mutations > 0 || c.turns >= WORK_TURNS;
}

export default function (pi: ExtensionAPI): void {
	if (DISABLED) return;

	let counts = freshCounts("unknown");
	/** Counts snapshot taken when the last nudge was issued, to judge whether it worked. */
	let afterNudge: { recall: number; write: number } | undefined;

	const persist = () => {
		try {
			const prev = readState();
			const history = prev?.history ?? [];
			counts.updatedAt = nowIso();
			// Keep the previous session's final numbers, never the live one twice.
			const merged = [...history.filter((h) => h.sessionId !== counts.sessionId), counts].slice(-HISTORY_MAX);
			const state: State = { sessionId: counts.sessionId, counts, history: merged };
			fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
			fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
		} catch {
			// state is diagnostic; a failed write must not affect the session
		}
	};

	/**
	 * What the session still owes the memory stack. Single source for both the settle nudge
	 * and the hard-mode block reason, so they can never disagree about what counts as used.
	 * Side effect: records why the session was excused from writing.
	 */
	const missingMemory = (): string[] => {
	const missing: string[] = [];
	if (counts.recallCalls === 0) {
		missing.push(
			"READ memory: call mem_context for the current project and mem_search on this task's subject, plus mcp__mnemosyne with tool=mnemosyne_recall_canonical. State in one line what each returned — including when a store is empty.",
		);
	}
	const mustWrite = didRealWork(counts);
	counts.exempt = mustWrite ? "" : "no mutations and fewer than " + WORK_TURNS + " turns";
	if (mustWrite && counts.writeCalls < REQUIRED_SAVES) {
		const need = REQUIRED_SAVES - counts.writeCalls;
		missing.push(
			`WRITE memory: record ${need} durable finding${need === 1 ? "" : "s"} with the mem_save TOOL. One row per fact, type one of decision|gotcha|architecture|verification|procedure, topic_key stable and namespaced (e.g. "sl:<kind>:<slug>"), scope "project" for repo-bound behaviour or "global" for anything that holds everywhere, and content that names how it was verified (command, file, or tool output). An automatic lifecycle capture (mem_session_summary / mem_session_finalize) does not count: it records no finding`,
		);
		missing.push(
			"Use the tool, not the engram CLI: mem_save stamps observations.session_id as <session>@<project>, while `engram save` stamps manual-save-<project> (it has no --session flag), so a CLI write is real knowledge that no per-session figure can ever see.",
		);
		missing.push(
			"These are not optional summaries: pick the findings this session actually established — a behaviour you confirmed, a trap you hit, a contract you relied on. If a store genuinely has nothing durable, say which store and why in one line.",
		);
	}
			return missing;
	};

	pi.on("session_start", async (_event, ctx) => {
		const sid = ctx.sessionManager?.getSessionId?.() ?? "unknown";
		counts = freshCounts(sid);
		afterNudge = undefined;
		persist();
	});

	pi.on("tool_call", async (event) => {
		const hit = classify(event.toolName, event.input);
		// Hard enforcement: a nudge was already ignored and memory needs are still open, so
		// refuse non-memory work until the memory call happens. Bounded by MAX_BLOCKS.
		if (ENFORCE === "hard" && !hit.recall && !hit.write && (counts.nudges > 0 || counts.turns >= ESCALATE_TURNS) && counts.blocks < MAX_BLOCKS
			&& didRealWork(counts) && counts.turns >= MIN_TURNS) {
			const outstanding = missingMemory();
			if (outstanding.length > 0) {
				counts.blocks += 1;
				persist();
				return {
					block: true,
					reason: [
						`Memory usage gate (block ${counts.blocks}/${MAX_BLOCKS}): you were asked once already and are still working without the memory stack.`,
						...outstanding,
						`Verified counts: recall ${counts.recallCalls}, deliberate writes ${counts.writeCalls}, lifecycle captures ${counts.autoWrites} not counted, mutating calls ${counts.mutations}, turns ${counts.turns}.`,
						"Make the memory call(s) first; after " + MAX_BLOCKS + " refusals this gate stops interfering.",
					].join("\n"),
				};
			}
		}
		if (hit.recall) counts.recallCalls += 1;
		if (hit.write) {
			if (hit.auto) counts.autoWrites += 1;
			else counts.writeCalls += 1;
		}
		if (hit.mnemosyne) counts.mnemosyneCalls += 1;
		if (MUTATING_TOOLS.has(event.toolName)) counts.mutations += 1;
		if (afterNudge && (counts.recallCalls > afterNudge.recall || counts.writeCalls > afterNudge.write)) {
			counts.nudgeWorked = true;
		}
		if (hit.recall || hit.write) persist();
	});

	pi.on("turn_end", async () => {
		counts.turns += 1;
		persist();
	});

	/**
	 * The gate. Fires at a settle boundary, only after real work, only for what is still missing,
	 * and at most MAX_NUDGES times per session. `continue: true` asks for exactly one more
	 * provider request, so the worst case is bounded and a compliant session pays nothing.
	 */
	pi.on("agent_before_settle", async (event) => {
		if (counts.nudges >= MAX_NUDGES) return undefined;
		if (counts.turns < MIN_TURNS) return undefined;

		const missing = missingMemory();
		if (missing.length === 0) return undefined;

		counts.nudges += 1;
		afterNudge = { recall: counts.recallCalls, write: counts.writeCalls };
		persist();

		const content = [
			`Memory usage gate (nudge ${counts.nudges}/${MAX_NUDGES}): this session is finishing without having used the memory stack.`,
			...missing,
			`Verified counts from tool calls: recall ${counts.recallCalls}, deliberate writes ${counts.writeCalls}, lifecycle captures ${counts.autoWrites} not counted, mutating calls ${counts.mutations}, turns ${counts.turns}.`,
			"Do the missing step(s) now, then give the final answer.",
		].join("\n");

		return {
			entries: [
				...(event.entries ?? []),
				{ type: "custom_message", customType: "memory-usage-gate", content, display: false },
			],
			continue: true,
		};
	});
}
