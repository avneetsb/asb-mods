'use strict';
// Phase 4b: npm global inventory from shared-core/npm/manifest.json.
//
// Fixes the auditor finding "multiple packages reference an internal registry; the
// installer's npm phase would silently fail": every manifest entry is probed against the
// configured registry first, and anything unresolvable is reported as `unavailable`
// rather than swallowed.

const path = require('path');
const { execFileSync } = require('child_process');
const P = require('./paths');
const X = require('./fsx');

function manifest() {
  const p = path.join(P.CORE, 'npm', 'manifest.json');
  const raw = X.readJSON(p, null);
  if (!raw) return { error: `manifest missing at ${p}`, packages: [] };
  return { packages: raw.packages || [], source: p, npmrc: path.join(P.CORE, 'npm', '.npmrc') };
}

function installedGlobals() {
  try {
    const out = execFileSync('npm', ['ls', '-g', '--depth=0', '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
    const parsed = JSON.parse(out || '{}');
    return new Set(Object.keys(parsed.dependencies || {}));
  } catch { return new Set(); }
}

// `npm view <name> version` proves the registry can resolve the name. Scoped names that
// live on a private registry fail here and are surfaced, not skipped silently.
function resolvable(name, timeoutSec) {
  try {
    execFileSync('npm', ['view', name, 'version'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: (timeoutSec || 20) * 1000 });
    return { ok: true };
  } catch (err) {
    const msg = ((err && err.stderr) || (err && err.message) || '').toString().split('\n')[0];
    return { ok: false, reason: msg.slice(0, 160) || 'unresolved' };
  }
}

function assess(opts = {}, log) {
  const m = manifest();
  if (m.error) { if (log) log('err', m.error); return m; }
  const have = installedGlobals();
  const probe = opts.probe !== false;

  const rows = [];
  for (const pkg of m.packages) {
    const installed = have.has(pkg.name);
    let availability = { status: 'not-checked' };
    if (!installed && probe) {
      const r = resolvable(pkg.name, opts.timeoutSec);
      availability = r.ok ? { status: 'available' } : { status: 'unavailable', reason: r.reason };
    }
    rows.push({
      name: pkg.name,
      purpose: pkg.purpose || '',
      installed,
      availability: availability.status,
      reason: availability.reason || null,
      action: installed ? 'already-installed'
        : availability.status === 'unavailable' ? 'skipped-unavailable'
          : (opts.install ? 'install' : 'report-only'),
    });
  }

  const summary = {
    total: rows.length,
    installed: rows.filter((r) => r.installed).length,
    available: rows.filter((r) => r.availability === 'available').length,
    unavailable: rows.filter((r) => r.availability === 'unavailable').length,
  };
  if (log) {
    log('ok', `npm globals: ${summary.installed}/${summary.total} installed, ${summary.available} installable, ${summary.unavailable} unreachable on this registry`);
    for (const r of rows.filter((x) => x.availability === 'unavailable')) {
      log('warn', `${r.name}: ${r.reason}`);
    }
  }

  const results = { installed: [], failed: [] };
  if (opts.install && !opts.dryRun) {
    for (const r of rows.filter((x) => x.action === 'install')) {
      try {
        execFileSync('npm', ['i', '-g', r.name], { stdio: 'pipe', encoding: 'utf8', timeout: 600000 });
        results.installed.push(r.name);
        if (log) log('ok', `installed ${r.name}`);
      } catch (err) {
        const msg = ((err && err.stderr) || err.message || '').toString().split('\n')[0].slice(0, 160);
        results.failed.push({ name: r.name, error: msg });
        if (log) log('warn', `install ${r.name} failed: ${msg}`);
      }
    }
  } else if (opts.install && opts.dryRun) {
    if (log) log('info', `dry-run: would install ${rows.filter((x) => x.action === 'install').length} package(s)`);
  }

  const record = { at: new Date().toISOString(), summary, rows, results };
  X.writeJSON(path.join(P.REPORT_DIR, `npm-${Date.now()}.json`), record);
  return { ...record, results };
}

module.exports = { assess, manifest, installedGlobals, resolvable };
