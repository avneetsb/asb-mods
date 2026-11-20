'use strict';
// Phase 5: Homebrew inventory. Driven entirely by shared-core/brew/formulae.csv so the
// 367-entry inventory is actually consulted — the previous install.sh ignored the CSV and
// validated a hardcoded ~36-name list instead (auditor finding).

const { execFileSync } = require('child_process');
const path = require('path');
const P = require('./paths');
const X = require('./fsx');
const { parseFormulae } = require('./detect');

function haveBrew() {
  try { execFileSync('brew', ['--version'], { stdio: 'pipe' }); return true; }
  catch { return false; }
}

// One subprocess each, rather than one per package: `brew list --versions <pkg>` x367 is
// minutes of process churn.
function installedSets() {
  const read = (args) => {
    try {
      return new Set(execFileSync('brew', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\n').map((l) => l.trim()).filter(Boolean));
    } catch { return new Set(); }
  };
  return { formulae: read(['list', '--formula', '-1']), casks: read(['list', '--cask', '-1']) };
}

// Keep out of the automated install path: these need interactive entitlements.
const INTERACTIVE_CASKS = /^(docker|docker-desktop|virtualbox|vmware|oracle)/i;

function plan(opts = {}) {
  const csv = path.join(P.CORE, 'brew', 'formulae.csv');
  if (!X.isFile(csv)) return { error: `inventory missing at ${csv}` };
  const rows = parseFormulae(csv);
  const wantOnly = opts.scope === 'required' ? new Set(['direct', 'required', 'tooling']) : null;
  const sets = haveBrew() ? installedSets() : { formulae: new Set(), casks: new Set() };

  const present = [];
  const missing = [];
  const deferred = [];
  for (const r of rows) {
    if (wantOnly && !wantOnly.has(r.dependencyType)) continue;
    const bucket = r.type === 'cask' ? sets.casks : sets.formulae;
    const hit = bucket.has(r.name) || bucket.has(r.name.split('@')[0]);
    if (hit) { present.push(r.name); continue; }
    if (r.type === 'cask' && INTERACTIVE_CASKS.test(r.name)) { deferred.push({ name: r.name, reason: 'needs manual entitlement' }); continue; }
    missing.push(r);
  }
  return {
    brewAvailable: haveBrew(),
    total: rows.length,
    considered: present.length + missing.length + deferred.length,
    presentCount: present.length,
    missingCount: missing.length,
    deferredCount: deferred.length,
    missing: missing.map((m) => m.name),
    // install() needs the row, not just the name: a cask installed without `--cask`
    // fails or silently installs a same-named formula.
    missingRows: missing,
    deferred,
    scope: opts.scope || 'all',
  };
}

function install(opts = {}, log) {
  const p = plan(opts);
  if (p.error) { if (log) log('err', p.error); return p; }
  if (!p.brewAvailable) {
    if (log) log('warn', 'Homebrew not on PATH — reporting the gap instead of pretending to install');
    return { ...p, attempted: 0, installed: [], failed: [] };
  }
  if (opts.dryRun) {
    if (log) log('info', `dry-run: would install ${p.missingCount} package(s)`);
    return { ...p, attempted: 0, installed: [], failed: [], dryRun: true };
  }

  const installed = [];
  const failed = [];
  const limit = typeof opts.limit === 'number' ? opts.limit : p.missing.length;
  for (const name of p.missing.slice(0, limit)) {
    const row = (p.missingRows || opts.rows || []).find((r) => r.name === name);
    const isCask = (row ? row.type : '') === 'cask';
    const args = isCask ? ['install', '--cask', name] : ['install', name];
    try {
      execFileSync('brew', args, { stdio: 'pipe', encoding: 'utf8', timeout: (opts.timeoutMs || 600) * 1000 });
      installed.push(name);
      if (log) log('ok', `brew installed ${name}`);
    } catch (err) {
      const msg = (err.stderr || err.message || '').toString().split('\n').filter(Boolean).slice(-1)[0] || 'install failed';
      failed.push({ name, error: msg.slice(0, 200) });
      if (log) log('warn', `brew install ${name} failed: ${msg.slice(0, 120)}`);
    }
  }
  const record = { at: new Date().toISOString(), action: 'install', installed, failed, plan: { ...p, missing: undefined } };
  X.writeJSON(path.join(P.REPORT_DIR, `brew-${Date.now()}.json`), record);
  return { ...p, attempted: installed.length + failed.length, installed, failed };
}

module.exports = { plan, install, haveBrew, installedSets };
