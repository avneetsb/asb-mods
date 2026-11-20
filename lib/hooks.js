'use strict';
// Phase 6: register per-tool hooks/extensions for pi, Claude Code and Codex.
//
// Fixes two auditor findings:
//   * the retired shell generator had no `pi` case at all, and its branches for the other
//     tools only wrote discovery reports instead of registering anything.
//   * it read schema.events while hooks.json actually exposes schema.hooks, so even the
//     Codex schema-merge loop was dead code.
// All three tools are registered here for real, idempotently, preserving foreign entries.

const fs = require('fs');
const path = require('path');
const P = require('./paths');
const X = require('./fsx');

function loadSchema() {
  const p = path.join(P.CORE, 'hooks', 'hooks.json');
  const raw = X.readJSON(p, null);
  if (!raw) return { defs: {}, source: p, error: 'missing' };
  // Accept either spelling so the generator survives the schema's actual shape.
  const defs = raw.hooks || raw.events || {};
  return { defs, source: p, globs: raw.adapter_globs || {} };
}

// Commands we own are tagged so they can be recognised on later runs and on rollback.
const MARK = '# asb-mods:';

function flatten(defs) {
  const out = [];
  for (const [name, def] of Object.entries(defs)) {
    const event = def.trigger_event || name;
    const events = String(event).split('|').map((s) => s.trim()).filter(Boolean);
    // Commands ship machine-independent tokens ({{STATE_DIR}} etc.); they must be resolved
    // here, otherwise every tool registers a literal placeholder path.
    const command = def.action
      ? X.resolvePlaceholders(def.action, { '{{HOME}}': P.HOME, '{{STATE_DIR}}': P.STATE_DIR, '{{CORE}}': P.CORE })
      : null;
    for (const ev of events) out.push({ name, event: ev, command, def });
  }
  return out;
}

function entryFor(command, name) {
  return { matcher: '', hooks: [{ type: 'command', command: `${command}${command.endsWith('\n') ? '' : '  '}${MARK}${name}` }] };
}

function alreadyPresent(bucket, name) {
  const needle = `${MARK}${name}`;
  return JSON.stringify(bucket || []).includes(needle);
}

function writePreserving(target, mutate, label, log) {
  const current = X.readJSON(target, null);
  const base = current && typeof current === 'object' ? current : {};
  const before = JSON.stringify(base);
  const changed = mutate(base);
  if (!changed && current !== null) {
    if (log) log('ok', `${label}: already up to date (${target})`);
    return { target, changed: false, created: current === null };
  }
  if (current !== null) X.backupString(target, before);
  X.writeJSON(target, base);
  if (log) log('ok', `${label}: registered -> ${target}`);
  return { target, changed: true, created: current === null };
}

// --- Codex: ~/.codex/hooks.json -------------------------------------------------------
function registerCodex(schema, log, dryRun) {
  const target = path.join(P.agents.codex.dir, 'hooks.json');
  const items = flatten(schema.defs).filter((i) => i.command && i.def.tool_adapters && i.def.tool_adapters.codex);
  if (!items.length) return { tool: 'codex', skipped: 'no codex adapters in schema' };
  if (dryRun) return { tool: 'codex', dryRun: true, wouldRegister: items.map((i) => `${i.name}->${i.event}`) };

  const res = writePreserving(target, (doc) => {
    doc.version = doc.version || '1.0.0';
    doc.hooks = doc.hooks && typeof doc.hooks === 'object' ? doc.hooks : {};
    let added = 0;
    for (const it of items) {
      const bucket = doc.hooks[it.event] || [];
      if (alreadyPresent(bucket, it.name)) continue;
      bucket.unshift(entryFor(it.command, it.name));
      doc.hooks[it.event] = bucket;
      added += 1;
    }
    return added > 0;
  }, 'codex hooks', log);
  return { tool: 'codex', ...res, events: [...new Set(items.map((i) => i.event))] };
}

// --- Claude Code: "hooks" map inside ~/.claude/settings.json --------------------------
function registerClaude(schema, log, dryRun) {
  const target = path.join(P.agents.claude.dir, 'settings.json');
  const items = flatten(schema.defs).filter((i) => i.command && i.def.tool_adapters && i.def.tool_adapters.claude);
  if (!items.length) return { tool: 'claude', skipped: 'no claude adapters in schema' };
  if (!X.isDir(P.agents.claude.dir)) return { tool: 'claude', skipped: `${P.agents.claude.dir} absent` };
  if (dryRun) return { tool: 'claude', dryRun: true, wouldRegister: items.map((i) => `${i.name}->${i.event}`) };

  const res = writePreserving(target, (doc) => {
    doc.hooks = doc.hooks && typeof doc.hooks === 'object' ? doc.hooks : {};
    let added = 0;
    for (const it of items) {
      const bucket = doc.hooks[it.event] || [];
      if (alreadyPresent(bucket, it.name)) continue;
      bucket.unshift(entryFor(it.command, it.name));
      doc.hooks[it.event] = bucket;
      added += 1;
    }
    return added > 0;
  }, 'claude hooks', log);
  return { tool: 'claude', ...res, events: [...new Set(items.map((i) => i.event))] };
}

