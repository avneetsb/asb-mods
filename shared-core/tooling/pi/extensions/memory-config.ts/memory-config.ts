/**
 * memory-config.ts — inspect and change Pi's memory settings from chat.
 *
 * Why: the memory stack (pi-observational-memory + pi's own compaction) is
 * configured in ~/.pi/agent/settings.json, which the model has no reason to go
 * looking at. This tool lists those settings and writes validated values back,
 * so "is auto-compaction on?" or "raise the compaction threshold" never needs a
 * hand-edited JSON file.
 *
 * Only keys verified against pi-observational-memory's documented schema and the
 * live settings.json are exposed; anything else is refused rather than invented.
 *
 * API verified 2026-10-26 against
 *   dist/core/extensions/types.d.ts (ToolDefinition: name, label, description,
 *   promptSnippet, promptGuidelines, parameters: TSchema, execute(id, params,
 *   signal, onUpdate, ctx)) and examples/extensions/dynamic-tools.ts
 *   (`import { Type } from "typebox"`). An earlier revision used a `params`
 *   field with `instructions`, which pi rejects: "must define an object
 *   parameter schema".
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const NS = "observational-memory";

type FieldType = "bool" | "int" | "choice";

interface Field {
	/** Path inside settings.json, e.g. ["observational-memory", "passive"]. */
	path: string[];
	label: string;
	type: FieldType;
	hint: string;
	options?: string[];
	min?: number;
	max?: number;
}

/** Settings this tool may change. Keys verified against the extension README. */
const FIELDS: Field[] = [
	{
		path: [NS, "compactAfterTokens"],
		label: "Compact after (tokens)",
		type: "int",
		hint: "Estimated transcript size that triggers proactive compaction. Default 81000.",
		min: 4000,
		max: 1_000_000,
	},
	{
		path: [NS, "compactAfterTokensMode"],
		label: "Threshold mode",
		type: "choice",
		options: ["calibrated", "ratio"],
		hint: "calibrated = fixed token threshold; ratio = fraction of the model's context window.",
	},
	{
		path: [NS, "compactAfterTokensRatio"],
		label: "Threshold ratio",
		type: "int",
		hint: "Only used in ratio mode, as a percent of the context window (e.g. 68 = 0.68).",
		min: 10,
		max: 95,
	},
	{
		path: [NS, "observationsPoolMaxTokens"],
		label: "Memory pool max (tokens)",
		type: "int",
		hint: "Cap on the rolling observations pool injected into context.",
		min: 1000,
		max: 200_000,
	},
	{
		path: [NS, "agentMaxTurns"],
		label: "Memory worker max turns",
		type: "int",
		hint: "Per-run turn budget for the memory sub-agent.",
		min: 1,
		max: 64,
	},
	{
		path: [NS, "passive"],
		label: "Passive mode",
		type: "bool",
		hint: "true = only remember when asked; false = observe continuously. Env PI_OBSERVATIONAL_MEMORY_PASSIVE overrides this.",
	},
	{
		path: [NS, "showWorkerNotifications"],
		label: "Worker notifications",
		type: "bool",
		hint: "Show notices when the memory worker runs.",
	},
	{
		path: ["compaction", "enabled"],
		label: "Pi auto-compaction",
		type: "bool",
		hint: "Pi's own compaction, independent of the memory extension.",
	},
];

const PARAMS = Type.Object({
	action: Type.Optional(
		Type.String({ description: '"show" (default) lists every setting with its current value; "set" changes one key.' }),
	),
	key: Type.Optional(Type.String({ description: `Setting path for action="set", e.g. ${NS}.passive.` })),
	value: Type.Optional(
		Type.Union([Type.String(), Type.Number(), Type.Boolean()], { description: `New value for action="set".` }),
	),
});

type Settings = Record<string, unknown>;
/** Domain type for a settings leaf: only JSON scalars live at these paths. */
type SettingValue = string | number | boolean | undefined;

function readSettings(): Settings {
	try {
		return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as Settings;
	} catch {
		return {};
	}
}

