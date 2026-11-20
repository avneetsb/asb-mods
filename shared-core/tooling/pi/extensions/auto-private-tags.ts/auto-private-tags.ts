/**
 * auto-private-tags
 *
 * Purpose: stop secrets from leaving the machine into memory stores, with zero
 * user intervention, while keeping automatic memory capture fully on.
 *
 * How it works: Engram strips `<private>…</private>` spans client-side
 * (`private-redaction.js` → `[REDACTED]`) before any HTTP request, and Pi's
 * `input` event runs in the input-preparation phase — before the memory
 * extensions' `before_agent_start` capture. So this handler wraps anything that
 * looks like a credential in `<private>` tags and returns the rewritten text.
 * Engram (and observational memory) then capture the masked version; the model
 * sees the masked version too, which is the point.
 *
 * This is deliberately a coarse pattern list, not a secret scanner: it targets
 * high-signal credential shapes (API keys, provider tokens, JWTs, private keys,
 * URL credentials, `key: value` assignments, Authorization headers). Spans that
 * are already inside `<private>` are left alone.
 *
 * Trade-off you accepted by choosing autonomy: a false positive masks text the
 * model would have needed (e.g. `token: someNonSecretValue`). Escape hatches:
 *   AUTO_PRIVATE_TAGS=0            disable at startup
 *   /auto-private-tags off|on     toggle for this session
 *   /auto-private-tags            show what has been masked so far
 * Every rewrite notifies with the matched labels so masking is never silent.
 *
 * Env:
 *   AUTO_PRIVATE_TAGS=0            disable the extension
 *   AUTO_PRIVATE_TAGS_NOTIFY=0    transform without notifying
 */
import type { ExtensionAPI, ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";

type Span = { start: number; end: number; label: string };

/** Named credential patterns; label is what the notification reports. */
const PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "private key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { label: "sk key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { label: "stripe key", re: /\b[sp]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { label: "github token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { label: "github token", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { label: "slack token", re: /\bxox[baprse]-[A-Za-z0-9-]{10,}\b/g },
  { label: "google api key", re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { label: "aws key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "npm token", re: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  { label: "huggingface token", re: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { label: "jwt", re: /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { label: "auth header", re: /\bAuthorization\s*:\s*(?:Bearer|Basic|Token)\s+\S+/gi },
  { label: "url credentials", re: /\/\/[^:/@\s]{2,}:[^@\s]{2,}@/g },
  {
    label: "secret assignment",
    re: /(?<=\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd|pwd)\b\s*[:=]\s*)["']?[^\s"',;)}]{6,}["']?/gi,
  },
];

const TAG = /<private>[\s\S]*?<\/private>/gi;

let enabled = process.env.AUTO_PRIVATE_TAGS !== "0";
const notifyOn = process.env.AUTO_PRIVATE_TAGS_NOTIFY !== "0";

/** Spans already protected by explicit `<private>` tags. */
function taggedSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG.exec(text)) !== null) spans.push([match.index, match.index + match[0].length]);
  return spans;
}

/** Credential matches, deduplicated and merged, excluding already-tagged regions. */
function findSecrets(text: string): Span[] {
  const protectedSpans = taggedSpans(text);
  const raw: Span[] = [];
  for (const { label, re } of PATTERNS) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      if (match[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      raw.push({ start: match.index, end: match.index + match[0].length, label });
    }
  }
  raw.sort((a, b) => a.start - b.start || b.end - a.end);

  const merged: Span[] = [];
  for (const span of raw) {
    if (protectedSpans.some(([from, to]) => span.start < to && span.end > from)) continue;
    const last = merged.at(-1);
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      if (!last.label.includes(span.label)) last.label += `, ${span.label}`;
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

function redact(text: string): { text: string; labels: string[] } {
  const spans = findSecrets(text);
  if (spans.length === 0) return { text, labels: [] };
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start);
    out += `<private>${text.slice(span.start, span.end)}</private>`;
    cursor = span.end;
  }
  out += text.slice(cursor);
  return { text: out, labels: spans.map((span) => span.label) };
}

/** Exported so the pattern list can be exercised without a Pi runtime. */
export { redact };

export default function (pi: ExtensionAPI) {
  let maskedTotal = 0;
  let maskedRuns = 0;

  pi.on("input", (event: InputEvent, ctx: ExtensionContext): InputEventResult | undefined => {
    if (!enabled || event.text.length === 0) return undefined;
    const { text, labels } = redact(event.text);
    if (labels.length === 0) return undefined;

    maskedTotal += labels.length;
    maskedRuns += 1;
    if (notifyOn && ctx.hasUI) {
      ctx.ui.notify(
        `auto-private: masked ${labels.length} credential-like span${labels.length === 1 ? "" : "s"} (${[...new Set(labels)].join(", ")}) before memory capture`,
        "info",
      );
    }
    return { action: "transform", text, images: event.images };
  });

  pi.registerCommand("auto-private-tags", {
    description: "Show, enable, or disable automatic <private> masking of credentials before memory capture",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on" || arg === "off") {
        enabled = arg === "on";
        if (ctx.hasUI) ctx.ui.notify(`auto-private: ${enabled ? "masking enabled" : "masking disabled"}`, "info");
        return;
      }
      if (ctx.hasUI) {
        ctx.ui.notify(
          `auto-private: ${enabled ? "on" : "off"} — ${maskedTotal} span${maskedTotal === 1 ? "" : "s"} masked across ${maskedRuns} prompt${maskedRuns === 1 ? "" : "s"} this session (${PATTERNS.length} patterns)`,
          "info",
        );
      }
    },
  });

}
