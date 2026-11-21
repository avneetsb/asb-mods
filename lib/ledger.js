'use strict';
// The install ledger: what *this installer* put on the machine, and how to take it back.
//
// Until now the installer could undo its own file copies (`reset` replays a removal report)
// but not the software it installed machine-wide: `brew install` and `npm i -g` had no
// inverse, so "rollback" stopped at configuration and a machine could never be returned to
// its pre-install state. Each install path now records what it installed here, and
// `asbmods uninstall` plans (and with --yes runs) the removal of exactly those entries.
//
// Three rules that keep this honest:
//   * Only recorded installs are removable. Nothing in here is ever inferred from "this
//     package exists", so a Homebrew you installed yourself is untouchable by design.
//   * Some entries are held back instead of planned: runtime prerequisites (Node, npm, git,
//     Homebrew itself) would break the installer that is removing them, and an agent CLI
//     would delete the tool you may be running right now. Those need --include-held-back /
//     --include-agent-clis to be considered at all.
//   * Machine-independent: entries store a manager plus a name, never an absolute path, so
//     the ledger survives a different user, a different Homebrew prefix or a moved Node.
//
// Reports written by install phases are the evidence trail; `rebuildFromReports()` turns
// reports from before 0.3.1 into ledger entries so an already-installed machine is not stuck
// with an empty, useless ledger.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const P = require('./paths');
const X = require('./fsx');

const LEDGER_VERSION = 1;
const LEDGER_FILE = () => path.join(P.STATE_DIR, 'install-ledger.json');

// Removing these while the installer runs takes the floor out from under it: install.js *is*
// Node, and every brew route below is `brew`. They stay in the ledger for the record and are
// reported as held back, never planned.
const RUNTIME_PREREQS = new Set(['node', 'npm', 'git', 'homebrew']);
// `native` routes are vendor installer scripts (curl | bash); there is no inverse command we
// could state honestly, so they are recorded and never planned.
const NON_REVERSIBLE_KINDS = new Set(['native', 'script']);


function emptyLedger() { return { version: LEDGER_VERSION, updated: null, entries: [] }; }

function read() {
  const raw = X.readJSON(LEDGER_PATH_FILE(), null);
  if (!raw || !Array.isArray(raw.entries)) return emptyLedger();
  return { version: raw.version || LEDGER_VERSION, updated: raw.updated || null, entries: raw.entries };
}

// LEDGER_PATH_FILE kept as a function so tests can repoint STATE_DIR between calls.
function LEDGER_PATH_FILE() { return LEDGER_FILE(); }

function keyOf(e) { return `${e.manager}:${e.name}`; }

// Append entries, newest wins per (manager, name). Re-installing the same package refreshes
// its install command and timestamp instead of stacking duplicates, so `uninstall` never
// proposes the same removal twice.
function record(entries, opts = {}) {
  const list = (entries || []).filter((e) => e && e.manager && e.name);
  const ledger = read();
  const now = new Date().toISOString();
  const index = new Map(ledger.entries.map((e, i) => [keyOf(e), i]));
  let added = 0;
  let updated = 0;
  for (const e of list) {
    const entry = {
      at: now,
      manager: e.manager,
      name: e.name,
      kind: e.kind || (e.manager === 'brew' ? 'formula' : 'package'),
      installCommand: e.installCommand || null,
      source: e.source || opts.source || 'install',
      reversible: e.reversible !== false && !NON_REVERSIBLE_KINDS.has(e.kind || ''),
      reason: e.reason || null,
      agent: e.agent || null,
      dependencyType: e.dependencyType || null,
      removedAt: null,
    };
    if (RUNTIME_PREREQS.has(e.name.toLowerCase())) {
      entry.reversible = false;
      entry.reason = entry.reason || 'runtime prerequisite — the installer runs on it; remove it yourself';
    }
    const at = index.get(keyOf(entry));
    if (at === undefined) { index.set(keyOf(entry), ledger.entries.length); ledger.entries.push(entry); added += 1; }
    else {
      const prev = ledger.entries[at];
      // Keep the first sighting, refresh everything else.
      ledger.entries[at] = Object.assign({}, entry, { firstSeenAt: prev.firstSeenAt || prev.at });
      updated += 1;
    }
  }
  ledger.updated = now;
  X.mkdirp(P.STATE_DIR);
  X.writeJSON(LEDGER_PATH_FILE(), ledger);
  return { file: LEDGER_PATH_FILE(), added, updated, total: ledger.entries.length };
}

// --- managers ---------------------------------------------------------------
// A manager owns two things: how to remove one of its entries, and how to prove afterwards
// whether the name is still on the machine.

function brewArgs(name, kind) { return kind === 'cask' ? ['uninstall', '--cask', name] : ['uninstall', name]; }

