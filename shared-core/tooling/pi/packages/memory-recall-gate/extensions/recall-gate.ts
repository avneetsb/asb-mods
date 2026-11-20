/**
 * memory-recall-gate — extensions/recall-gate.ts
 *
 * Purpose: make stored memory get READ, not just written. At the first turn of a
 * session it seeds two things into the system prompt as one stable section:
 *   1. a live digest pulled from engram (its own HTTP `/context` route) and from
 *      mnemosyne's canonical slots (read straight from the store the MCP server
 *      actually opens, ~/.hermes/mnemosyne), and
 *   2. a hard recall gate: the agent must call mem_context / mem_search and
 *      mnemosyne_recall_canonical / mnemosyne_recall before the first substantive
 *      decision, and must re-read before citing any exact id, count, path or hash.
 *
 * Why: the memory stack captured 656 engram observations across 767 sessions while
 * performing almost no recall, so the CACHE → MEMORY rail showed nothing and prior
 * decisions were re-derived from scratch every session. An extension that only
 * injects text would fix the first half and still leave the rail at zero, because
 * the rail counts recall *tool calls*; gating the model on real tool calls fixes
 * both at once.
 *
 * Failure posture: every read is best-effort with a short timeout. An offline
 * engram server or unreadable mnemosyne db degrades the digest to the lines that
 * did resolve; the gate directive is always injected. Nothing here can block a
 * session.
 *
 * Env:
 *   MEMORY_RECALL_GATE=0                      disable the extension entirely
 *   MEMORY_RECALL_GATE_ENGRAM_URL=<url>       default http://127.0.0.1:7437
 *   MEMORY_RECALL_GATE_MNEMO_DB=<path>        default ~/.hermes/mnemosyne/data/mnemosyne.db
 *   MEMORY_RECALL_GATE_CONTEXT_BYTES=<n>      engram digest budget, default 2200
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DISABLED = process.env.MEMORY_RECALL_GATE === "0";
const ENGRAM_URL = (process.env.MEMORY_RECALL_GATE_ENGRAM_URL ?? "http://127.0.0.1:7437").replace(/\/+$/, "");
const MNEMO_DB =
  process.env.MEMORY_RECALL_GATE_MNEMO_DB ??
  path.join(os.homedir(), ".hermes", "mnemosyne", "data", "mnemosyne.db");
const CONTEXT_BYTES = clampBytes(process.env.MEMORY_RECALL_GATE_CONTEXT_BYTES);
const FETCH_TIMEOUT_MS = 2500;
const CANONICAL_ROWS = 10;
const SECRET_RE = /(api[_-]?key|token|secret|password|bearer)\s*[:=]/i;

const DIRECTIVE = [
  "RECALL GATE — mandatory before the first substantive decision of this session:",
  "1. Call `mem_context` for the current project, then `mem_search` on the task subject. Use",
  "   `mem_get_observation` to read a candidate in full before you assert any exact id, count,",
  "   path, hash or quoted line from memory.",
  "2. Call `mnemosyne_recall_canonical` for identity/voice/preference slots and `mnemosyne_recall`",
  "   for the task subject. An empty result from one mnemosyne store says nothing about the other.",
  "3. The digest below is orientation, not verified fact. It was fetched at session start and may",
  "   be stale; re-derive from disk or a memory tool before citing anything exact.",
].join("\n");

function clampBytes(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 2200;
  return Math.min(Math.max(parsed, 400), 8000);
}

/** Engram names a project from `<cwd>/.engram/config.json`, else $HOME, else dir name. */
function resolveProject(cwd: string): string {
  const pinned = path.join(cwd, ".engram", "config.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(pinned, "utf8")) as { project_name?: unknown };
    if (typeof parsed?.project_name === "string" && parsed.project_name.trim()) {
      return parsed.project_name.trim();
    }
  } catch {
    /* no pin — fall through to the same defaults engram itself uses */
  }
  if (path.resolve(cwd) === path.resolve(os.homedir())) return "personal-home";
  return path.basename(cwd) || "personal-home";
}

async function fetchEngramDigest(cwd: string): Promise<string | null> {
  const project = resolveProject(cwd);
  const url =
    `${ENGRAM_URL}/context?project=${encodeURIComponent(project)}` +
    `&max_bytes=${CONTEXT_BYTES}&compact=true`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return null;
    const payload = (await response.json()) as { context?: unknown };
    if (typeof payload?.context !== "string") return null;
    const trimmed = payload.context.trim();
    return trimmed ? `### Engram — project \`${project}\` (live at session start)\n${trimmed}` : null;
  } catch {
    return null;
  }
}