function writeSettings(settings: Settings): void {
	writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

function getPath(settings: Settings, path: string[]): SettingValue {
	let node: unknown = settings;
	for (const key of path) {
		if (typeof node !== "object" || node === null) return undefined;
		node = (node as Record<string, unknown>)[key];
	}
	return typeof node === "string" || typeof node === "number" || typeof node === "boolean" ? node : undefined;
}

function setPath(settings: Settings, path: string[], value: unknown): void {
	let node = settings;
	for (const key of path.slice(0, -1)) {
		const next = node[key];
		if (typeof next !== "object" || next === null) {
			node[key] = {};
		}
		node = node[key] as Record<string, unknown>;
	}
	node[path[path.length - 1] as string] = value;
}

/** Validate and coerce a caller-supplied value for one field. */
function coerce(field: Field, raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
	if (field.type === "bool") {
		if (typeof raw === "boolean") return { ok: true, value: raw };
		const text = String(raw).trim().toLowerCase();
		if (["true", "on", "yes", "y", "1"].includes(text)) return { ok: true, value: true };
		if (["false", "off", "no", "n", "0"].includes(text)) return { ok: true, value: false };
		return { ok: false, error: `${field.label}: expected true/false, got "${String(raw)}"` };
	}
	if (field.type === "choice") {
		const text = String(raw).trim();
		if (field.options?.includes(text)) return { ok: true, value: text };
		return { ok: false, error: `${field.label}: expected one of ${field.options?.join(", ")}, got "${text}"` };
	}
	// int: accept a bare number, and the percent form used by the ratio field.
	const text = String(raw).trim().replace(/[%\s,]/g, "");
	const n = Number(text);
	if (!Number.isFinite(n)) return { ok: false, error: `${field.label}: expected a number, got "${String(raw)}"` };
	if (field.min !== undefined && n < field.min) return { ok: false, error: `${field.label}: minimum is ${field.min}` };
	if (field.max !== undefined && n > field.max) return { ok: false, error: `${field.label}: maximum is ${field.max}` };
	let value: number = Math.round(n);
	if (field.path.includes("compactAfterTokensRatio")) value = value / 100; // percent -> fraction
	return { ok: true, value };
}

function formatValue(field: Field, current: SettingValue): string {
	if (current === undefined) return "not set (using default)";
	if (field.path.includes("compactAfterTokensRatio") && typeof current === "number") {
		return `${Math.round(current * 100)}%`;
	}
	return String(current);
}

function snapshot(settings: Settings): { field: Field; current: SettingValue }[] {
	return FIELDS.map((field) => ({ field, current: getPath(settings, field.path) }));
}

const KNOWN_KEYS = FIELDS.map((f) => f.path.join(".")).join(", ");

export default function memoryConfig(pi: ExtensionAPI) {
	pi.registerTool({
		name: "memory_config",
		label: "Memory settings",
		description: `Read or change Pi's memory settings in ~/.pi/agent/settings.json. action "show" lists every setting this tool can change with its current value; action "set" changes one: { key, value }, where key is one of: ${KNOWN_KEYS}. Use it for questions like "is auto-compaction on?" or "raise the compaction threshold" instead of editing settings.json by hand. Values are validated (numbers bounded, modes enumerated) and the applied value is reported back.`,
		promptSnippet: "Inspect or change Pi's memory settings (compaction threshold, passive mode, memory pool, worker budget).",
		promptGuidelines: [
			"MUST use memory_config when the user asks to inspect, change, or tune Pi's memory settings (compaction threshold or auto-compaction, passive mode, observations pool size, memory worker budget, worker notifications) — do not hand-edit settings.json with generic file tools and do not answer from remembered defaults. Applies equally to \"is X on?\" questions about these settings.",
		],
		parameters: PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const action = String(params?.action ?? "show").trim().toLowerCase();
			const settings = readSettings();

			if (action === "show") {
				const rows = snapshot(settings).map(({ field, current }) => `${field.path.join(".")} = ${formatValue(field, current)}`);
				return {
					content: [{ type: "text", text: `Memory settings (${SETTINGS_PATH}):\n${rows.join("\n")}` }],
					details: { settings },
				};
			}

			if (action === "set") {
				const key = String(params?.key ?? "").trim();
				const field = FIELDS.find((f) => f.path.join(".") === key);
				if (!field) {
					return { content: [{ type: "text", text: `Unknown setting "${key}". Known: ${KNOWN_KEYS}` }], isError: true };
				}
				const result = coerce(field, params?.value);
				if (!result.ok) {
					return { content: [{ type: "text", text: result.error }], isError: true };
				}
				const before = getPath(settings, field.path);
				setPath(settings, field.path, result.value);
				try {
					writeSettings(settings);
				} catch (error) {
					return { content: [{ type: "text", text: `Could not write settings: ${String(error)}` }], isError: true };
				}
				const note = field.path.includes("compactAfterTokensRatio") ? ' (takes effect once mode is "ratio")' : "";
				return {
					content: [
						{
							type: "text",
							text: `Set ${field.path.join(".")} = ${formatValue(field, result.value as SettingValue)} (was ${formatValue(field, before)})${note}. Applies to the next session; run /reload to apply now.`,
						},
					],
					details: { key, before, after: result.value },
				};
			}

			return { content: [{ type: "text", text: `Unknown action "${action}". Use "show" or "set".` }], isError: true };
		},
	});

	// Same editor as a slash command: pick a row, type a new value, Enter writes it.
	pi.registerCommand("memory-config", {
		description: "Show and edit Pi's memory settings",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const rows = snapshot(readSettings()).map(({ field, current }) => ({
				field,
				pick: `${field.label}: ${formatValue(field, current)}  (${field.path.join(".")})`,
			}));
			const chosen = await ctx.ui.select("Memory settings — pick one to change", rows.map((r) => r.pick));
			const row = rows.find((r) => r.pick === chosen);
			if (!row) {
				ctx.ui.notify("Cancelled.", "info");
				return;
			}
			const raw = await ctx.ui.input(`New value for ${row.field.path.join(".")}`, row.field.hint);
			if (raw === null) {
				ctx.ui.notify("Cancelled.", "info");
				return;
			}
			const result = coerce(row.field, raw);
			if (!result.ok) {
				ctx.ui.notify(result.error, "error");
				return;
			}
			const settings = readSettings();
			setPath(settings, row.field.path, result.value);
			writeSettings(settings);
			ctx.ui.notify(
				`Set ${row.field.path.join(".")} = ${formatValue(row.field, result.value as SettingValue)} — run /reload to apply now`,
				"info",
			);
		},
	});
}
