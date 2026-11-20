/**
 * engram-project-pin
 *
 * Purpose: guarantee that every git worktree Engram sees carries a durable,
 * intentional project pin (`<worktreeRoot>/.engram/config.json`).
 *
 * Why: Engram names a repo project from the checkout directory basename.
 * That makes memory buckets unstable — a re-clone into `repo-v2/`, a nested
 * worktree, or a renamed folder silently strands the project's history under a
 * new name. A committed `.engram/config.json` pins it deterministically, and
 * Engram honors it from any nested cwd (`project_source: "config"`).
 *
 * Behavior at `session_start`:
 *   1. Resolve the git worktree root for `ctx.cwd`. Non-git → do nothing.
 *   2. If `.engram/config.json` already exists → leave it untouched (reports
 *      its pinned name; an invalid file is reported, never rewritten).
 *   3. Otherwise derive a name: `$HOME` → `personal-home`, else last segment of
 *      `remote.origin.url` (strips `.git`), else worktree dir basename.
 *   4. Write `{"project_name": "<name>"}` only if the name satisfies Engram's
 *      own rule ("a name, not a path"). A name that would be rejected is
 *      skipped entirely — a bad pin breaks project resolution for the repo, so
 *      this extension fails closed instead.
 *   5. Keep `git status` clean by adding the path to `<gitdir>/info/exclude`
 *      (local-only, never committed). Opt out with ENGRAM_PROJECT_PIN_LOCAL_EXCLUDE=0
 *      if you prefer the pin visible as untracked, or commit it to share it.
 *
 * Safety: creates at most one file per repo, never overwrites, never follows a
 * symlink at the target path, no processes/timers started from the factory.
 *
 * Env:
 *   ENGRAM_PROJECT_PIN=0                 disable the extension entirely
 *   ENGRAM_PROJECT_PIN_LOCAL_EXCLUDE=0 do not touch .git/info/exclude
 *   ENGRAM_PROJECT_PIN_DRY_RUN=1       report, do not write
 *
 * Command: `/engram-pin [name|status|dry]` — status for cwd, or pin with an
 * explicit name override (validated the same way).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONFIG_REL = ".engram/config.json";
// Engram refuses path-like names; keep the same envelope: single segment,
// lowercase, dot/dash/underscore allowed, 1..64 chars.
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

let enabled = process.env.ENGRAM_PROJECT_PIN !== "0";
let localExclude = process.env.ENGRAM_PROJECT_PIN_LOCAL_EXCLUDE !== "0";
let dryRun = process.env.ENGRAM_PROJECT_PIN_DRY_RUN === "1";

/** root -> human-readable outcome, for `/engram-pin status`. */
const outcomes = new Map<string, string>();

function git(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function worktreeRoot(cwd: string): string | null {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return null;
  try {
    return fs.realpathSync(root);
  } catch {
    return root;
  }
}

/** Last meaningful segment of a remote URL or directory path. */
function lastSegment(raw: string): string {
  return raw
    .trim()
    .replace(/[\\/]+$/, "")
    .replace(/\.git$/i, "")
    .split(/[/:\\/]/)
    .filter(Boolean)
    .pop() ?? "";
}

function deriveName(root: string): string | null {
  if (path.resolve(root) === path.resolve(os.homedir())) return "personal-home";
  const remote = git(root, ["config", "--get", "remote.origin.url"]);
  const candidate = lastSegment(remote ?? path.basename(root))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64);
  return NAME_RE.test(candidate) ? candidate : null;
}

function readExisting(target: string): { kind: "file" | "symlink" | "other"; name?: string } | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) return { kind: "symlink" };
  if (!stat.isFile()) return { kind: "other" };
  try {
    const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as { project_name?: unknown };
    const name = typeof parsed?.project_name === "string" ? parsed.project_name : undefined;
    return { kind: "file", name: name && NAME_RE.test(name) ? name : undefined };
  } catch {
    return { kind: "file" };
  }
}

function ensureLocalExclude(root: string): void {
  const gitDir = git(root, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDir) return;
  const exclude = path.join(gitDir, "info", "exclude");
  try {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
    if (current.split(/\r?\n/).some((line) => line.trim() === CONFIG_REL)) return;
    const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(
      exclude,
      `${prefix}# generated by the engram-project-pin Pi extension (local only)\n${CONFIG_REL}\n`,
    );
  } catch {
    /* best effort — a repo without info/exclude still gets its pin */
  }
}

