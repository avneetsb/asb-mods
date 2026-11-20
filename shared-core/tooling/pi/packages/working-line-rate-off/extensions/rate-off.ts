/**
 * working-line-rate-off — extensions/rate-off.ts
 *
 * Purpose: take the tokens/sec meter out of pi's live working line without losing
 * anything else on it. The line pi-one-ui renders is composed like
 *   `Blanching… · 18m06s · thinking 8m18s · ↑314k ↓26k ⚡31.6 tok/s`
 * and the operator wants exactly ` ⚡31.6 tok/s` gone.
 *
 * Why a wrapper instead of config (verified by raw reads of pi-one-ui 0.9.2):
 *   - The rate is appended in extensions/layouts/working-line/working-line.ts:526-530
 *     (` ⚡${formatCount(rate)} tok/s`, emitted only while outputTokensPerSecond > 0).
 *   - The config schema extensions/app/config/working-line.ts exposes exactly
 *     {tool, elapsed, thought, tokens} — `tokens: false` would also delete the
 *     ↑input ↓output counters, which must stay. No rate-level key exists anywhere,
 *     and the settings overlay only offers enabled + spinner.
 *   - The composed row reaches pi core as spinner frames through
 *     ui.setWorkingIndicator({frames}) (working-line.ts:1343/1447), and pi-one-ui
 *     re-reads `ctx.ui` on every call (working-line.ts:992), so replacing the method
 *     on the shared facade intercepts it. pi hands ONE uiContext object to all
 *     extensions (interactive-mode.js:1585 → runner.setUIContext → runner.uiContext),
 *     so patching it once covers every extension.
 *
 * Escape handling: frames are ANSI-styled per grapheme cell, so the meter text is
 * almost never contiguous in the raw string. Stripping therefore works on the
 * VISIBLE text — escape runs are tokenised out, the meter span is matched there,
 * and the deletion removes the covered cells plus only the escape runs strictly
 * between them. Surrounding colours and the trailing reset stay untouched.
 *
 * Known cosmetic cost (accepted, measured in pi-one-ui source): the classic/kitt
 * highlight travels over graphemeCells(composed.row) (working-line.ts:791, tiers at
 * L215-240), whose period is computed for the pre-strip row. After the strip the
 * travelling band can reach past the shortened end for part of its cycle. Nothing
 * breaks; the animation just spans slightly more time than visible text.
 *
 * Failure posture: if `ctx.ui` is missing or shaped differently than expected, this
 * installs nothing and says so. It never blocks a session, never touches a file, and
 * leaves any string that does not carry the ⚡ meter byte-identical (same object
 * reference even, so pi's own change detection is unaffected).
 *
 * Env: WORKING_LINE_RATE_OFF=0 disables the extension entirely.
 */

const DISABLED = process.env.WORKING_LINE_RATE_OFF === "0";

/** Marks an already-wrapped facade so re-installs never nest wrappers. */
const PATCHED = Symbol.for("asb.working-line-rate-off.patched");

/**
 * The meter as pi-one-ui composes it: ` ⚡31.6 tok/s`, optionally `⚡ ~820 tok/s`
 * (its prefill/sidebar variant), with k-scaled counts from formatCount(). Requires
 * the ⚡ glyph on purpose: a bare "<n> tok/s" elsewhere on screen is left alone.
 */
const RATE_METER = /[ \t ]*⚡[ \t ️]*[~≈]?[ \t]*\d[\d.,]*[ \t]*k?[ \t]*tok\/s/g;

type IndicatorOptions = { frames?: unknown[]; intervalMs?: number } & Record<string, unknown>;

type UiFacade = {
  setWorkingIndicator?: (options?: IndicatorOptions) => void;
  setWorkingMessage?: (message?: string) => void;
};

type Token = { esc: boolean; text: string };

/** Split a styled string into SGR/CSI escape runs and everything else. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let plainStart = 0;
  let i = 0;
  while (i < text.length) {
    if (text.charCodeAt(i) === 0x1b && (text[i + 1] === "[" || text[i + 1] === "]")) {
      if (plainStart < i) tokens.push({ esc: false, text: text.slice(plainStart, i) });
      let j = i + 2;
      // OSC … BEL / ESC \ ; CSI … final byte in @-~
      if (text[i + 1] === "]") {
        while (j < text.length && text.charCodeAt(j) !== 0x07 && text.charCodeAt(j) !== 0x1b) j += 1;
        if (j < text.length && text.charCodeAt(j) === 0x07) j += 1;
      } else {
        while (j < text.length && !/[@-~]/.test(text[j]!)) j += 1;
        j = Math.min(j + 1, text.length);
      }
      tokens.push({ esc: true, text: text.slice(i, j) });
      i = j;
      plainStart = j;
      continue;
    }
    i += 1;
  }
  if (plainStart < text.length) tokens.push({ esc: false, text: text.slice(plainStart) });
  return tokens;
}

/** Token index ranges covering each ⚡ meter occurrence in the visible text. */
function meterRanges(visible: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  RATE_METER.lastIndex = 0;
  for (const match of visible.matchAll(RATE_METER)) {
    const start = match.index ?? -1;
    const length = match[0].length;
    if (start < 0 || length === 0) continue;
    ranges.push({ start, end: start + length });
  }
  return ranges;
}

