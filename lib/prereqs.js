'use strict';
// Prerequisites: what has to exist on the machine before any phase is meaningful.
//
// Two responsibilities, deliberately separate:
//   probe()/doctor()  read-only. Safe in CI, changes nothing, exits non-zero when something
//                     is missing so a script can gate on it.
//   installPrereqs()  opt-in (--install-prereqs). Announces every command before running it,
//                     and refuses outright when it cannot do the job honestly: no --no-input
//                     runs, and Homebrew's installer is never attempted without a terminal,
//                     because it needs an admin password.
//
// One limit is structural and worth stating plainly: install.js *is* Node. If Node is absent
// the installer never starts, so this module can only replace a too-old Node — bootstrapping
// from nothing is bootstrap.sh's job.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const NODE_MIN_MAJOR = 18;
const BREW_INSTALL_URL = 'https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh';
const BREW_FIX = `NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL ${BREW_INSTALL_URL})"   # needs admin`;
// A freshly installed Homebrew is not on this process's PATH yet.
const BREW_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

function findOnPath(name) {
  if (!name) return null;
  if (name.includes('/')) {
    try { fs.accessSync(name, fs.constants.X_OK); return name; } catch { return null; }
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const cand = path.join(dir, name);
    try {
      if (fs.statSync(cand).isFile()) { fs.accessSync(cand, fs.constants.X_OK); return cand; }
    } catch { /* keep looking */ }
  }
  return null;
}

function firstLine(out) { return String(out || '').split('\n').map((l) => l.trim()).find(Boolean) || ''; }

