/**
 * lens-diagnostic-pane.demo.ts — offline render harness (no pi host needed).
 * Feeds synthetic pilens:diagnostics payloads through applyPayload and prints
 * the pane at three widths, asserting every line fits its requested width.
 * Run: node extensions/lens-diagnostic-pane.demo.ts   (Node >= 23, native TS)
 */

import { applyPayload, buildPaneLines } from "../extensions/lens-diagnostic-pane.ts";
import { writeFileSync } from "node:fs";
import type { PaneState } from "../extensions/lens-diagnostic-pane.ts";

// demo theme — approximate pi's named colors with ANSI
const CODES: Record<string, string> = {
	accent: "\u001b[36m",
	muted: "\u001b[90m",
	dim: "\u001b[2;37m",
	error: "\u001b[31m",
	warning: "\u001b[33m",
	success: "\u001b[32m",
	mdHeading: "\u001b[38;5;180m",
};
const theme = { fg: (c: string, s: string) => `${CODES[c] ?? ""}${s}\u001b[0m` };

const CST = "/Users/example/work/customer-service";
const TS = 1730200000000;

function mkDiag(sev: string, line: number, rule: string, message: string) {
	return { severity: sev, line, rule, message };
}

const state: PaneState = (function init() {
	// hack: build via the real exported state machine applied to a fresh payload
	const s = { cwd: CST, files: new Map(), fixedCount: 0, lastUpdate: 0, dedupeKey: "" } as PaneState;
	applyPayload(s, {
		v: 1, source: "pi-lens", cwd: CST, seq: 1, ts: TS - 5000,
		files: [{ path: `${CST}/src/billing/invoice-sync.ts`, diagnostics: [] }], // one earlier fix
	}, TS);
	applyPayload(s, {
		v: 1, source: "pi-lens", cwd: CST, seq: 2, ts: TS,
		files: [
			{
				path: `${CST}/extensions/atelier-lens-panel.ts`,
				diagnostics: [
					mkDiag("error", 256, "no-unused-vars", "'captured' is declared but its value is never read."),
					mkDiag("error", 271, "typescript:6133", "'off' is declared but its value is never read."),
					mkDiag("error", 303, "typescript:6133", "'provider' is declared but never awaited."),
					mkDiag("warning", 88, "no-floating-promises", "Promises must be awaited, voided, or rejected."),
					mkDiag("warning", 142, "no-explicit-any", "Unexpected any type. Specify a different type."),
				],
				truncated: true,
			},
			{
				path: `${CST}/src/orders/dispatch.ts`,
				diagnostics: [
					mkDiag("error", 42, "typescript:2345", "Argument of type 'string' is not assignable to parameter of type 'OrderId'."),
					mkDiag("warning", 97, "no-console", "Unexpected console statement."),
				],
			},
			{
				path: `${CST}/src/orders/retry-queue.ts`,
				diagnostics: [mkDiag("warning", 12, "unused-import", "'fs' is imported but unused.")],
			},
		],
	}, TS);
	return s;
})();

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const wide = (cp: number) =>
	(cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0x1f300 && cp <= 0x1f64f))) ? 2 : 1;
const vw = (s: string) => { let n = 0; for (const ch of s.replace(ANSI, "")) n += wide(ch.codePointAt(0) ?? 0); return n; };

let allFit = true;
let allFramed = true;
const preview: string[] = [];
for (const w of [120, 84, 56]) {
	const lines = buildPaneLines(state, theme, w);
	for (const l of lines) {
		const plain = l.replace(ANSI, "");
		if (vw(l) > w) { allFit = false; console.error(`FAIL width ${w}`); }
		if (!"╭│├╰".includes(plain[0] ?? "") || !"╮│┤╯".includes(plain[plain.length - 1] ?? "")) {
			allFramed = false;
			console.error(`FAIL frame ${w}: ${JSON.stringify(plain.slice(0, 30))}`);
		}
	}
	preview.push(`=== width ${w} ===`, ...lines, "");
}

// clean transition → pane content empties (host would unmount)
applyPayload(state, { v: 1, source: "pi-lens", cwd: CST, seq: 3, ts: TS + 2000, files: [
	{ path: `${CST}/extensions/atelier-lens-panel.ts`, diagnostics: [] },
	{ path: `${CST}/src/orders/dispatch.ts`, diagnostics: [] },
	{ path: `${CST}/src/orders/retry-queue.ts`, diagnostics: [] },
] }, TS + 2000);
const unmounts = state.files.size === 0;

writeFileSync("/tmp/pi/01a180ea-56d6-729c-a317-5ee75bda2ab2/pane-preview.json", JSON.stringify(preview, null, 1));
console.log(`verdict fit=${allFit ? "PASS" : "FAIL"} framed=${allFramed ? "PASS" : "FAIL"} unmount=${unmounts ? "PASS" : "FAIL"}`);
