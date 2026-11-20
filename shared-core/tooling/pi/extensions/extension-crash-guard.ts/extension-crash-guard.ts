/**
 * extension-crash-guard — keeps pi alive when loaded extensions throw on unwrapped paths.
 *
 * Why this exists: pi wraps extension *event handlers* (core/extensions/runner.js try/catches
 * every awaited handler) and renderer construction (ToolExecutionComponent.updateDisplay), but
 * it does NOT cover TUI dispatch: a component's handleMouse/handleInput/render throwing during
 * stdin/mouse routing reaches uncaughtException, and pi's own handler prints
 * "<app> exiting due to uncaughtException" and calls process.exit(1). pi also registers no
 * unhandledRejection handler at all, so one stray rejected promise kills the process.
 * (Verified against pi 1.4.0: modes/interactive/interactive-mode.js uncaughtCrash →
 * process.exit(1); core/event-bus.js wraps pi.events handlers; pi-tui dist catches nothing in
 * the render/mouse path. atelier-block-frames.ts crashed through exactly this gap with
 * `component.clear is not a function` during mouse dispatch.)
 *
 * What it does:
 * - Takes the seat in front of pi's error dispatch by wrapping process.on/prependListener at
 *   load time and re-wrapping any uncaughtException listener already registered, so the verdict
 *   runs before pi's exit handler regardless of load order.
 * - A crash attributable to extension code (stack frames under ~/.pi/agent/extensions/ or
 *   ~/.pi/agent/npm/node_modules/) is logged to ~/.pi/agent/logs/crash-guard.log and swallowed;
 *   the TUI redraws on the next frame and pi keeps running.
 * - Everything else is passed to pi's original handler untouched, so pi still exits with its
 *   normal crash report for core failures. For unhandledRejection (where pi has no handler)
 *   non-extension rejections reproduce node's default behaviour: print + exit 1.
 * - pi's teardown symmetry is preserved: an orig→wrapped map lets process.off/removeListener
 *   remove the wrapper pi registered through us when pi removes its own listener.
 *
 * Kill switch: PI_CRASH_GUARD=off skips installation entirely.
 * Uninstall: delete this file and restart pi.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), ".pi", "agent", "logs");
const LOG_PATH = join(LOG_DIR, "crash-guard.log");
const MAX_LOG_BYTES = 512 * 1024;

/** Path fragments that mark a stack frame as third-party extension code (posix + win32). */
const EXT_MARKERS = [
  "/.pi/agent/extensions/",
  "/.pi/agent/npm/node_modules/",
  "\\.pi\\agent\\extensions\\",
  "\\.pi\\agent\\npm\\node_modules\\",
];

/** Tag so re-wrapping (e.g. after /reload) never double-wraps our own verdicts. */
const GUARD_TAG = Symbol.for("extension-crash-guard.wrapped");

type Listener = (...args: unknown[]) => unknown;

function extensionOrigin(err: unknown): string | undefined {
  const raw = err as Error | null | undefined;
  const stack = typeof raw?.stack === "string" ? raw.stack : String(err ?? "");
  for (const m of EXT_MARKERS) {
    const i = stack.indexOf(m);
    if (i !== -1) {
      const end = stack.indexOf("\n", i);
      return stack.slice(i, end === -1 ? Math.min(stack.length, i + 160) : end).trim();
    }
  }
  return undefined;
}

function logLine(kind: string, err: unknown, where: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (statSync(LOG_PATH).size > MAX_LOG_BYTES) renameSync(LOG_PATH, `${LOG_PATH}.1`);
    } catch {
      /* no log file yet */
    }
    const e = err as Error | null | undefined;
    appendFileSync(
      LOG_PATH,
      `${new Date().toISOString()} ${kind} (${where})${e?.message ? `: ${e.message}` : ""}${
        e?.stack ? `\n${e.stack}` : ""
      }\n`,
      "utf8",
    );
  } catch {
    /* never throw from the guard */
  }
}

export default function installExtensionCrashGuard(): void {
  if (process.env.PI_CRASH_GUARD === "off") return;

  const GUARDED_EVENTS = new Set<string | symbol>(["uncaughtException", "unhandledRejection"]);

  /** pi's original listener → the verdict wrapper actually registered (so off() finds it). */
  const wrapped = new Map<Listener, Listener>();

  const isWrapped = (fn: unknown): boolean =>
    typeof fn === "function" && (fn as unknown as Record<symbol, unknown>)[GUARD_TAG] === true;

  const makeVerdict = (event: string | symbol, handler: Listener): Listener => {
    const verdict: Listener = (err: unknown, ...rest: unknown[]): unknown => {
      const origin = extensionOrigin(err);
      if (origin !== undefined) {
        logLine(String(event), err, origin);
        return undefined; // extension error: pi survives; the next frame redraws.
      }
      try {
        return handler(err, ...rest); // core error: pi's own report/exit path unchanged.
      } catch (inner) {
        logLine(`${String(event)}(handler-throw)`, inner, "original handler");
        return undefined;
      }
    };
    Object.defineProperty(verdict, GUARD_TAG, { value: true });
    wrapped.set(handler, verdict);
    return verdict;
  };

  const origOn = process.on.bind(process);
  const origPrepend = process.prependListener.bind(process);
  const origOff = process.off.bind(process);

  process.on = ((event: string | symbol, handler: Listener) =>
    (GUARDED_EVENTS.has(event) && !isWrapped(handler)
      ? origOn(event, makeVerdict(event, handler))
      : origOn(event, handler))) as typeof process.on;

  process.prependListener = ((event: string | symbol, handler: Listener) =>
    (GUARDED_EVENTS.has(event) && !isWrapped(handler)
      ? origPrepend(event, makeVerdict(event, handler))
      : origPrepend(event, handler))) as typeof process.prependListener;

  const off = ((event: string | symbol, handler: Listener) =>
    origOff(event, wrapped.get(handler) ?? handler)) as typeof process.off;
  process.off = off;
  process.removeListener = off;

  // Listeners registered BEFORE this extension loaded (pi registers its exit handler in
  // interactive-mode init; ordering vs extension load is not contractual): re-wrap in place.
  for (const event of ["uncaughtException", "unhandledRejection"] as const) {
    for (const h of process.listeners(event) as unknown as Listener[]) {
      if (isWrapped(h)) continue;
      origOff(event, h);
      origOn(event, makeVerdict(event, h));
    }
  }

  // pi registers no unhandledRejection handler, so today every stray rejection exits node.
  // Keep that outcome for pi-core rejections; log-and-survive for extension ones.
  if (process.listeners("unhandledRejection").length === 0) {
    origOn("unhandledRejection", (reason: unknown) => {
      const origin = extensionOrigin(reason);
      if (origin !== undefined) {
        logLine("unhandledRejection", reason, origin);
        return;
      }
      console.error("pi exiting due to unhandledRejection:");
      console.error(reason);
      process.exit(1);
    });
  }
}
