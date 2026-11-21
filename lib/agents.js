'use strict';
// Optional agent CLI installs (--install-agents), driven by shared-core/npm/agents.json.
//
// These CLIs are configured by this package and never shipped by it: nothing here is vendored
// into shared-core/tooling/, nothing is imported at runtime, and the catalogue exists so the
// install route is data rather than a hardcoded guess. Availability is probed first (Homebrew
// metadata for brew routes, `npm view` for npm routes) so a renamed formula or an unreachable
// registry is reported instead of attempted. Every command is announced before it runs, and the
// whole exchange is written to reports/agents-<stamp>.json like the other phases.

const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const P = require('./paths');
const X = require('./fsx');
const prereqs = require('./prereqs');
const ledger = require('./ledger');
const npmpkgs = require('./npmpkgs');

function firstErr(e) {
  return ((e && e.stderr) || (e && e.message) || '').toString().split('\n').map((l) => l.trim()).find(Boolean) || 'unresolved';
}

function brewInfo(kind, pkg) {
  const args = kind === 'brew-cask' ? ['info', '--json=v2', '--cask', pkg] : ['info', '--json=v2', pkg];
  try {
    const data = JSON.parse(execFileSync('brew', args,
      { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }));
    const entry = kind === 'brew-cask' ? (data.casks || [])[0] : (data.formulae || [])[0];
    if (!entry) return { ok: false, reason: 'not in Homebrew metadata' };
    const version = kind === 'brew-cask' ? entry.version : (entry.versions || {}).stable;
    const note = kind === 'brew-formula' && entry.deprecated ? `deprecated (${entry.deprecated})` : null;
    return { ok: true, version, note };
  } catch (e) {
    return { ok: false, reason: firstErr(e).slice(0, 160) };
  }
}

function probeRoute(route, opts = {}) {
  if (route.kind === 'npm-global') {
    if (opts.probe === false) return { ok: true, version: 'not checked', note: 'probe disabled (--probe=false)' };
    const r = npmpkgs.resolvable(route.package);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }
  if (route.kind === 'brew-formula' || route.kind === 'brew-cask') {
    // PATH-only, matching how brew.js invokes it: a Homebrew that exists but was never exported
    // cannot install anything, so reporting it as available would be a promise we cannot keep.
    if (!prereqs.findOnPath('brew')) return { ok: false, reason: 'Homebrew is not on PATH (asbmods doctor explains how to fix it)' };
    return brewInfo(route.kind, route.package);
  }
  return { ok: true, version: 'unprobed', note: 'vendor installer script — no availability probe exists' };
}

function assess(opts = {}, log) {
  const cat = prereqs.agentCatalog();
  if (cat.error) { if (log) log('err', cat.error); return { error: cat.error, rows: [], catalog: cat.file }; }

  const rows = [];
  for (const a of cat.agents) {
    const at = prereqs.findOnPath(a.bin);
    // An installed tool needs no route probe, so an offline machine does not report its own
    // present agents as broken.
    const routes = a.routes.map((r) => Object.assign(
      { kind: r.kind, package: r.package, command: r.command, note: r.note || null },
      at ? { installed: true } : probeRoute(r, opts)));
    rows.push({ tool: a.tool, bin: a.bin, installedAt: at, probeCommand: a.probeCommand, routes });
  }

  const absent = rows.filter((r) => !r.installedAt);
  const summary = {
    tools: rows.length,
    present: rows.length - absent.length,
    absent: absent.length,
    installable: absent.filter((r) => r.routes.some((x) => x.ok)).length,
    unresolvable: absent.filter((r) => !r.routes.some((x) => x.ok)).length,
  };
  if (log) log('ok', `agent CLIs: ${summary.present}/${summary.tools} present, ${summary.installable} installable, ${summary.unresolvable} unresolved`);
  return { rows, summary, catalog: cat.file };
}

function install(opts = {}, log) {
  const a = assess(opts, log);
  if (a.error) return a;

  const installed = [];
  const skipped = [];
  const failed = [];

  for (const row of a.rows) {
    if (row.installedAt) {
      skipped.push({ tool: row.tool, reason: `already installed at ${row.installedAt}` });
      log('ok', `${row.tool}: already present at ${row.installedAt}`);
      continue;
    }
    const route = row.routes.find((r) => r.ok);
    if (!route) {
      const detail = row.routes.map((r) => `${r.kind}:${r.package} — ${r.reason || 'unavailable'}`).join('; ');
      failed.push({ tool: row.tool, reason: 'no install route resolved', routes: detail });
      log('err', `${row.tool}: no install route resolved (${detail})`);
      continue;
    }
    const cmdline = route.command.join(' ');
    if (opts.dryRun) {
      log('info', `${row.tool}: --dry-run, would run  ${cmdline}`);
      skipped.push({ tool: row.tool, reason: 'dry-run', command: cmdline });
      continue;
    }
    log('info', `${row.tool}: installing via ${route.kind} → ${cmdline}`);
    const r = spawnSync(route.command[0], route.command.slice(1), { stdio: 'inherit' });
    const after = prereqs.findOnPath(row.bin);
    if (r.status === 0 && after) {
      installed.push({ tool: row.tool, route: `${route.kind}:${route.package}`, at: after });
      log('ok', `${row.tool}: installed at ${after}`);
      // Recorded with the route's own package name and manager, so `asbmods uninstall` can
      // take the CLI back. It is recorded as an agent CLI and therefore held back by default:
      // removing the tool the user may be running right now is never a side effect of pruning.
      ledger.record([ledger.routeEntry(route, row.tool)]);
    } else if (r.status === 0) {
      failed.push({ tool: row.tool, reason: 'install command exited 0 but the binary is still not on PATH' });
      log('warn', `${row.tool}: command succeeded but ${row.bin} is not on PATH — open a new shell or check the install prefix`);
    } else {
      failed.push({ tool: row.tool, reason: `command exited ${r.status}`, command: cmdline });
      log('err', `${row.tool}: install command exited ${r.status}`);
    }
  }

  const record = { at: new Date().toISOString(), dryRun: !!opts.dryRun, rows: a.rows, installed, skipped, failed };
  X.mkdirp(P.REPORT_DIR);
  const reportPath = path.join(P.REPORT_DIR, `agents-${Date.now()}.json`);
  X.writeJSON(reportPath, record);
  log('ok', `agents report: ${reportPath}`);

  return Object.assign({}, a, { installed, skipped, failed, reportPath });
}

module.exports = { assess, install, probeRoute, brewInfo };
