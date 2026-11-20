/**
 * prompt-recall — cross-session prompt recall without restyling the composer.
 *
 * Replaces the capability of pi-prompt-history, which swapped the whole editor
 * component at session start (clobbering composer chrome installed by other UI
 * extensions). This extension instead:
 *   - Seeds pi's NATIVE editor history (Up/Down arrows) with prompts from past
 *     session files, by wrapping whatever editor factory is already installed
 *     (ctx.ui.getEditorComponent) rather than replacing it. With no other editor
 *     extension present it falls back to stock CustomEditor, identical in
 *     appearance to pi's default box.
 *   - Registers Ctrl+R for a fuzzy reverse-search overlay (transient popup via
 *     ctx.ui.custom; Tab toggles current-folder / all-folders scope, Enter
 *     restores the selected prompt into the composer, Escape cancels).
 * History is re-derived from session JSONL files at every session start, so no
 * separate persistence store is needed.
 */
import { promises as fs } from "node:fs";

import { Key, Input, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import {
	CustomEditor,
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const HISTORY_CAP = 500;
const VISIBLE_RESULTS = 9;

type Scope = "current" | "all";

let cwdNow: string = process.cwd();
let sessionDir: string | undefined;
const store: Record<Scope, string[]> = { current: [], all: [] }; // newest-first, deduped
let scope: Scope = "current";
let liveEditor: any;
let installedFactory: ((tui: any, theme: any, keybindings: any) => any) | undefined;
let seedState = "not installed";
let lastEditorType = "none";

function extractUserText(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const p = part as Record<string, unknown>;
		if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
	}
	return parts.length > 0 ? parts.join("\n") : null;
}

function isRecallable(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.length > 0 && !trimmed.startsWith("/") && !trimmed.startsWith("!");
}

async function loadScope(allFolders: boolean): Promise<string[]> {
	let infos: any[] | undefined;
	try {
		infos = allFolders
			? await SessionManager.listAll(sessionDir)
			: await SessionManager.list(cwdNow, sessionDir);
	} catch {
		return [];
	}
	const paths = (infos ?? [])
		.map((info) => info?.path)
		.filter((p: unknown): p is string => typeof p === "string");

	const withMtime = await Promise.all(
		paths.map(async (p) => {
			try {
				return { p, m: (await fs.stat(p)).mtimeMs };
			} catch {
				return { p, m: 0 };
			}
		}),
	);
	withMtime.sort((a, b) => a.m - b.m);

	const ordered: string[] = [];
	const seen = new Set<string>();
	for (const { p } of withMtime) {
		let raw: string;
		try {
			raw = await fs.readFile(p, "utf8");
		} catch {
			continue;
		}
		for (const line of raw.split(/\r?\n/)) {
			if (!line.trim()) continue;
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry?.type !== "message") continue;
			const message = entry.message;
			if (!message || message.role !== "user") continue;
			const text = extractUserText(message.content);
			if (!text || !isRecallable(text)) continue;
			if (seen.has(text)) continue;
			seen.add(text);
			ordered.push(text.trim());
		}
	}
	return ordered.reverse().slice(0, HISTORY_CAP);
}

/** Seed a live editor instance's native history. Returns false if the editor shape doesn't expose it. */
function seedEditor(ed: any, items: string[]): boolean {
	if (!ed || !Array.isArray(ed.history)) return false;
	ed.history = [...items];
	ed.historyIndex = -1;
	// Raise the native cap (100) to HISTORY_CAP and keep our scoped store as the
	// source of truth for re-seeds.
	ed.addToHistory = (text: string) => {
		const trimmed = String(text ?? "").trim();
		if (!trimmed || ed.history[0] === trimmed) return;
		ed.history.unshift(trimmed);
		if (ed.history.length > HISTORY_CAP) ed.history.length = HISTORY_CAP;
		ed.historyIndex = -1;
	};
	return true;
}

function scoreMatch(text: string, query: string): number | null {
	const haystack = text.toLowerCase();
	const needle = query.toLowerCase().trim();
	if (!needle) return 0;
	if (haystack === needle) return 10000;
	const index = haystack.indexOf(needle);
	if (index === -1) return null;
	let score = 5000 - Math.min(index * 8, 4000) - Math.min(text.length, 500);
	if (index === 0) score += 1000;
	const prev = index > 0 ? haystack[index - 1] : undefined;
	if (prev !== undefined && /[\s./-]/.test(prev)) score += 600;
	return score;
}

function fuzzyFind(items: string[], query: string): string[] {
	if (!query.trim()) return items.slice(0, VISIBLE_RESULTS);
	return items
		.map((item) => ({ item, score: scoreMatch(item, query) }))
		.filter((entry): entry is { item: string; score: number } => entry.score !== null)
		.sort((a, b) => b.score - a.score)
		.slice(0, VISIBLE_RESULTS)
		.map((entry) => entry.item);
}

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const REVERSE = "\x1b[7m";
const RESET = "\x1b[0m";

class RecallOverlay {
	public invalidate(): void {}
	public requestedHeight = 2 + VISIBLE_RESULTS;
	private query = "";
	private items: string[];
	private selected: string[];
	private sel = 0;
	private input: Input;