// --- pi: a generated extension (pi has no shell-hook file; extensions ARE its hooks) --
// Event names and the `export default function (pi: ExtensionAPI)` shape are taken from
// the extensions already installed in ~/.pi/agent/extensions on this machine.
function piExtensionSource(items) {
  const rows = items.map((i) => `  { event: ${JSON.stringify(i.event)}, name: ${JSON.stringify(i.name)}, command: ${JSON.stringify(i.command)} },`).join('\n');
  return `// Generated by @asbmods/install — do not edit by hand.
// Registers the asb-mods shared hook definitions with pi. Source of truth:
//   shared-core/hooks/hooks.json  (regenerate with: asbmods hooks)
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";

type SharedHook = { event: string; name: string; command: string };

const HOOKS: SharedHook[] = [
${rows}
];

const fired = new Set<string>();

function run(hook: SharedHook, ctx: ExtensionContext): void {
  const key = hook.name;
  if (fired.has(key)) return;
  fired.add(key);
  execFile("/bin/bash", ["-lc", hook.command], { timeout: 8000 }, (err) => {
    if (err && ctx.hasUI) ctx.ui.notify?.(\`asb-mods hook \${hook.name} failed: \${err.message}\`, "warning");
  });
}

export default function asbModsHooks(pi: ExtensionAPI) {
  for (const hook of HOOKS) {
    if (hook.event !== "session_start") continue;
    pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => run(hook, ctx));
  }
  const turnHooks = HOOKS.filter((h) => h.event !== "session_start");
  if (turnHooks.length) {
    pi.on("turn_end", (_event: unknown, ctx: ExtensionContext) => {
      for (const hook of turnHooks) run(hook, ctx);
    });
  }
}
`;
}

function registerPi(schema, log, dryRun) {
  const items = flatten(schema.defs).filter((i) => i.command);
  if (!items.length) return { tool: 'pi', skipped: 'no executable hooks in schema' };
  const target = path.join(P.agents.pi.agentDir, 'extensions', 'asb-mods-hooks.ts');
  const source = piExtensionSource(items);
  if (dryRun) return { tool: 'pi', dryRun: true, target, hooks: items.map((i) => i.name) };
  // Removal legitimately deletes ~/.pi/agent/extensions (loose extensions are custom
  // tooling), so recreate it whenever pi itself is installed. Gating on the extensions
  // directory made the hook phase skip pi in exactly the run that followed a cutover.
  if (!X.isDir(P.agents.pi.agentDir)) {
    return { tool: 'pi', skipped: `${P.agents.pi.agentDir} absent — pi not installed here` };
  }
  X.mkdirp(path.dirname(target));
  const existed = X.isFile(target);
  const same = existed && X.readFileSyncSafe(target) === source;
  if (same) {
    if (log) log('ok', `pi extension already up to date (${target})`);
    return { tool: 'pi', target, changed: false };
  }
  if (existed) X.backupString(target, X.readFileSyncSafe(target) || '');
  X.writeFile(target, source);
  if (log) log('ok', `pi extension registered (${items.length} hook(s)) -> ${target}`);
  return { tool: 'pi', target, changed: true, created: !existed, hooks: items.map((i) => i.name) };
}

function registerAll(opts, log) {
  const schema = loadSchema();
  if (schema.error) {
    if (log) log('err', `hook schema missing at ${schema.source}`);
    return { error: schema.error, results: [] };
  }
  const dryRun = !!opts.dryRun;
  const results = [
    registerPi(schema, log, dryRun),
    registerClaude(schema, log, dryRun),
    registerCodex(schema, log, dryRun),
  ];
  const record = {
    at: new Date().toISOString(), dryRun,
    schema: schema.source,
    hookCount: Object.keys(schema.defs).length,
    results,
  };
  X.writeJSON(path.join(P.REPORT_DIR, `hooks-${Date.now()}.json`), record);
  void fs;
  return record;
}

module.exports = { registerAll, registerPi, registerClaude, registerCodex, loadSchema, flatten, MARK, piExtensionSource };
