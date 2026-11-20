// tool-surface-gate — park measured-never-used tool families at session start and wake them
// on demand with `tools_wake`. One purpose: shrink the declared tool surface (prompt tokens).
//
// Upstream components are never modified: this only calls pi's public dynamic-tool API
// (getAllTools / getActiveTools / setActiveTools) — the same mechanism pi-web-access uses for
// `web_enable`. Kill switch: TOOL_SURFACE_GATE=0. Config: ~/.pi/agent/tool-surface-gate.json

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { computeNextActive, declaredFromBranch } from "../lib/park.js";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "tool-surface-gate.json");
const LOADER = "tools_wake";

// Defaults come from per-tool call counts across the ~120 sessions indexed under
// ~/.pi/agent/sessions (method + numbers in README.md); each family below measured 0 uses.
const DEFAULT_FAMILIES = [
	{
		name: "computer-use-ui",
		why: "macOS UI automation (@injaneity/pi-computer-use)",
		tools: ["find_roots", "observe_ui", "search_ui", "expand_ui", "inspect_ui", "act_ui", "read_text", "wait_for"],
	},
	{
		name: "computer-use-browser",
		why: "managed CDP launcher; the browser_* harness already covers web control here",
		tools: ["launch_browser", "navigate_browser", "evaluate_browser"],
	},
	{
		name: "engram-admin",
		why: "engram judging/admin/lifecycle tools with zero observed calls",
		tools: [
			"mem_judge",
			"mem_judge_many",
			"mem_compare",
			"mem_pin",
			"mem_unpin",
			"mem_list_projects",
			"mem_doctor",
			"mem_capture_passive",
			"mem_save_prompt",
			"mem_search_prompts",
			"mem_suggest_topic_key",
			"mem_session_start",
			"mem_session_end",
		],
	},
	{
		name: "goal-admin",
		why: "pi-goal-x model-facing goal authoring; /goal-direct and friends create goals without these",
		tools: ["create_goal", "set_goal_tasks", "goal_question", "goal_questionnaire"],
	},
	{ name: "preview", why: "Markdown/LaTeX to PDF/HTML/PNG export", tools: ["preview_export"] },
	{ name: "source-check", why: "citation gathering; web_search + fetch_content cover the same need", tools: ["source_check"] },
	{ name: "chrome-devtools", why: "second browser MCP server; the `mcp` gateway still reaches it", tools: ["mcp__chrome_devtools"] },
];

// Guardrail: never parked, even if a config family names them.
const DEFAULT_KEEP = [
	"read",
	"bash",
	"write",
	"edit",
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
	"mcp__mnemosyne",
	"mcp__gitnexus",
	"mcp__codegraph",
	"mcp__headroom",
	"mcp__obsidian_connect_readwrite",
	"notify_user",
];

function message(error) {
	return error instanceof Error ? error.message : String(error);
}

function loadConfig() {
	const fallback = { enabled: true, families: DEFAULT_FAMILIES, keep: [] };
	if (!existsSync(CONFIG_PATH)) return fallback;
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		const families = Array.isArray(raw.families) && raw.families.length > 0 ? raw.families : DEFAULT_FAMILIES;
		const keep = Array.isArray(raw.keep) ? raw.keep : [];
		return { enabled: raw.enabled !== false, families, keep };
	} catch (error) {
		console.error(`[tool-surface-gate] ${CONFIG_PATH} unreadable, using defaults: ${message(error)}`);
		return fallback;
	}
}

