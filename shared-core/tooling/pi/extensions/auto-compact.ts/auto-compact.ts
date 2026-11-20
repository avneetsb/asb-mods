/**
 * auto-compact
 *
 * Guarantees that compaction runs whenever the live context reaches an absolute
 * token budget (default 100,000 tokens), independent of the active model's
 * context window.
 *
 * Why an extension: Pi's native trigger is relative —
 *   contextTokens > contextWindow - compaction.reserveTokens
 * so a single reserveTokens value cannot map to "100k used" across the 40k..1M
 * windows available here. This extension measures absolute usage via
 * ctx.getContextUsage() and calls ctx.compact() itself.
 *
 * Configuration (env, read at load):
 *   PI_AUTO_COMPACT_TOKENS   threshold in tokens (default 100000)
 *   PI_AUTO_COMPACT_MID_RUN  "1" also checks at turn_end (default off — see notes)
 *
 * Notes on safety:
 *   - Default check point is `agent_settled`, i.e. after retries, automatic
 *     compaction, and queued continuations have finished. ctx.compact() calls
 *     abort() on the current run, so triggering mid-run would discard the
 *     in-flight assistant attempt (manual compaction does not retry it).
 *     PI_AUTO_COMPACT_MID_RUN=1 opts into turn_end checks anyway.
 *   - Self-limiting: after compaction the live token count drops below the
 *     threshold, so it does not re-fire. An in-flight guard covers the async gap.
 *   - Models whose window is smaller than the threshold are handled by Pi's own
 *     window-pressure compaction; this extension never fires for them.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const envInt = (name: string, fallback: number): number => {
	const raw = process.env[name];
	if (!raw) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

let threshold = envInt("PI_AUTO_COMPACT_TOKENS", 100_000);
const midRun = process.env.PI_AUTO_COMPACT_MID_RUN === "1";

export default function (pi: ExtensionAPI) {
	let inFlight = false;

	const maybeCompact = (ctx: ExtensionContext, where: string) => {
		if (inFlight || !ctx.isIdle()) return;

		const usage = ctx.getContextUsage();
		const tokens = usage?.tokens ?? null;
		if (tokens === null) return; // unknown right after a compaction
		if (tokens < threshold) return;

		const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		if (window && window <= threshold) return; // native trigger fires first, by design

		inFlight = true;
		const notify = (msg: string, level: "info" | "error") => {
			if (ctx.hasUI) ctx.ui.notify(msg, level);
		};
		notify(
			`auto-compact: ${tokens.toLocaleString()} tokens >= ${threshold.toLocaleString()} (${where}) — compacting`,
			"info",
		);

		ctx.compact({
			customInstructions: `Context reached ${threshold.toLocaleString()} tokens. Summarize aggressively; keep exact file paths, function names, commands, and error messages.`,
			onComplete: () => {
				inFlight = false;
				notify("auto-compact: done", "info");
			},
			onError: (error) => {
				inFlight = false;
				if (error.message === "Compaction cancelled" || error.message === "Already compacted") return;
				notify(`auto-compact: failed — ${error.message}`, "error");
			},
		});
	};

	// Primary: run fully settled, nothing queued, no retry in flight.
	pi.on("agent_settled", (_event, ctx) => maybeCompact(ctx, "settled"));

	// Opt-in: catch pressure during long tool loops (may abort the in-flight attempt).
	if (midRun) {
		pi.on("turn_end", (_event, ctx) => {
			if (ctx.hasPendingMessages()) return;
			maybeCompact(ctx, "turn_end");
		});
	}

	pi.registerCommand("auto-compact", {
		description: "Show or set the absolute auto-compaction token threshold",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg) {
				const n = Number.parseInt(arg.replace(/[^0-9]/g, ""), 10);
				if (!Number.isFinite(n) || n <= 0) {
					if (ctx.hasUI) ctx.ui.notify(`Invalid token count: ${arg}`, "error");
					return;
				}
				threshold = n;
			}
			const usage = ctx.getContextUsage();
			if (ctx.hasUI) {
				ctx.ui.notify(
					`auto-compact threshold: ${threshold.toLocaleString()} tokens ` +
						`(now ${usage?.tokens?.toLocaleString() ?? "?"}/${usage?.contextWindow?.toLocaleString() ?? "?"}, ` +
						`mid-run ${midRun ? "on" : "off"}, in-flight ${inFlight ? "yes" : "no"})`,
					"info",
				);
			}
		},
	});
}
