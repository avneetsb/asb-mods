// Fork-local regression harness (not upstream): exercises the assistant *text* path,
// which is where Pi >= 1.5.0 broke pi-thinking-steps.
//
// Pi 1.5.0 changed the internal helper to
//   createMarkdownTransform(messageType, isStreaming: () => boolean, transformers, messageId?, timestamp?)
// (see dist/modes/interactive/components/markdown-transform.d.ts), while pi-thinking-steps 1.0.17
// still passes `this.isStreaming` (a boolean). The helper calls isStreaming() eagerly while building
// the transform context, so every assistant text block throws
// "TypeError: isStreaming is not a function" out of Markdown.render -> AssistantMessageComponent.render.
// Upstream's scripts/test-host.mjs only ever renders *thinking* content, so it never reached that line.
//
// Run from the package root against the installed Pi host:
//   PI_TEST_HOST_PACKAGE=<path to @earendil-works/pi-coding-agent> node scripts/test-host-markdown.mjs
// Compare another copy of the extension (default: ./index.ts):
//   PI_TEST_EXTENSION_ENTRY=/path/to/pi-thinking-steps/index.ts node scripts/test-host-markdown.mjs

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

const hostRoot = resolve(process.env.PI_TEST_HOST_PACKAGE ?? "node_modules/@earendil-works/pi-coding-agent");
const packageRoot = resolve(process.env.PI_TEST_PACKAGE_ROOT ?? ".");
const entry = resolve(process.env.PI_TEST_EXTENSION_ENTRY ?? join(packageRoot, "index.ts"));
const bundled = existsSync(join(hostRoot, "dist/bundle/index.js"));
process.env.PI_PACKAGE_DIR = hostRoot;

const host = await import(pathToFileURL(join(hostRoot, bundled ? "dist/bundle/index.js" : "dist/index.js")).href);
const unbundled = await import(pathToFileURL(join(hostRoot, "dist/index.js")).href);
const deepComponent = await import(pathToFileURL(join(hostRoot, "dist/modes/interactive/components/assistant-message.js")).href);
const deepTheme = await import(pathToFileURL(join(hostRoot, "dist/modes/interactive/theme/theme.js")).href);

host.initTheme("dark", true);
deepTheme.initTheme?.("dark", true);

const MARKER = "TAPPED_BY_TRANSFORMER";
const PROBE_SOURCE = [
	"export default function (api: any): void {",
	"\tapi.registerMarkdownTransformer((markdown: string, context: any): string => {",
	"\t\tglobalThis.__probeContexts.push({",
	"\t\t\tmessageType: context.messageType,",
	"\t\t\tisStreaming: context.isStreaming,",
	"\t\t\tmessageId: context.messageId,",
	"\t\t\ttimestamp: context.timestamp,",
	"\t\t});",
	`\t\treturn markdown + " ${MARKER}";`,
	"\t});",
	"}",
	"",
].join("\n");