let brewChecked = null;
// "Not installed" and "Homebrew itself is missing" are different facts. Answering the first
// when the second is true would silently reclassify every brew entry as already-gone on a
// machine where Homebrew was removed first, so an unavailable manager reports unknown instead.
function brewAvailable() {
  if (brewChecked !== null) return brewChecked;
  try {
    execFileSync('brew', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 });
    brewChecked = true;
  } catch { brewChecked = false; }
  return brewChecked;
}

function brewPresent(name, kind) {
  if (!brewAvailable()) return null;
  try {
    const args = kind === 'cask' ? ['list', '--cask', '--versions', name] : ['list', '--versions', name];
    const out = execFileSync('brew', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 });
    return new RegExp(`(^|\\s)${escapeRe(name)}(@|\\s|$)`).test(out.trim());
  } catch { return false; }
}

function npmGlobals() {
  try {
    const out = execFileSync('npm', ['ls', '-g', '--depth=0', '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
    return new Set(Object.keys((JSON.parse(out || '{}').dependencies) || {}));
  } catch { return new Set(); }
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function removalCommand(entry) {
  if (entry.manager === 'brew') return ['brew', ...brewArgs(entry.name, entry.kind)];
  if (entry.manager === 'npm-global') return ['npm', 'uninstall', '-g', entry.name];
  return null;
}

function stillPresent(entry) {
  if (entry.manager === 'brew') return brewPresent(entry.name, entry.kind);
  if (entry.manager === 'npm-global') return npmGlobals().has(entry.name);
  return null;
}

// manager/route-kind mapping shared with the install paths, so a route recorded by
// agents.js and a row recorded by brew.js land in the same namespace.
function managerForRouteKind(kind) {
  if (kind === 'npm-global') return 'npm-global';
  if (kind === 'brew-formula') return 'brew';
  if (kind === 'brew-cask') return 'brew';
  return 'other';
}

// One place that turns an agents.json route into a ledger entry, so the name recorded at
// install time is exactly the name `uninstall` will remove (a brew cask has to be recorded as
// a cask or removal would issue a formula uninstall).
function routeEntry(route, agent) {
  const manager = managerForRouteKind(route.kind);
  const kind = route.kind === 'brew-cask' ? 'cask'
    : route.kind === 'brew-formula' ? 'formula'
      : route.kind === 'npm-global' ? 'package' : route.kind;
  return {
    manager: manager === 'other' ? 'vendor' : manager,
    name: route.package,
    kind,
    agent: agent || null,
    installCommand: Array.isArray(route.command) ? route.command.join(' ') : null,
    reversible: manager !== 'other',
    reason: manager === 'other' ? 'installed by the vendor installer script — remove it as that tool documents' : null,
    source: 'agents.install',
  };
}

// --- planning ---------------------------------------------------------------

function holdBackReason(entry, opts = {}) {
  if (NON_REVERSIBLE_KINDS.has(entry.kind)) return `installed by a vendor installer script — remove it the way ${entry.name}'s docs describe`;
  if (!entry.reversible) return entry.reason || 'recorded as not removable by asbmods';
  if (entry.removedAt) return null;
  if (entry.agent && !opts.includeAgentClis) return `agent CLI (${entry.agent}) — pass --include-agent-clis to remove it`;
  if (!removalCommand(entry)) return `no removal command known for manager "${entry.manager}"`;
  if (RUNTIME_PREREQS.has(entry.name.toLowerCase()) && !opts.includeHeldBack) return 'runtime prerequisite — pass --include-held-back to consider it';
  return null;
}

// plan() is read-only and CI-safe: it never runs a removal, only reads the ledger and asks
// each manager whether the name is still there.
function plan(opts = {}) {
  const ledger = read();
  const removable = [];
  const heldBack = [];
  const alreadyGone = [];
  const unknownNames = [];
  const wanted = opts.names && opts.names.length ? new Set(opts.names) : null;
  const live = { 'npm-global': npmGlobals() };
  for (const e of ledger.entries) {
    if (wanted && !wanted.has(e.name)) continue;
    const present = e.manager === 'npm-global' ? live['npm-global'].has(e.name) : stillPresent(e);
    const row = Object.assign({}, e, { present, removal: removalCommand(e) });
    if (present === false) { alreadyGone.push(row); continue; }
    const held = holdBackReason(e, opts);
    if (held) { heldBack.push(Object.assign(row, { heldBackReason: held })); } else removable.push(row);
  }
  if (wanted) {
    for (const n of wanted) if (!ledger.entries.some((e) => e.name === n)) unknownNames.push(n);
  }
  return {
    file: LEDGER_PATH_FILE(),
    total: ledger.entries.length,
    considered: removable.length + heldBack.length + alreadyGone.length,
    removable,
    heldBack,
    alreadyGone,
    unknownNames: [...new Set(unknownNames)],
  };
}

// --- applying ---------------------------------------------------------------

// Removal is opt-in twice over: plan-by-default, and --yes must be present to execute.
// Each entry is verified after its command exits, so "uninstalled" means the manager no
// longer reports the name — not merely that a command returned 0.
function remove(opts = {}, log = () => {}) {
  if (opts.dryRun) {
    const p = plan(opts);
    log('info', `dry-run: would remove ${p.removable.length} package(s); ${p.heldBack.length} held back`);
    return Object.assign(p, { removed: [], failed: [], dryRun: true });
  }
  const p = plan(opts);
  const removed = [];
  const failed = [];
  const ledger = read();
  const index = new Map(ledger.entries.map((e, i) => [keyOf(e), i]));
  for (const e of p.removable) {
    const cmd = removalCommand(e);
    log('info', `removing ${e.manager}:${e.name} — ${cmd.join(' ')}`);
    const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
    const present = stillPresent(e);
    if (r.status === 0 && present === false) {
      const at = index.get(keyOf(e));
      if (at !== undefined) ledger.entries[at] = Object.assign({}, ledger.entries[at], { removedAt: new Date().toISOString() });
      removed.push({ manager: e.manager, name: e.name, kind: e.kind, command: cmd.join(' ') });
      log('ok', `removed ${e.manager}:${e.name}`);
    } else {
      let why = 'could not verify removal';
      if (r.status !== 0) why = `command exited ${r.status}`;
      else if (present === true) why = 'command exited 0 but the manager still reports it installed';
      failed.push({ manager: e.manager, name: e.name, reason: why });
      log('err', `${e.manager}:${e.name} — ${why}`);
    }
  }
  ledger.updated = new Date().toISOString();
  X.mkdirp(P.STATE_DIR);
  X.writeJSON(LEDGER_PATH_FILE(), ledger);
  X.mkdirp(P.REPORT_DIR);
  const reportPath = path.join(P.REPORT_DIR, `uninstall-${Date.now()}.json`);
  X.writeJSON(reportPath, {
    at: new Date().toISOString(), removed, failed,
    heldBack: p.heldBack.map((e) => ({ manager: e.manager, name: e.name, reason: e.heldBackReason })),
  });
  return { removed, failed, heldBack: p.heldBack, reportPath, unknownNames: p.unknownNames };
}

// --- retrofit ---------------------------------------------------------------

// Ledger entries can only exist for installs the installer recorded, and phases before 0.3.1
// wrote per-run reports rather than a ledger. This reads those reports — the same evidence a
// human would read — and materialises the ledger, so an existing machine gets a useful
// `uninstall` instead of an empty table. Guesses are never made about names that appear in
// neither a report nor the ledger.
function rebuildFromReports(log = () => {}) {
  if (!X.isDir(P.REPORT_DIR)) return { added: 0, updated: 0, reports: 0, total: read().entries.length };
  const files = fs.readdirSync(P.REPORT_DIR)
    .filter((n) => /^(brew|npm|agents)-\d+\.json$/.test(n))
    .map((n) => path.join(P.REPORT_DIR, n));
  let reports = 0;
  const entries = [];
  for (const f of files) {
    const rec = X.readJSON(f, null);
    if (!rec) continue;
    reports += 1;
    if (Array.isArray(rec.installedRows)) for (const r of rec.installedRows) entries.push(r);
    else if (Array.isArray(rec.installed)) {
      for (const it of rec.installed) {
        if (typeof it === 'string') {
          // brew reports list bare names; the row type is recorded separately in missingRows.
          const row = (rec.missingRows || []).find((m) => m.name === it);
          entries.push({
            manager: 'brew', name: it, kind: row && row.type === 'cask' ? 'cask' : 'formula',
            installCommand: `brew install${row && row.type === 'cask' ? ' --cask' : ''} ${it}`, source: `report:${path.basename(f)}`,
          });
        } else if (it && it.tool) {
          // agents report: {tool, route:"npm-global:@scope/pkg", at}
          const [kind, pkg] = String(it.route || '').split(':');
          const manager = managerForRouteKind(kind);
          if (manager === 'other' || !pkg) continue;
          entries.push({
            manager, name: pkg, kind: manager === 'brew' ? (kind === 'brew-cask' ? 'cask' : 'formula') : 'package',
            installCommand: null, agent: it.tool, source: `report:${path.basename(f)}`,
          });
        }
      }
    }
    if (Array.isArray(rec.results && rec.results.installedRows)) for (const r of rec.results.installedRows) entries.push(r);
    else if (Array.isArray(rec.results && rec.results.installed)) {
      for (const n of rec.results.installed) {
        entries.push({ manager: 'npm-global', name: n, kind: 'package', installCommand: `npm i -g ${n}`, source: `report:${path.basename(f)}` });
      }
    }
  }
  const res = record(entries, { source: 'rebuilt-from-reports' });
  log('ok', `${reports} report(s) read → ${res.added} new ledger entr(ies), ${res.updated} refreshed`);
  return Object.assign(res, { reports });
}

module.exports = {
  LEDGER_VERSION, LEDGER_FILE, read, record, plan, remove, rebuildFromReports,
  managerForRouteKind, routeEntry, removalCommand, stillPresent, RUNTIME_PREREQS,
};
