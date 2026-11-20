/**
 * beads-box-widget.ts — own the "beads-wip" above-editor slot and render it
 * as a bordered box (pi-goal-x house style) instead of pi-beads' plain lines.
 *
 * Why this exists: @abix5/pi-beads draws its in-progress panel with unframed
 * rows and offers no config knob to disable or restyle the widget. Policy says
 * upstream npm packages stay untouched, so this user-owned extension replaces
 * the panel at the pi widget-API boundary instead of patching upstream code.
 *
 * Mechanism (verified 2026 against pi 1.4.0 dist/core/extensions/runner.js +
 * dist/modes/interactive/interactive-mode.js):
 *   - Widgets live in ONE global map keyed by the widget key (last writer
 *     wins); `setWidget(key, undefined)` clears. pi dispatches events by
 *     awaiting handlers sequentially in extension load order, and this
 *     package is installed AFTER npm:@abix5/pi-beads — so our handlers observe
 *     every beads re-render and take the slot back.
 *   - Upstream re-renders on: session_start (after 2 `bd` subprocesses),
 *     agent_start (synchronously), and inside its write tools (sync render +
 *     a delayed one after `bd ready`). We re-register after each, with a small
 *     settle margin for that last delayed one.
 *
 * Data comes from the public `bd` CLI, same commands upstream uses:
 *   bd where | bd repo list        → umbrella + member repos
 *   bd list --status in_progress --json -n 50 (per repo dir) → active rows
 *   bd ready --json                → ready count
 * Closed-this-session rows are ours: at each beads tool end we diff the
 * in-progress set; ids that disappeared show struck-through for one turn
 * (same UX as upstream, tracked independently).
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

// @ts-ignore — plain-JS sibling, resolved by jiti at runtime
import { widgetLines, formatAge } from "./widget-lines.mjs";

const pexec = promisify(execFile);

type PiExt = {
  on(
    event: "session_start",
    handler: (event?: unknown, ctx?: StartCtx) => void | Promise<void>,
  ): void;
  on(
    event: "tool_execution_end",
    handler: (event?: ToolEndEvent) => void | Promise<void>,
  ): void;
  on(
    event: "agent_start" | "session_compact",
    handler: () => void | Promise<void>,
  ): void;
};
type BoxTheme = Record<string, unknown>;
type UiLike = {
  setWidget?: (key: string, widget?: unknown, opts?: { placement?: string }) => void;
  theme?: BoxTheme;
};
type BdIssue = { id?: string; title?: string; priority?: number; started_at?: string };
type ToolEndEvent = { toolName?: string; name?: string };
type StartCtx = { ui?: UiLike; cwd?: string };
// margins for upstream's fire-and-forget re-renders (see header comment)
const SESSION_MARGIN_MS = 600;
const TOOL_MARGIN_MS = 450;

type WipRow = {
  id: string;
  repo: string;
  title: string;
  priority?: number;
  startedAt?: string;
};

export default function activate(pi: PiExt) {
  let uiRef: UiLike | null = null; // ctx.ui captured at session_start (absent in subagents)
  let beadsOk = false;
  let umbrella = "";
  const prefixToDir = new Map<string, string>();
  const repoDirs: string[] = []; // dirs to query for in-progress issues
  let readyCount: number | null = null;
  let closedCount = 0; // issues this session saw close (persistent counter)
  const prevActive = new Map<string, WipRow>(); // last fetch, for close diffing
  const closedShown = new Map<string, WipRow>(); // struck rows for one turn
  let timer: NodeJS.Timeout | null = null;

  const activeNow = new Map<string, WipRow>();

  // ---- bd plumbing ---------------------------------------------------------

  async function bd(
    args: string[],
    cwd: string,
    timeout = 15000,
  ): Promise<{ ok: boolean; out: string }> {
    try {
      const { stdout } = await pexec("bd", args, {
        cwd: cwd || process.cwd(),
        maxBuffer: 8 * 1024 * 1024,
        timeout,
      });
      return { ok: true, out: stdout ?? "" };
    } catch (e) {
      const err = e as { stdout?: unknown };
      return { ok: false, out: typeof err.stdout === "string" ? err.stdout : "" };
    }
  }

  function jparse(s: string): unknown {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  async function beadsDirOf(dir: string): Promise<string> {
    const r = await bd(["where"], dir);
    if (!r.ok) return "";
    const l = (r.out.split("\n")[0] ?? "").trim();
    return l.includes(".beads") ? l : "";
  }

  async function additionalRepos(root: string): Promise<string[]> {
    const r = await bd(["repo", "list"], root);
    if (!r.ok) return [];
    const dirs: string[] = [];
    for (const ln of r.out.split("\n")) {
      const m = ln.match(/^\s*-\s+(\/.+?)\s*$/);
      if (m) dirs.push(m[1]);
    }
    return dirs;
  }

  async function nativePrefixOf(dir: string): Promise<string> {
    const r = await bd(["where"], dir);
    const m = r.out.match(/^\s*prefix:\s*(\S+)/m);
    return m ? m[1] : "";
  }

  async function samplePrefixOf(repoDir: string): Promise<string> {
    const r = await bd(["list", "--all", "-n", "1", "--json"], repoDir);
    if (r.ok) {
      const a = jparse(r.out) as BdIssue | BdIssue[] | null;
      const id = Array.isArray(a) ? a[0]?.id : a?.id;
      if (id) return String(id).split("-")[0];
    }
    return "";
  }

  async function resolveTopology(cwd: string): Promise<void> {
    beadsOk = false;
    umbrella = "";
    prefixToDir.clear();
    repoDirs.length = 0;

    // 1) locate umbrella root (same contract as upstream: PI_BEADS_ROOT or a
    //    .beads whose `bd repo list` names additional repos)
    let root = (process.env.PI_BEADS_ROOT || "").trim();
    if (root)
      root = path.resolve(root.replace(/^~(?=$|\/)/, process.env.HOME || "~"));
    if (!root) {
      let d = cwd;
      for (let i = 0; i < 12 && d; i++) {
        const bdir = await beadsDirOf(d);
        if (!bdir) break;
        const cand = path.dirname(bdir);
        if ((await additionalRepos(cand)).length > 0) {
          root = cand;
          break;
        }
        const parent = path.dirname(cand);
        if (parent === cand) break;
        d = parent;
      }
    }

    // 2) find at least one beads repo (single-repo fallback)
    let single = "";
    if (!root) {
      let d = cwd;
      for (let i = 0; i < 12 && d; i++) {
        const bdir = await beadsDirOf(d);
        if (!bdir) break;
        single = path.dirname(bdir);
        break;
      }
    }

    umbrella = root || single || "";
    if (!umbrella) return;
    beadsOk = (await bd(["info"], umbrella)).ok;
    if (!beadsOk) return;

    if (root) {
      const np = await nativePrefixOf(umbrella);
      if (np) prefixToDir.set(np, umbrella);
      for (const dir of await additionalRepos(umbrella)) {
        const pfx = await samplePrefixOf(dir);
        if (pfx) prefixToDir.set(pfx, dir);
        repoDirs.push(dir);
      }
    } else {
      const pfx = await samplePrefixOf(umbrella);
      if (pfx) prefixToDir.set(pfx, umbrella);
    }
    repoDirs.push(umbrella);
  }

  function repoTag(id: string): string {
    const pfx = String(id).split("-")[0];
    const dir = prefixToDir.get(pfx);
    return dir ? path.basename(dir) : "";
  }

  // ---- data refresh ---------------------------------------------------------

  async function refresh(): Promise<void> {
    if (!beadsOk || !uiRef?.setWidget) return;
    const next = new Map<string, WipRow>();
    for (const dir of repoDirs) {
      const r = await bd(
        ["list", "--status", "in_progress", "--json", "-n", "50"],
        dir,
      );
      if (!r.ok) continue;
      const arr = jparse(r.out);
      if (!Array.isArray(arr)) continue;
      for (const i of arr) {
        if (!i?.id || next.has(String(i.id))) continue;
        next.set(String(i.id), {
          id: String(i.id),
          repo: repoTag(String(i.id)),
          title: String(i.title ?? ""),
          priority: Number.isFinite(i.priority) ? Number(i.priority) : undefined,
          startedAt: i.started_at ? String(i.started_at) : undefined,
        });
      }
    }
    // ids that vanished since the beads tool we just saw finishing → closed now
    if (prevActive.size > 0) {
      for (const [id, row] of prevActive) {
        if (!next.has(id)) {
          closedShown.set(id, row);
          closedCount += 1;
        }
      }
    }
    // remember a row about to stop being active (e.g. tool closed it) before
    // overwriting the diff baseline
    prevActive.clear();
    for (const [id, row] of next) prevActive.set(id, row);
    activeNow.clear();
    for (const [id, row] of next) activeNow.set(id, row);

    const rr = await bd(["ready", "--json"], umbrella);
    const rarr = rr.ok ? jparse(rr.out) : null;
    readyCount = Array.isArray(rarr) ? rarr.length : null;
  }

  // ---- widget registration --------------------------------------------------

  function buildState() {
    const row = (e: WipRow, closed: boolean) => ({
      id: e.id,
      repo: e.repo,
      title: e.title,
      priority: e.priority,
      age: closed ? "" : formatAge(e.startedAt),
      closed,
    });
    return {
      entries: [
        ...Array.from(activeNow.values()).map((e) => row(e, false)),
        ...Array.from(closedShown.values()).map((e) => row(e, true)),
      ],
      closedCount,
      readyCount,
    };
  }

  function registerWip(): void {
    if (!uiRef?.setWidget) return;
    const state = buildState();
    if (state.entries.length === 0) {
      try {
        uiRef.setWidget("beads-wip", undefined);
      } catch {
        /* not fatal */
      }
      return;
    }
    try {
      uiRef.setWidget(
        "beads-wip",
        (_tui: unknown, theme: BoxTheme) => ({
          // pi hands factory widgets the bare canvas; beads indents its plain
          // panel by one column — keep identical indentation for the box.
          render: (width: number) =>
            widgetLines(state, width - 1, uiRef?.theme ?? theme).map(
              (l: string) => ` ${l}`,
            ),
          invalidate: () => {},
        }),
        { placement: "aboveEditor" },
      );
    } catch {
      /* ui may be unavailable — never fatal */
    }
  }

  /** refresh + take the slot back, after a settle margin for upstream's own
   *  fire-and-forget re-render (whose `bd ready` leg lands late). */
  function reclaim(marginMs: number): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void refresh().then(registerWip, () => {});
    }, marginMs);
  }

  /** Re-register from CACHED state only — no `bd` subprocesses. agent_start
   *  needs just this: upstream re-renders synchronously inside dispatch (so
   *  our handler already runs after it) and no data can have changed.
   *  Upstream polls only at session start + its own writes — spawning bd legs
   *  every turn to repaint identical rows would be pure waste. */
  let regTimer: NodeJS.Timeout | null = null;
  function reclaimCached(marginMs: number): void {
    if (regTimer) clearTimeout(regTimer);
    regTimer = setTimeout(() => {
      regTimer = null;
      registerWip();
    }, marginMs);
  }

  // ---- lifecycle ------------------------------------------------------------

  pi.on("session_start", async (_event: unknown, ctx?: StartCtx) => {
    try {
      uiRef = ctx?.ui ?? null;
      closedCount = 0;
      closedShown.clear();
      prevActive.clear();
      activeNow.clear();
      await resolveTopology(ctx?.cwd ?? process.cwd());
      if (beadsOk) {
        // margin: upstream renders its plain panel after its own bd legs; we
        // arrive later and own the slot.
        reclaim(SESSION_MARGIN_MS);
      } else {
        try {
          uiRef?.setWidget?.("beads-wip", undefined);
        } catch {
          /* not fatal */
        }
      }
    } catch {
      /* never break session start */
    }
  });

  // closed rows live exactly one turn — same UX contract as upstream, then
  // re-register immediately (our handler runs after beads' sync render).
  pi.on("agent_start", async () => {
    try {
      if (closedShown.size > 0) closedShown.clear();
      reclaimCached(150);
    } catch {
      /* not fatal */
    }
  });

  // beads write tools render the plain panel mid-tool (plus a delayed leg);
  // after each beads tool we re-diff and retake the box.
  pi.on("tool_execution_end", async (event?: ToolEndEvent) => {
    try {
      const name = String(event?.toolName ?? event?.name ?? "");
      if (!/^beads/i.test(name)) return;
      reclaim(TOOL_MARGIN_MS);
    } catch {
      /* not fatal */
    }
  });

  // /compact rebuilds the widget area; upstream re-renders too — retake.
  pi.on("session_compact", async () => {
    try {
      reclaim(SESSION_MARGIN_MS);
    } catch {
      /* not fatal */
    }
  });
}