function assistantMessage(text) {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		timestamp: 1,
		stopReason: "stop",
		content: [{ type: "text", text }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

const root = await mkdtemp(join(tmpdir(), "thinking-steps-markdown-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let extension;
let ctx;

// Every AssistantMessageComponent copy present in this process: a bundled host keeps its own copy
// separate from the unbundled graph that extensions are aliased to.
const candidates = [
	{ label: "bundle", mod: host },
	{ label: "unbundled", mod: unbundled },
	{ label: "deep", mod: deepComponent },
]
	.filter((item) => typeof item.mod.AssistantMessageComponent === "function")
	.map((item) => {
		const theme = item.label === "deep" || item.label === "unbundled" ? deepTheme : host;
		return {
			label: item.label,
			Ctor: item.mod.AssistantMessageComponent,
			markdownTheme: typeof theme.getMarkdownTheme === "function" ? theme.getMarkdownTheme() : undefined,
		};
	});

try {
	const agentDir = join(root, "agent");
	await mkdir(agentDir);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	globalThis.__probeContexts = [];

	for (const candidate of candidates) candidate.original = candidate.Ctor.prototype.updateContent;

	const probePath = join(root, "probe-transformer.ts");
	await writeFile(probePath, PROBE_SOURCE, "utf8");

	const loaded = await host.discoverAndLoadExtensions([entry, probePath], root, agentDir);
	assert.deepEqual(loaded.errors, []);
	extension = loaded.extensions.find((item) => item.commands.has("thinking-steps"));
	assert.ok(extension, "Thinking Steps must load through the actual host loader");

	const transformers = loaded.extensions.map((item) => item.markdownTransformer).filter(Boolean);
	assert.equal(transformers.length, 1, "Probe transformer must register through the host's public API");

	const notices = [];
	ctx = {
		cwd: root,
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		sessionManager: host.SessionManager.create(root, root),
		ui: {
			theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
			notify: (message, level) => notices.push({ message, level }),
			setStatus() {},
			setHiddenThinkingLabel() {},
		},
	};
	loaded.runtime.appendEntry = (name, data) => ctx.sessionManager.appendCustomEntry(name, data);
	for (const handler of extension.handlers.get("session_start") ?? []) await handler({}, ctx);
	assert.deepEqual(
		notices.filter((notice) => notice.level === "warning"),
		[],
		"Patch install must not degrade the session"
	);

	const patched = candidates.filter((candidate) => candidate.Ctor.prototype.updateContent !== candidate.original);
	assert.ok(patched.length > 0, "Thinking Steps patch must be installed on at least one AssistantMessageComponent");
	console.log(`Patch installed on: ${patched.map((candidate) => candidate.label).join(", ")}`);

	for (const candidate of patched) {
		// Same construction interactive mode performs: transformers + messageId + timestamp.
		const component = new candidate.Ctor(
			undefined,
			false,
			candidate.markdownTheme,
			"Thinking...",
			1,
			transformers,
			"msg-1",
			"2026-01-02T03:04:05.000Z"
		);
		const message = assistantMessage("Rendered answer text.");

		// Streaming: the transformer must run and its output must render.
		component.updateContent(message, true);
		const streamingLines = component.render(100).map(stripVTControlCharacters).join("\n");
		assert.match(streamingLines, new RegExp(MARKER), `${candidate.label}: extension transformer output must render`);
		assert.match(streamingLines, /Rendered answer text/);

		// Stream end on the SAME component: upstream reads isStreaming per transform, so a reused
		// component must observe the transition. A boolean call site cannot.
		component.updateContent(message, false);
		component.render(100);
	}

	const contexts = globalThis.__probeContexts;
	assert.ok(contexts.length >= 2, `Transformer must be invoked for assistant text (got ${contexts.length})`);
	assert.deepEqual(
		[...new Set(contexts.map((item) => item.messageType))],
		["assistant"],
		"messageType must be assistant"
	);
	assert.deepEqual(
		[...new Set(contexts.map((item) => typeof item.isStreaming))],
		["boolean"],
		`context.isStreaming must be a boolean for every transform (got ${contexts.map((item) => typeof item.isStreaming).join(", ")})`
	);
	assert.equal(contexts[0].isStreaming, true, "First render is streaming");
	assert.equal(contexts.at(-1).isStreaming, false, "A reused component must see the stream end");
	assert.equal(contexts[0].messageId, "msg-1", "messageId must be forwarded to transformers");
	assert.equal(contexts[0].timestamp, "2026-01-02T03:04:05.000Z", "timestamp must be forwarded to transformers");

	console.log(
		`Assistant text path passed (${bundled ? "bundled" : "unbundled"} host; ${patched.length} patched copy/copies, ${contexts.length} transform calls, streaming -> settled).`
	);
} finally {
	try {
		if (extension && ctx) for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({}, ctx);
		for (const candidate of candidates) {
			if (candidate.original) candidate.Ctor.prototype.updateContent = candidate.original;
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		delete globalThis.__probeContexts;
		await rm(root, { recursive: true, force: true });
	}
}
