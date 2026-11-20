/**
 * engram-review-on-compaction
 *
 * Purpose: make memory review automatic — whenever a context compaction runs,
 * Engram's due-review queue is fetched and handed to the model as one compact
 * work item, so stale memories get verdicts instead of rotting in the store.
 *
 * Why compaction is the right trigger: it is the moment the session already
 * agreed its context got too big. Whatever was just summarized away is exactly
 * the material whose recorded facts may now be outdated, and the refresh policy
 * (`review_after`) has usually flagged items by then.
 *
 * Flow:
 *   session_compact   → arm the review (no I/O on a streaming path)
 *   agent_settled     → Pi is idle; GET /review?all_projects=true&limit=N
 *                       if items are due → pi.sendUserMessage(digest), which
 *                       starts a run that triages them with mem_review /
 *                       mem_update / mem_delete
 *
 * Guards: one digest per compaction, a cooldown so back-to-back compactions do
 * not spam, and nothing is sent when the queue is empty or Engram is
 * unreachable (never blocks or noisy-fails a session).
 *
 * Env:
 *   ENGRAM_REVIEW_ON_COMPACT=0        disable the automatic trigger
 *   ENGRAM_REVIEW_LIMIT=N             observations per fetch (default 20)
 *   ENGRAM_REVIEW_COOLDOWN_SECONDS=N  minimum gap between digests (default 600)
 *   ENGRAM_URL / ENGRAM_PORT          override store location (else 127.0.0.1:7437)
 *
 * Command: `/review-memory` — run the same fetch + digest on demand.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type DueItem = Record<string, unknown>;

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

let enabled = process.env.ENGRAM_REVIEW_ON_COMPACT !== "0";
const limit = envInt("ENGRAM_REVIEW_LIMIT", 20);
let cooldownMs = envInt("ENGRAM_REVIEW_COOLDOWN_SECONDS", 600) * 1000;

const baseUrl = (): string =>
  process.env.ENGRAM_URL ?? `http://127.0.0.1:${process.env.ENGRAM_PORT ?? "7437"}`;

let armed = false;
let lastDigestAt = 0;
let lastCount = 0;

function field(item: DueItem, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

/** Compact, model-readable digest of the due-review queue. */
export function buildDigest(count: number, items: DueItem[]): string {
  const lines = items.slice(0, 10).map((item, index) => {
    const id = field(item, ["id", "observation_id"]) ?? "?";
    const project = field(item, ["project"]) ?? "?";
    const title = field(item, ["title", "type", "kind"]) ?? "observation";
    const fact = (field(item, ["fact", "text", "content", "summary"]) ?? "").replace(/\s+/g, " ").slice(0, 140);
    const reason = field(item, ["review_reason", "reason"]);
    const reviewAt = field(item, ["review_after", "next_review"]);
    const suffix = [reason ? `stale because: ${reason}` : null, reviewAt ? `due ${reviewAt}` : null]
      .filter(Boolean)
      .join("; ");
    return `${index + 1}. #${id} [${project}] ${title}${fact ? ` — ${fact}` : ""}${suffix ? ` (${suffix})` : ""}`;
  });

  return [
    `Memory review due: ${count} Engram observation${count === 1 ? "" : "s"} flagged by the refresh policy (triggered by context compaction).`,
    "",
    ...lines,
    ...(count > lines.length ? [`… ${count - lines.length} more — /review-memory or mem_review {action:"list"}`] : []),
    "",
    "Triage now, in this run:",
    '1. mem_review {action:"list", project:"<project>"} for the full queue.',
    "2. For each id: check the claim against current code/config (read the file or run the command).",
    '3. Record the verdict: mem_review {action:"mark_reviewed", observation_id:<id>} if still true; mem_update if drifted; mem_delete if wrong. Do not save a duplicate of an existing fact.',
    "4. Report one line per id (kept / updated / deleted and why).",
  ].join("\n");
}

async function fetchDue(): Promise<{ count: number; items: DueItem[] } | null> {
  try {
    const response = await fetch(`${baseUrl()}/review?all_projects=true&limit=${limit}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { count?: unknown; observations?: unknown };
    const items = Array.isArray(data?.observations) ? (data.observations as DueItem[]) : [];
    const count = typeof data?.count === "number" ? data.count : items.length;
    return { count, items };
  } catch {
    return null; // store down / not running — stay silent
  }
}

async function runReview(pi: ExtensionAPI, ctx: ExtensionContext, trigger: string): Promise<void> {
  const due = await fetchDue();
  if (!due || due.count === 0) {
    lastCount = due?.count ?? 0;
    if (trigger === "manual" && ctx.hasUI) {
      ctx.ui.notify(due ? "engram-review: queue empty" : "engram-review: store unreachable", "info");
    }
    return;
  }

  lastCount = due.count;
  lastDigestAt = Date.now();
  armed = false;
  if (ctx.hasUI) {
    ctx.ui.notify(`engram-review: ${due.count} observation${due.count === 1 ? "" : "s"} due — starting triage`, "info");
  }
  pi.sendUserMessage(buildDigest(due.count, due.items));
}

export default function (pi: ExtensionAPI) {
  pi.on("session_compact", () => {
    if (!enabled) return;
    if (Date.now() - lastDigestAt < cooldownMs) return;
    armed = true;
  });

  // Idle boundary: safe to start a new run with the review work item.
  pi.on("agent_settled", (_event, ctx) => {
    if (!enabled || !armed) return;
    void runReview(pi, ctx, "auto");
  });

  pi.registerCommand("review-memory", {
    description: "Fetch Engram's due-memory review queue and triage it now",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on" || arg === "off") {
        enabled = arg === "on";
        if (ctx.hasUI) ctx.ui.notify(`engram-review: auto-review on compaction ${enabled ? "enabled" : "disabled"}`, "info");
        return;
      }
      if (arg === "status") {
        const due = await fetchDue();
        if (ctx.hasUI) {
          ctx.ui.notify(
            `engram-review: ${enabled ? "on" : "off"} — ${due ? `${due.count} due` : "store unreachable"}; last digest ${lastCount} item(s)${armed ? "; armed after compaction" : ""}`,
            "info",
          );
        }
        return;
      }
      await runReview(pi, ctx, "manual");
    },
  });
}