	constructor(
		private tui: any,
		private done: (result: string | null) => void,
	) {
		this.items = store[scope];
		this.selected = fuzzyFind(this.items, "");
		this.input = new Input({ prompt: "? " });
	}

	private refresh(): void {
		this.items = store[scope];
		this.selected = fuzzyFind(this.items, this.query);
		this.sel = 0;
		this.tui?.requestRender?.();
	}

	public render(width: number): string[] {
		const line = (text: string) => {
			const w = visibleWidth(text);
			return text + " ".repeat(Math.max(0, width - w));
		};
		const out: string[] = [];
		out.push(line(`${BOLD}recall${RESET} ${DIM}[${scope === "all" ? "all folders" : "this folder"}]${RESET} ${DIM}(tab=scope ↑↓=pick enter=paste esc=cancel)${RESET}`));
		for (const il of this.input.render(width)) {
			out.push(il);
		}
		for (let i = 0; i < VISIBLE_RESULTS; i++) {
			const item = this.selected[i];
			if (item === undefined) {
				out.push(line(""));
				continue;
			}
			const marker = i === this.sel ? `${REVERSE}>${RESET}` : " ";
			const body = item.replace(/\s+/g, " ");
			out.push(line(`  ${marker} ${body}`));
		}
		return out;
	}

	public handleInput(data: string): void {
		if (data === "\x1b" || matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}
		if (data === "\t") {
			scope = scope === "current" ? "all" : "current";
			seedEditor(liveEditor, store[scope]);
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.up)) {
			if (this.sel > 0) this.sel--;
			this.tui?.requestRender?.();
			return;
		}
		if (matchesKey(data, Key.down)) {
			if (this.sel < this.selected.length - 1) this.sel++;
			this.tui?.requestRender?.();
			return;
		}
		if (data === "\r" || data === "\n" || matchesKey(data, Key.enter) || matchesKey(data, "return")) {
			this.done(this.selected[this.sel] ?? null);
			return;
		}
		this.input.handleInput(data);
		this.query = this.input.getValue();
		this.refresh();
	}
}

async function openRecall(ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") return;
	const picked = await ctx.ui.custom<string | null>(
		(tui, _theme, _keybindings, done) => new RecallOverlay(tui, done),
		{ overlay: true, overlayOptions: { width: "80%" } },
	);
	if (typeof picked === "string" && picked.trim()) {
		ctx.ui.setEditorText(picked);
	}
}

/** Wrap whichever editor factory is already installed; never replace foreign chrome. */
function wrapCurrentFactory(ctx: ExtensionContext): void {
	const prev = ctx.ui.getEditorComponent?.() as
		| ((tui: any, theme: any, keybindings: any) => any)
		| undefined;
	const factory = (tui: any, theme: any, keybindings: any) => {
		const ed = prev
			? prev(tui, theme, keybindings)
			: new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
		const seededOk = seedEditor(ed, store[scope]);
		lastEditorType = ed?.constructor?.name ?? "unknown";
		seedState = seededOk
			? `${lastEditorType}, ${store[scope].length} prompts seeded`
			: `${lastEditorType}, no native history slot`;
		liveEditor = ed;
		return ed;
	};
	installedFactory = factory;
	ctx.ui.setEditorComponent(factory);
}

async function install(ctx: ExtensionContext): Promise<void> {
	const [current, all] = await Promise.all([loadScope(false), loadScope(true)]);
	store.current = current;
	store.all = all;
	wrapCurrentFactory(ctx);
	// Self-heal: chrome extensions (pi-atelier, pi-one-ui) may install their
	// factory after our deferred pass. Re-wrap whenever someone replaced ours —
	// bounded to the startup window so intentional mid-session resets stick.
	for (const delay of [40, 120, 300, 800, 1600]) {
		await new Promise((resolve) => setTimeout(resolve, delay));
		try {
			if (ctx.ui.getEditorComponent?.() !== installedFactory) {
				wrapCurrentFactory(ctx);
			}
		} catch {
			return;
		}
	}
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		cwdNow = ctx.cwd ?? process.cwd();
		try {
			sessionDir = ctx.sessionManager.getSessionDir();
		} catch {
			sessionDir = undefined;
		}
		scope = "current";
		liveEditor = undefined;
		// Defer one macrotask so other extensions' async session_start handlers
		// (pi-atelier, pi-one-ui, ...) have installed their editor factories first;
		// we then wrap theirs instead of clobbering it.
		setTimeout(() => {
			void install(ctx).catch(() => {});
		}, 0);
	});

	pi.registerShortcut(Key.ctrl("r"), {
		description: "Reverse-search prompts from previous sessions",
		handler: (ctx) => openRecall(ctx),
	});

	pi.registerCommand("prompt-recall-stats", {
		description: "Show prompt history sizes loaded by prompt-recall",
		handler: async (_args, ctx) => {
			await Promise.all([loadScope(false), loadScope(true)]).then(([c, a]) => {
				store.current = c;
				store.all = a;
			});
			if (liveEditor) seedEditor(liveEditor, store[scope]);
			ctx.ui.notify?.(
				`prompt-recall: ${store.current.length} this-folder / ${store.all.length} all-folder prompts (scope: ${scope}; editor: ${seedState})`,
				"info",
			);
		},
	});
}