function pinRoot(root: string, override?: string): string {
  const target = path.join(root, CONFIG_REL);
  const existing = readExisting(target);

  if (existing?.kind === "symlink") {
    return `${root}: skipped — ${CONFIG_REL} is a symlink`;
  }
  if (existing?.kind === "other") {
    return `${root}: skipped — ${CONFIG_REL} is not a regular file`;
  }
  if (existing?.kind === "file") {
    return existing.name
      ? `${root}: already pinned to "${existing.name}"`
      : `${root}: ${CONFIG_REL} exists but is invalid — left alone (fix it manually)`;
  }

  const name = override ?? deriveName(root);
  if (!name) {
    return `${root}: skipped — could not derive a valid project name (Engram rejects path-like names)`;
  }
  if (!NAME_RE.test(name)) {
    return `${root}: skipped — "${name}" is not a valid Engram project name`;
  }
  if (!enabled || dryRun) {
    return `${root}: would pin "${name}" (${dryRun ? "dry run" : "disabled"})`;
  }

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    // "wx" = exclusive create; never clobbers a file that raced into existence.
    fs.writeFileSync(target, `${JSON.stringify({ project_name: name }, null, 2)}\n`, {
      mode: 0o644,
      flag: "wx",
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") return `${root}: skipped — created concurrently`;
    return `${root}: write failed — ${code ?? (error as Error)?.message ?? error}`;
  }

  if (localExclude) ensureLocalExclude(root);
  return `${root}: pinned "${name}" → ${CONFIG_REL}${localExclude ? " (git-excluded locally)" : ""}`;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(`engram-pin: ${message}`, level);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!enabled) return;
    const root = worktreeRoot(ctx.cwd);
    if (!root) return; // not a git worktree — Engram's global store handles it
    const outcome = pinRoot(root);
    outcomes.set(root, outcome);
    // Only surface the interesting cases; a repo that is already pinned stays quiet.
    // A repo that is already pinned stays quiet; anything else (created, skipped,
    // invalid, failed) means the pin is not in effect, so it gets surfaced.
    if (!outcome.includes("already pinned")) {
      const warn = /invalid|failed|symlink|not a regular file|could not derive|is not a valid/.test(outcome);
      notify(ctx, outcome.replace(`${root}: `, ""), warn ? "warning" : "info");
    }
  });

  pi.registerCommand("engram-pin", {
    description: "Show or set the Engram project pin for this repo (.engram/config.json)",
    handler: async (args, ctx) => {
      const arg = args.trim();
      const root = worktreeRoot(ctx.cwd);
      if (!root) {
        notify(ctx, `${ctx.cwd} is not inside a git worktree — nothing to pin`, "warning");
        return;
      }

      if (arg === "dry") {
        dryRun = true;
        notify(ctx, `dry run — ${pinRoot(root).replace(`${root}: `, "")}`, "info");
        dryRun = false;
        return;
      }
      if (arg === "status" || arg === "") {
        const lines = [
          `root: ${root}`,
          `enabled: ${enabled ? "yes" : "no"}  dry-run: ${dryRun ? "yes" : "no"}  local-exclude: ${localExclude ? "yes" : "no"}`,
          `current: ${pinRoot(root).replace(`${root}: `, "")}`,
        ];
        const others = [...outcomes.entries()].filter(([r]) => r !== root);
        if (others.length > 0) {
          lines.push("this session:");
          for (const [, o] of others) lines.push(`  ${o}`);
        }
        notify(ctx, lines.join("\n"), "info");
        return;
      }
      if (arg === "on" || arg === "off") {
        enabled = arg === "on";
        notify(ctx, `auto-pinning ${enabled ? "enabled" : "disabled"} for this session`, "info");
        return;
      }

      const name = lastSegment(arg).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
      if (!NAME_RE.test(name)) {
        notify(ctx, `"${arg}" is not a valid Engram project name (single segment, lowercase, 1-64 chars)`, "error");
        return;
      }
      const outcome = pinRoot(root, name);
      outcomes.set(root, outcome);
      notify(ctx, outcome.replace(`${root}: `, ""), outcome.includes("failed") ? "error" : "info");
    },
  });
}
