// working-line-rate-off — test/strip-test.mjs
//
// Drives the real extension against fake pi + fake ui facades. The point of these
// assertions is that the ⚡ meter disappears while every other segment, the escape
// structure, and the object identity of untouched payloads survive.
//
// Drive: node --experimental-strip-types test/strip-test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(path.join(HERE, "..", "extensions", "rate-off.ts"));
const { stripRateMeter, sanitizeIndicatorOptions, installRateOffGuard, default: plugin } = mod;

const LIVE = "Blanching… · 18m06s · thinking 8m18s · ↑314k ↓26k ⚡31.6 tok/s";
const EXPECTED = "Blanching… · 18m06s · thinking 8m18s · ↑314k ↓26k";

// ── 1. the operator's exact line, unstyled ────────────────────────────────────────────────
assert.equal(stripRateMeter(LIVE), EXPECTED, "plain frame must lose exactly the meter");

// ── 2. per-cell ANSI styling (what pi-one-ui actually emits) ─────────────────────────────
// pi-one-ui colours the row grapheme-cell by cell (renderWorkingLineHigh / classicTier),
// so the meter text is never contiguous in the raw frame string.
const ESC = String.fromCharCode(27);
const styledCell = (ch, code) => `${ESC}[${code}m${ch}${ESC}[0m`;
const SGR_ANY = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const SGR_RESET = new RegExp(`${ESC}\\[0m`, "g");
const styled = [...LIVE]
  .map((ch, i) => styledCell(ch, i % 2 ? "2" : "38;5;244"))
  .join("");
const strippedStyled = stripRateMeter(styled);
assert.ok(!strippedStyled.includes("tok/s"), "no meter text may survive styling");
assert.ok(!strippedStyled.includes("⚡"), "no bolt may survive styling");
// Cell-by-cell styling splits "314k" across escape runs, so counters are checked
// on the de-styled text, never as a raw substring of the frame.
const styledVisible = strippedStyled.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
assert.ok(styledVisible.includes("↑314k") && styledVisible.includes("↓26k"), "counters must survive");
// visible text, escapes removed, must be exactly the expected row
assert.equal(strippedStyled.replace(SGR_ANY, ""), EXPECTED, "visible text after styling round-trip");
// escape runs must stay balanced: same number of resets before/after modulo the dropped span,
// and every remaining SGR open is still followed by a reset.
const totalRuns = (strippedStyled.match(SGR_ANY) ?? []).length;
const resets = (strippedStyled.match(SGR_RESET) ?? []).length;
assert.equal(totalRuns - resets, resets, "every surviving colour open keeps its reset");
assert.ok(totalRuns < (styled.match(new RegExp(`${ESC}\\[[0-9;]*m`, "g")) ?? []).length,
	"the meter's own escape runs went away with it");

// ── 3. untouched payloads return the identical object, not a copy ────────────────────────
const noMeter = "Cooking… · 4s · ↑12k ↓980";
assert.equal(stripRateMeter(noMeter), noMeter);
assert.equal(stripRateMeter("renders 1200 tok/s somewhere else"), "renders 1200 tok/s somewhere else",
	"a bare rate with no bolt is not this component's business");

// ── 4. the approximate + k-scaled shapes pi-one-ui can produce ───────────────────────────
assert.equal(stripRateMeter("↑314k ↓26k ⚡ ~820 tok/s"), "↑314k ↓26k");
assert.equal(stripRateMeter("↑314k ↓26k ⚡1.2k tok/s"), "↑314k ↓26k");
assert.equal(
	stripRateMeter("↑1k ↓2k ⚡31.6 tok/s · ⚡ 5 tok/s"),
	"↑1k ↓2k ·",
	"both meters go; the separator that sat between them is left as-is (documented: pi-one-ui emits at most one meter per frame, at the end)",
);