/** Remove every ⚡ meter from a possibly ANSI-styled single-line string. */
export function stripRateMeter(text: string): string {
  if (!text.includes("⚡")) return text;

  // Per-code-point items plus escape runs, so a meter can be cut out of the middle of
  // a styled run (pi-one-ui colours the row cell by cell) without losing surroundings.
  const items: Token[] = [];
  for (const token of tokenize(text)) {
    if (token.esc) items.push({ esc: true, text: token.text });
    else for (const char of token.text) items.push({ esc: false, text: char });
  }

  const itemIndex: number[] = [];
  const startsAt: number[] = [];
  const lengths: number[] = [];
  let visible = "";
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    if (item.esc) continue;
    itemIndex.push(i);
    startsAt.push(visible.length);
    lengths.push(item.text.length);
    visible += item.text;
  }
  const ranges = meterRanges(visible);
  if (ranges.length === 0) return text;

  const drop = new Set<number>();
  for (const { start, end } of ranges) {
    let firstItem = -1;
    let lastItem = -1;
    for (let k = 0; k < itemIndex.length; k += 1) {
      if (startsAt[k]! >= start && startsAt[k]! + lengths[k]! <= end) {
        if (firstItem === -1) firstItem = itemIndex[k]!;
        lastItem = itemIndex[k]!;
      }
    }
    if (firstItem === -1) continue;
    // Escape runs interleaved inside the span go with it. The colour open before the
    // span and the reset after it survive, so SGR pairing stays balanced.
    for (let i = firstItem; i <= lastItem; i += 1) drop.add(i);
  }
  if (drop.size === 0) return text;
  return items
    .filter((_item, index) => !drop.has(index))
    .map((item) => item.text)
    .join("");
}

/** Rewrite indicator frames; returns the original object when nothing matched. */
export function sanitizeIndicatorOptions(options?: IndicatorOptions): IndicatorOptions | undefined {
  const frames = options?.frames;
  if (!Array.isArray(frames)) return options;
  let changed = false;
  const next = frames.map((frame) => {
    if (typeof frame !== "string") return frame;
    const stripped = stripRateMeter(frame);
    if (stripped !== frame) changed = true;
    return stripped;
  });
  return changed ? { ...options, frames: next } : options;
}

/** Wrap ui.setWorkingIndicator + ui.setWorkingMessage once per facade object. */
export function installRateOffGuard(ui: UiFacade | undefined | null): {
  installed: boolean;
  reason: string;
} {
  if (DISABLED) return { installed: false, reason: "disabled by WORKING_LINE_RATE_OFF=0" };
  if (!ui || typeof ui !== "object") return { installed: false, reason: "no ui facade on ctx" };
  const marked = ui as UiFacade & { [PATCHED]?: boolean };
  if (marked[PATCHED]) return { installed: true, reason: "already installed" };

  const hasIndicator = typeof ui.setWorkingIndicator === "function";
  const hasMessage = typeof ui.setWorkingMessage === "function";
  if (!hasIndicator && !hasMessage) {
    return { installed: false, reason: "ui facade exposes no working-line setters" };
  }

  if (hasIndicator) {
    const original = ui.setWorkingIndicator!;
    ui.setWorkingIndicator = (options?: IndicatorOptions) => original.call(ui, sanitizeIndicatorOptions(options));
  }
  if (hasMessage) {
    const original = ui.setWorkingMessage!;
    ui.setWorkingMessage = (message?: string) =>
      original.call(ui, typeof message === "string" ? stripRateMeter(message) : message);
  }
  marked[PATCHED] = true;
  return { installed: true, reason: "working-line meters will be stripped" };
}

type MinimalExtensionAPI = {
  on(event: string, handler: (event: unknown, ctx: unknown) => void): () => void;
};

export default function workingLineRateOff(pi: MinimalExtensionAPI): void {
  if (DISABLED) return;
  const hook = (_event: unknown, ctx: unknown) => {
    installRateOffGuard((ctx as { ui?: UiFacade } | undefined)?.ui);
  };
  // session_start covers a fresh (re)bind; agent_start re-checks cheaply in case pi
  // swaps the shared uiContext mid-session. Both are idempotent via the PATCHED mark.
  pi.on("session_start", hook);
  pi.on("agent_start", hook);
}