/** Canonical slots live in their own store; only `mnemosyne_recall_canonical` reads them. */
async function fetchCanonicalDigest(): Promise<string | null> {
  try {
    const { DatabaseSync } = (await import("node:sqlite")) as {
      DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
        prepare: (sql: string) => { all: () => Array<Record<string, unknown>> };
        close: () => void;
      };
    };
    const db = new DatabaseSync(MNEMO_DB, { readOnly: true });
    try {
      const rows = db
        .prepare("select category, name, body from canonical_facts order by category, name")
        .all();
      const lines: string[] = [];
      for (const row of rows.slice(0, CANONICAL_ROWS)) {
        const body = String(row.body ?? "").trim();
        if (!body || SECRET_RE.test(body)) continue;
        const category = String(row.category ?? "—");
        const name = String(row.name ?? "—");
        lines.push(`- \`${category}/${name}\`: ${body.slice(0, 200)}`);
      }
      if (!lines.length) return null;
      return [
        `### Mnemosyne — canonical slots (${rows.length} in the live store; read them fresh with`,
        "   `mnemosyne_recall_canonical`)",
        ...lines,
      ].join("\n");
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Entries actually injected = digest entry lines, not store totals. Engram's compact `/context`
 * emits `- **project** (timestamp) [N observations]`; the canonical digest emits
 * `- \`category/name\`: …`. Matching the leading bullet covers both — the first version matched
 * only the backtick shape and reported engram 0 against a digest that actually had 35 entries.
 */
function countInjected(digest: string | null): number {
  if (!digest) return 0;
  return digest.split("\n").filter((line) => line.trimStart().startsWith("- ")).length;
}

interface SeedResult {
  seed: string;
  engramRecords: number;
  mnemosyneRecords: number;
}

async function buildSeed(cwd: string): Promise<SeedResult> {
  const [engram, canonical] = await Promise.all([fetchEngramDigest(cwd), fetchCanonicalDigest()]);
  const blocks = ["## Memory recall gate", DIRECTIVE];
  if (engram) blocks.push(engram);
  if (canonical) blocks.push(canonical);
  if (!engram || !canonical) {
    blocks.push(
      "_Digest incomplete this session: " +
        [!engram ? "engram `/context` unavailable" : "", !canonical ? "mnemosyne canonical store unreadable" : ""]
          .filter(Boolean)
          .join("; ") +
        ". The gate still applies — call the recall tools directly.",
    );
  }
  return {
    seed: blocks.join("\n\n"),
    engramRecords: countInjected(engram),
    mnemosyneRecords: countInjected(canonical),
  };
}

export default function (pi: ExtensionAPI) {
  if (DISABLED) return;

  // One seed per session. Stable section content means pi patches the prompt once
  // and then finds no diff on later turns, so this costs a single system message.
  const seeds = new Map<string, SeedResult>();
  const statePath = path.join(os.homedir(), ".pi", "agent", "recall-gate", "state.json");

  pi.on("before_agent_start", async (event, ctx) => {
    const options = (event as { systemPromptOptions?: { sections?: Record<string, string> } })
      ?.systemPromptOptions;
    if (!options) return;

    const key = ctx.sessionManager?.getSessionId?.() ?? "session";
    let result = seeds.get(key);
    if (result === undefined) {
      result = await buildSeed(ctx.cwd);
      if (seeds.size > 8) seeds.delete(seeds.keys().next().value as string);
      seeds.set(key, result);
    }

    // Publish what THIS session was seeded with, so the MEMORY rail can count session-start
    // injection instead of showing a session that read nothing. Best-effort: a write failure
    // must never stop the injection itself, which is the whole point of this extension.
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(
        statePath,
        JSON.stringify(
          {
            sessionId: key,
            startedAt: new Date().toISOString(),
            seedBytes: Buffer.byteLength(result.seed, "utf8"),
            gate: {
              engramRecords: result.engramRecords,
              mnemosyneRecords: result.mnemosyneRecords,
            },
          },
          null,
          2,
        ),
        "utf8",
      );
    } catch {
      /* rail shows 0 injected; injection is unaffected */
    }

    if (options.sections) {
      options.sections.memory_recall_gate = result.seed;
      return;
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${result.seed}` };
  });
}