export default function (pi) {
	if (process.env.TOOL_SURFACE_GATE === "0") return;
	let config = loadConfig();
	if (!config.enabled) return;

	let warned = false;
	let lastParked = [];

	function familyTools() {
		return config.families.flatMap((family) => family.tools ?? []);
	}

	function applyGate(ctx) {
		try {
			if (typeof pi.getAllTools !== "function" || typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
			const registered = pi.getAllTools().map((tool) => tool.name);
			// Without the wake path there is no way back, so refuse to park anything.
			if (!registered.includes(LOADER)) return;
			const branch = ctx?.sessionManager?.getBranch?.() ?? [];
			const active = pi.getActiveTools();
			const result = computeNextActive({
				registered,
				active,
				familyTools: familyTools(),
				keep: [...DEFAULT_KEEP, ...config.keep],
				declared: declaredFromBranch(branch),
				branchHasContent: branch.length > 0,
				loaderName: LOADER,
			});
			lastParked = result.parked;
			const unchanged = result.next.length === active.length && result.next.every((name, index) => name === active[index]);
			if (unchanged) return;
			pi.setActiveTools(result.next);
		} catch (error) {
			if (!warned) {
				warned = true;
				console.error(`[tool-surface-gate] inactive for this session: ${message(error)}`);
			}
		}
	}

	function text(value) {
		return { content: [{ type: "text", text: value }] };
	}

	pi.registerTool({
		name: LOADER,
		label: "Wake parked tools",
		description:
			"Activate tool families that tool-surface-gate parked at session start. Does no work itself; without arguments it reports what is parked. Families -> tools: " +
			config.families.map((family) => `${family.name}: ${family.tools.join(", ")}`).join(" | "),
		promptSnippet: `If a needed tool is missing from the tool list, call ${LOADER} with {"family":"<name>"} or {"tools":[...]} first; it is available on the next model request.`,
		parameters: Type.Object(
			{
				family: Type.Optional(Type.String({ description: "Family name to wake, e.g. computer-use-ui" })),
				tools: Type.Optional(Type.Array(Type.String(), { description: "Explicit tool names to wake (instead of family)" })),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params) {
			const registered = new Set(pi.getAllTools().map((tool) => tool.name));
			const active = new Set(pi.getActiveTools());
			if (!params?.family && !params?.tools) {
				const parked = config.families
					.map((family) => ({ family: family.name, parked: family.tools.filter((name) => !active.has(name)) }))
					.filter((row) => row.parked.length > 0);
				return {
					...text(
						`Parked: ${parked.map((row) => `${row.family} (${row.parked.length})`).join(", ") || "nothing"}. Last pass parked ${lastParked.length} tool(s). Wake with {"family":...} or {"tools":[...]}.`,
					),
					details: { parked },
				};
			}
			const family = config.families.find((candidate) => candidate.name === params?.family);
			const requested = params?.tools?.length > 0 ? params.tools : family?.tools ?? [];
			if (requested.length === 0) {
				return {
					isError: true,
					...text(`Nothing to wake (unknown family or empty tools). Families: ${config.families.map((row) => row.name).join(", ")}`),
					details: { families: config.families.map((row) => row.name) },
				};
			}
			const unavailable = requested.filter((name) => !registered.has(name));
			if (unavailable.length > 0) {
				return { isError: true, ...text(`Not registered, cannot wake: ${unavailable.join(", ")}`), details: { unavailable } };
			}
			try {
				pi.setActiveTools([...new Set([...pi.getActiveTools(), ...requested])]);
			} catch (error) {
				return { isError: true, ...text(`Activation failed: ${message(error)}`), details: { error: message(error) } };
			}
			const nowActive = new Set(pi.getActiveTools());
			const missing = requested.filter((name) => !nowActive.has(name));
			return missing.length > 0
				? { isError: true, ...text(`Still inactive after wake: ${missing.join(", ")}`), details: { missing } }
				: { ...text(`Awoke ${requested.length} tool(s): ${requested.join(", ")}. Available on the next model request.`), details: { awoke: requested } };
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();
		applyGate(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => applyGate(ctx));
	// MCP proxies register after session_start, so re-check before each turn. Idempotent and
	// transcript-aware: tools already in play are never pulled out from under the model.
	pi.on("before_agent_start", async (_event, ctx) => applyGate(ctx));
}