function versionOf(bin, args) {
  try {
    return firstLine(execFileSync(bin, args || ['--version'],
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch { return null; }
}

function brewBin() { return findOnPath('brew') || BREW_DIRS.map((d) => path.join(d, 'brew')).find(findOnPath) || null; }

function cltStatus() {
  if (process.platform !== 'darwin') return { ok: true, detail: 'n/a (not macOS)', fix: null };
  try {
    const p = execFileSync('xcode-select', ['-p'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return { ok: !!p, detail: p || 'not installed', fix: p ? null : 'xcode-select --install' };
  } catch { return { ok: false, detail: 'not installed', fix: 'xcode-select --install' }; }
}

// The agent rows come from the catalogue so doctor and --install-agents can never disagree
// about which tool is which binary.
function agentCatalog() {
  const file = path.join(__dirname, '..', 'shared-core', 'npm', 'agents.json');
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { error: `${file}: ${e.message}`, agents: [] }; }
  return { file, agents: Array.isArray(raw.agents) ? raw.agents : [] };
}

function routeLabel(r) { return `${r.kind}:${r.package}`; }

function probe() {
  const rows = [];
  const add = (name, ok, detail, fix) => rows.push({ name, ok: !!ok, detail, fix: ok ? null : fix || null });

  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  add('node', nodeMajor >= NODE_MIN_MAJOR, `v${process.versions.node} (needs >= ${NODE_MIN_MAJOR})`,
    'brew install node        # or bootstrap.sh on a machine with no Node at all');

  const npm = findOnPath('npm');
  add('npm', npm, npm ? versionOf(npm, ['--version']) || 'present' : 'not on PATH', 'ships with Node: brew install node');

  const git = findOnPath('git');
  add('git', git, git ? versionOf(git, ['--version']) || 'present' : 'not on PATH', 'brew install git   # or xcode-select --install');

  const clt = cltStatus();
  add('Xcode CLT', clt.ok, clt.detail, clt.fix);

  // Usable means *on PATH*: brew.js and every install route call it by name, so a Homebrew that
  // exists under /opt/homebrew but was never exported is a problem with a real fix, not a pass.
  const brewOnPath = findOnPath('brew');
  const brewInstalled = brewBin();
  add('Homebrew', brewOnPath,
    brewOnPath ? versionOf(brewOnPath, ['--version']) || 'present'
      : brewInstalled ? `installed at ${brewInstalled} but not on PATH` : 'not installed',
    brewOnPath ? null
      : brewInstalled ? `eval "$(${brewInstalled} shellenv)"   # then add that line to your shell profile` : BREW_FIX);

  const cat = agentCatalog();
  for (const a of cat.agents) {
    const found = findOnPath(a.bin);
    add(`${a.tool} CLI`, found, found || 'not on PATH',
      `asbmods --install-agents   # routes: ${a.routes.map(routeLabel).join(', ')}`);
  }
  if (cat.error) add('agent catalogue', false, cat.error, `restore ${path.join('shared-core', 'npm', 'agents.json')}`);

  return { rows, ok: rows.every((r) => r.ok), catalogError: cat.error || null };
}

function doctor(flags, log) {
  const p = probe();
  for (const r of p.rows) {
    log(r.ok ? 'ok' : 'warn', `${r.name.padEnd(15)} ${r.detail}${r.ok ? '' : `\n${' '.repeat(24)}fix: ${r.fix}`}`);
  }
  const missing = p.rows.filter((r) => !r.ok).map((r) => r.name);
  log(p.ok ? 'ok' : 'warn', p.ok ? 'all prerequisites present' : `missing: ${missing.join(', ')}`);
  log('info', 'this command changed nothing; --install-prereqs and --install-agents are the install paths');
  if (flags && flags.json) console.log(JSON.stringify(p, null, 2));
  return p;
}

// Build the ordered plan. Homebrew first, because every other fix below runs through it.
function planFor(p) {
  const need = (name) => p.rows.some((r) => r.name === name && !r.ok);
  const plan = [];
  const brewRow = p.rows.find((r) => r.name === 'Homebrew');
  if (brewRow && !brewRow.ok) {
    if (/not on PATH/.test(brewRow.detail)) {
      // Installed but never exported: the fix is a line in the shell profile, not an installer.
      plan.push({ name: 'Homebrew', needsTty: false, manual: brewRow.fix });
    } else {
      plan.push({
        name: 'Homebrew', needsTty: true,
        command: ['/bin/bash', '-c', `NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL ${BREW_INSTALL_URL})"`],
      });
    }
  }
  if (need('node')) plan.push({ name: 'Node.js', needsTty: false, command: ['brew', 'install', 'node'] });
  if (need('npm')) plan.push({ name: 'npm', needsTty: false, command: ['brew', 'install', 'node'] });
  if (need('git')) plan.push({ name: 'git', needsTty: false, command: ['brew', 'install', 'git'] });
  if (need('Xcode CLT')) {
    // Cannot be unattended: Apple's installer opens a GUI dialog. Announce, do not fake it.
    plan.push({ name: 'Xcode CLT', needsTty: false, manual: 'xcode-select --install   # opens Apple\u0027s installer dialog' });
  }
  return plan;
}

function adoptBrewPath() {
  for (const dir of BREW_DIRS) {
    if (findOnPath(path.join(dir, 'brew')) && !(process.env.PATH || '').split(path.delimiter).includes(dir)) {
      process.env.PATH = `${dir}${path.delimiter}${process.env.PATH || ''}`;
      return dir;
    }
  }
  return null;
}

async function installPrereqs(flags, log, confirm) {
  const p = probe();
  const plan = planFor(p);
  if (!plan.length) { log('ok', 'prerequisites already satisfied — nothing to install'); return { attempted: [], installed: [], skipped: 'already-satisfied' }; }

  if (flags.noInput) {
    return { refused: '--install-prereqs needs to run commands; refusing under --no-input (run doctor to see what is missing)' };
  }
  const tty = process.stdout.isTTY;
  if (!flags.dryRun && !tty && plan.some((s) => s.needsTty)) {
    return { refused: 'Homebrew\u0027s installer needs an admin password and a terminal. Run this interactively, or install Homebrew yourself and re-run.' };
  }

  for (const step of plan) {
    log('info', step.manual
      ? `${step.name}: manual step — ${step.manual}`
      : `${step.name}: will run  ${step.command.join(' ')}`);
  }
  if (flags.dryRun) { log('ok', '--dry-run: no command executed'); return { attempted: [], installed: [], dryRun: true, planned: plan.map((s) => s.name) }; }

  if (!flags.yes) {
    const yes = confirm ? await confirm('  Install the prerequisites above? [y/N]: ') : true;
    if (!yes) return { declined: true };
  }

  const attempted = [];
  const installed = [];
  for (const step of plan) {
    if (step.manual) { attempted.push({ name: step.name, manual: true }); continue; }
    const r = spawnSync(step.command[0], step.command.slice(1), { stdio: 'inherit' });
    const ok = r.status === 0;
    attempted.push({ name: step.name, command: step.command.join(' '), ok, code: r.status });
    if (ok) {
      installed.push(step.name);
      log('ok', `${step.name}: install command exited 0`);
      if (step.name === 'Homebrew') {
        const dir = adoptBrewPath();
        if (dir) log('ok', `Homebrew found at ${dir} for the rest of this run`);
        else log('warn', 'Homebrew installed but not on PATH yet — open a new shell or add it to PATH');
      }
    } else {
      log('err', `${step.name}: command exited ${r.status}`);
    }
  }
  const after = probe();
  return { attempted, installed, remaining: after.rows.filter((r) => !r.ok).map((r) => r.name) };
}

module.exports = { probe, doctor, installPrereqs, findOnPath, brewBin, cltStatus, agentCatalog, NODE_MIN_MAJOR, BREW_INSTALL_URL };