// ── 5. indicator option handling ─────────────────────────────────────────────────────────
assert.equal(sanitizeIndicatorOptions(undefined), undefined);
const noFrames = { intervalMs: 60 };
assert.equal(sanitizeIndicatorOptions(noFrames), noFrames, "options with no frames pass through by identity");
const passthrough = { intervalMs: 100 };
assert.equal(sanitizeIndicatorOptions(passthrough), passthrough, "no frames array -> same object");
const clean = { frames: [noMeter, 42], intervalMs: 60 };
assert.equal(sanitizeIndicatorOptions(clean), clean, "frames without a meter -> same object identity");
const dirty = { frames: [LIVE, LIVE], intervalMs: 60, extra: "kept" };
const sanitized = sanitizeIndicatorOptions(dirty);
assert.notEqual(sanitized, dirty);
assert.deepEqual(sanitized.frames, [EXPECTED, EXPECTED]);
assert.equal(sanitized.intervalMs, 60, "intervalMs survives");
assert.equal(sanitized.extra, "kept", "unknown option keys survive");

// ── 6. facade wrapping: intercept, idempotence, pass-through ─────────────────────────────
function fakeUi() {
	const calls = [];
	return {
		calls,
		setWorkingIndicator: (options) => calls.push({ kind: "indicator", options }),
		setWorkingMessage: (message) => calls.push({ kind: "message", message }),
	};
}

const ui = fakeUi();
const first = installRateOffGuard(ui);
assert.equal(first.installed, true);
assert.equal(first.reason, "working-line meters will be stripped");
ui.setWorkingIndicator({ frames: [LIVE], intervalMs: 60 });
assert.equal(ui.calls[0].options.frames[0], EXPECTED, "frames are rewritten on the way in");
ui.setWorkingMessage(`${LIVE}`);
assert.equal(ui.calls[1].message, EXPECTED, "setWorkingMessage is guarded too");
ui.setWorkingIndicator();
assert.equal(ui.calls[2].options, undefined, "clearing the indicator still reaches pi");
const untouched = { frames: [noMeter], intervalMs: 60 };
ui.setWorkingIndicator(untouched);
assert.equal(ui.calls[3].options, untouched, "clean frames keep identity through the wrapper");

const second = installRateOffGuard(ui);
assert.equal(second.reason, "already installed", "re-install must not nest wrappers");
const nestedBefore = ui.calls.length;
ui.setWorkingIndicator({ frames: [LIVE] });
assert.equal(ui.calls.length, nestedBefore + 1, "exactly one downstream call per invocation");
assert.equal(ui.calls[nestedBefore].options.frames[0], EXPECTED);

assert.deepEqual(installRateOffGuard(undefined), { installed: false, reason: "no ui facade on ctx" });
assert.equal(installRateOffGuard({}).installed, false, "a facade without working-line setters is left alone");

// ── 7. plugin wiring ─────────────────────────────────────────────────────────────────────
const handlers = new Map();
plugin({ on: (name, handler) => { handlers.set(name, handler); return () => {}; } });
assert.deepEqual([...handlers.keys()].sort(), ["agent_start", "session_start"]);
const liveUi = fakeUi();
for (const name of handlers.keys()) await handlers.get(name)({}, { ui: liveUi });
liveUi.setWorkingIndicator({ frames: [`● ${LIVE}`] });
assert.equal(liveUi.calls[0].options.frames[0], `● ${EXPECTED}`);
assert.doesNotThrow(() => handlers.get("session_start")({}, {}), "a ctx without ui must not throw");

// ── 8. kill switch ───────────────────────────────────────────────────────────────────────
const probe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wlro-")), "probe.mjs");
fs.writeFileSync(
	probe,
	`const m = await import(${JSON.stringify(path.join(HERE, "..", "extensions", "rate-off.ts"))});
const ui = { setWorkingIndicator: (o) => globalThis.seen = o };
console.log(JSON.stringify(m.installRateOffGuard(ui)));
ui.setWorkingIndicator({ frames: ["${LIVE}"] });
console.log(JSON.stringify(globalThis.seen.frames[0]));`,
);
const off = execFileSync(process.execPath, ["--experimental-strip-types", probe], {
	env: { ...process.env, WORKING_LINE_RATE_OFF: "0" },
	encoding: "utf8",
});
assert.match(off, /"installed":false/);
assert.ok(off.includes("tok/s"), "with the kill switch the meter must pass through untouched");

console.log("all working-line-rate-off assertions passed");
