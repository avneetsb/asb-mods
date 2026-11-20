#!/usr/bin/env node
'use strict';
// @asbmods/install — single entry point. Runs every phase in order:
//   1 detect   inventory the three agents and classify removable vs protected
//   2 archive  verified timestamped backup of each agent dir + git tag
//   3 remove   scoped removal of the custom tooling just archived (opt-in destructive)
//   4 install  deploy shared-core (skills, prompts, settings merge, agnostic defaults)
//   5 brew     Homebrew inventory plan/install driven by formulae.csv
//   6 env      shell-env propagation + interactive secret collection
//   7 hooks    register pi extension / Claude settings hooks / Codex hooks.json
//
// Paths come from lib/paths.js (resolved relative to the package), so this works from a
// clone, `npm i -g`, `npm link` or an npx temp dir — there is no ~/Dev/asb-mods hardcode.

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { execFileSync } = require('child_process');

const P = require('./lib/paths');
const X = require('./lib/fsx');
const detect = require('./lib/detect');
const archiver = require('./lib/archive');
const remover = require('./lib/remove');
const deploy = require('./lib/deploy');
const hookreg = require('./lib/hooks');
const brew = require('./lib/brew');
const secretsmod = require('./lib/secrets');
const npmpkgs = require('./lib/npmpkgs');
const restore = require('./lib/restore');

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const C = COLOR
  ? { ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', info: '\x1b[36m', bold: '\x1b[1m', dim: '\x1b[2m', off: '\x1b[0m' }
  : { ok: '', warn: '', err: '', info: '', bold: '', dim: '', off: '' };

const log = (level, msg) => {
  const tag = { ok: '[ok]', warn: '[warn]', err: '[error]', info: '[..]' }[level] || `[${level}]`;
  console.log(`  ${C[level]}${tag}${C.off} ${msg}`);
};
const banner = (title) => console.log(`\n${C.bold}── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}${C.off}`);

const HELP = `
asbmods — consolidated personal tooling for pi, Claude Code and Codex

Usage: asbmods [command] [flags]

Commands
  all        Run the full cutover: detect, archive, remove, install, brew, env, hooks
  detect     Inventory the three agents; print removable vs protected
  archive    Verified backup of ~/.pi, ~/.claude, ~/.codex, ~/.agents + dotfiles (+git tag)
  remove     Delete the detected custom tooling (requires a verified archive)
  install    Deploy shared-core: skills, prompts, settings merge, agnostic defaults
  brew       Plan (default) or install the Homebrew inventory
  env        Deploy shell-env.sh and wire the source block into shell rc files
  secrets    Collect secrets interactively into ~/.config/asb-mods/env/secrets.env
  hooks      Register per-tool hooks: pi extension, Claude settings, Codex hooks.json
  npm        Report npm globals from shared-core/npm/manifest.json
  status     Show what is deployed and how it was verified
  reset      Restore removed artifacts from the latest archive
  help       This text

Flags
  --dry-run              Report what would happen; change nothing
  --yes                  Skip interactive confirmations
  --allow-destructive    Authorise the removal phase (otherwise it is skipped)
  --no-input             Never prompt (CI/tests); keeps existing values untouched
  --scope=<s>            brew: all (default) | required
  --install-brew         Actually run brew install for missing packages
  --limit=<n>            Cap brew installs in this run
  --install-npm          Actually npm i -g missing manifest packages
  --probe=<bool>         Set false to skip npm registry reachability probing
  --rotate-secrets       Re-prompt for secrets that are already set
  --json                 Emit machine-readable JSON for detect/status

Environment
  ASB_MODS_HOME   Target home directory (used by the test suite's fixture home)
  ASB_MODS_CORE   Override the shared-core source-of-truth directory
`;

function parseArgv(argv) {
  const out = { command: 'all', flags: {} };
  for (const a of argv) {
    if (a === '--dry-run' || a === '-n') out.flags.dryRun = true;
    else if (a === '--yes' || a === '-y') out.flags.yes = true;
    else if (a === '--allow-destructive') out.flags.allowDestructive = true;
    else if (a === '--no-input') out.flags.noInput = true;
    else if (a === '--install-brew') out.flags.installBrew = true;
    else if (a === '--install-npm') out.flags.installNpm = true;
    else if (a === '--rotate-secrets') out.flags.rotateSecrets = true;
    else if (a === '--json') out.flags.json = true;
    else if (a.startsWith('--scope=')) out.flags.scope = a.slice(8);
    else if (a.startsWith('--limit=')) out.flags.limit = parseInt(a.slice(8), 10) || 0;
    else if (a.startsWith('--probe=')) out.flags.probe = a.slice(8) !== 'false';
    else if (a.startsWith('--agent=')) out.flags.agents = a.slice(8).split(',');
    else if (a.startsWith('--report=')) out.flags.reportName = a.slice(9);
    else if (!a.startsWith('-')) out.command = a;
  }
  return out;
}

function confirm(question) {
  if (process.env.ASB_MODS_ASSUME_YES === '1') return Promise.resolve(true);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(/^(y|yes)$/i.test(a.trim())); }));
}

function preflight() {
  banner('Pre-flight');
  const checks = [];
  const major = parseInt(process.versions.node.split('.')[0], 10);
  checks.push(['node >= 18', major >= 18, `found ${process.versions.node}`]);
  let git = true;
  try { execFileSync('git', ['--version'], { stdio: 'pipe' }); } catch { git = false; }
  checks.push(['git available', git, git ? 'enables archive tagging + rollback' : 'archive tags disabled']);
  checks.push(['shared-core found', X.isDir(P.CORE), P.CORE]);
  checks.push(['home target', X.isDir(P.HOME), P.HOME + (process.env.ASB_MODS_HOME ? ' (overridden)' : '')]);
  for (const [name, ok, detail] of checks) log(ok ? 'ok' : 'warn', `${name}: ${detail}`);
  if (!X.isDir(P.CORE)) { log('err', 'package is broken: shared-core missing next to the installer'); process.exit(1); }
  return { nodeMajor: major, git };
}

function writeState(patch) {
  const state = X.readJSON(P.STATE_FILE, { version: '1.0.0', history: [] });
  Object.assign(state, patch, { updatedAt: new Date().toISOString() });
  state.history = (state.history || []).concat([{ at: state.updatedAt, phases: patch.lastPhase || null }]).slice(-40);
  X.writeJSON(P.STATE_FILE, state);
  return state;
}

async function main() {
  const { command, flags } = parseArgv(process.argv.slice(2));
  if (command === 'help' || flags.help) { console.log(HELP); return; }

  const results = {};

  // ---- detect ------------------------------------------------------------
  const runDetect = () => {
    banner('Phase 1 — Detect & inventory');
    const inv = detect.detectAll();
    X.mkdirp(P.REPORT_DIR);
    X.writeJSON(path.join(P.REPORT_DIR, `inventory-${archiver.stamp()}.json`), inv);
    X.writeJSON(path.join(P.STATE_DIR, 'inventory.json'), inv);
    for (const [agent, a] of Object.entries(inv.agents)) {
      const art = a.artifacts;
      const bits = agent === 'pi'
        ? `${art.extensions.length} extensions, ${art.localPiPackages.length} local packages, ${art.userSkills.length} skills, ${art.registeredPackageCount} registered pkgs, ${art.mcpServers.length} mcp servers`
        : agent === 'claude'
          ? `${art.agents.length} agents, ${art.skills.length} skills, ${art.plugins.length} plugins, ${art.customHookFiles.length} hook files, events: ${art.hookEvents.join('/') || 'none'}`
          : `${art.skills.length} skills, hooks.json: ${art.hooksJson}, config.toml: ${art.configToml}, ${art.topLevelCount} entries`;
      log(a.present ? 'ok' : 'warn', `${agent}${a.present ? '' : ' (absent)'} — ${bits}`);
    }
    log('ok', `brew inventory: ${inv.brew.total} rows (${inv.brew.formulae} formulae, ${inv.brew.casks} casks)`);
    log('ok', `removable: ${inv.summary.removableCount} (${JSON.stringify(inv.summary.byAgent)})`);
    log('info', `protected from removal: ${inv.summary.protectedCount}`);
    if (flags.json) console.log(JSON.stringify(inv, null, 2));
    return inv;
  };

  if (command === 'detect') { runDetect(); return; }
  if (command === 'status') { return status(flags); }
  if (command === 'reset') {
    banner('Reset — restore from latest archive');
    const scoped = restore.restoreRemoved(flags, log);
    if (scoped.restored && scoped.restored.length) log('ok', `restored ${scoped.restored.length} artifact(s)`);
    else log('info', scoped.reason || 'nothing restored');
    return;
  }

  preflight();

  const inv = runDetect();
  results.inventory = { removable: inv.summary.removableCount, protected: inv.summary.protectedCount };

  // ---- archive -----------------------------------------------------------
  if (['all', 'archive'].includes(command)) {
    banner('Phase 2 — Archive (verified)');
    results.archive = flags.dryRun
      ? { dryRun: true, wouldArchive: ['pi', 'claude', 'codex', 'agents-dir', 'dotfiles'] }
      : archiver.archive({}, log);
    if (results.archive.complete) log('ok', `archive complete: ${results.archive.dest}`);
    else if (!flags.dryRun) log('err', `archive INCOMPLETE: ${results.archive.incomplete.join(', ')}`);
  }

  // ---- remove ------------------------------------------------------------
  if (['all', 'remove'].includes(command)) {
    banner('Phase 3 — Remove archived custom tooling');
    let allow = !!flags.allowDestructive;
    if (allow && !flags.yes && !flags.dryRun) {
      console.log(`\n  ${C.warn}${C.bold}This deletes ${inv.summary.removableCount} detected custom-tooling artifact(s)${C.off}`);
      console.log(`  ${C.dim}Live agent state (auth, sessions, sqlite, history) is never touched.${C.off}`);
      allow = await confirm('  Continue? [y/N]: ');
      if (!allow) log('warn', 'removal declined');
    }
    results.remove = remover.removeArchived({
      entries: inv.removable,
      archiveRecord: results.archive && results.archive.stamp ? results.archive : X.readJSON(path.join(P.STATE_DIR, 'last-archive.json'), null),
      allowDestructive: allow,
      dryRun: flags.dryRun,
    }, log);
    if (results.remove.skipped) log('info', `removal skipped: ${results.remove.reason}`);
    else log('ok', `removed ${results.remove.removedCount}, refused ${results.remove.refusedCount}, failed ${results.remove.failedCount}`);
  }

  // ---- install -----------------------------------------------------------
  if (['all', 'install'].includes(command)) {
    banner('Phase 4 — Install consolidated shared-core');
    results.install = flags.dryRun
      ? { dryRun: true, skills: deploy.canonicalSkills().length }
      : deploy.deploy({}, log);
    if (!flags.dryRun) {
      X.writeJSON(P.MANIFEST_FILE, { at: new Date().toISOString(), actions: results.install, core: P.CORE });
      log('ok', `manifest written: ${P.MANIFEST_FILE}`);
    }
  }

  // ---- npm globals -------------------------------------------------------
  if (['all', 'npm'].includes(command)) {
    banner('Phase 4b — npm globals from manifest');
    results.npm = npmpkgs.assess({ install: !!flags.installNpm, dryRun: flags.dryRun, probe: flags.probe }, log);
  }

  // ---- brew --------------------------------------------------------------
  if (['all', 'brew'].includes(command)) {
    banner('Phase 5 — Homebrew inventory');
    const opts = { scope: flags.scope || 'all', limit: flags.limit, dryRun: flags.dryRun || !flags.installBrew };
    results.brew = flags.installBrew
      ? brew.install(opts, log)
      : brew.plan({ scope: flags.scope || 'all' });
    if (!flags.installBrew) {
      log('info', `${results.brew.presentCount}/${results.brew.considered} present, ${results.brew.missingCount} missing (pass --install-brew to install)`);
      if (results.brew.missing.length) log('dim', `missing: ${results.brew.missing.slice(0, 12).join(', ')}${results.brew.missing.length > 12 ? ' …' : ''}`);
    }
  }

  // ---- env + secrets -----------------------------------------------------
  if (['all', 'env'].includes(command)) {
    banner('Phase 6 — Environment propagation');
    results.env = secretsmod.deployShellEnv(log, flags.dryRun);
  }
  if (['all', 'secrets'].includes(command)) {
    banner('Phase 6b — Secrets (interactive; values are never logged)');
    results.secrets = flags.dryRun
      ? { dryRun: true, variables: secretsmod.templateVars().map((v) => v.name) }
      : await secretsmod.collect({ noInput: !!flags.noInput, rotateSecrets: !!flags.rotateSecrets }, log);
  }

  // ---- hooks -------------------------------------------------------------
  if (['all', 'hooks'].includes(command)) {
    banner('Phase 7 — Register per-tool hooks');
    results.hooks = hookreg.registerAll({ dryRun: flags.dryRun }, log);
    for (const r of (results.hooks.results || [])) {
      if (r.skipped) log('warn', `${r.tool}: ${r.skipped}`);
    }
  }

  writeState({ lastPhase: command, lastResults: summarize(results), dryRun: !!flags.dryRun });

  banner('Summary');
  printSummary(results);
}

function summarize(results) {
  const s = {};
  if (results.archive) s.archive = results.archive.complete ? 'complete' : (results.archive.dryRun ? 'dry-run' : 'incomplete');
  if (results.remove) s.removed = results.remove.skipped ? `skipped (${results.remove.reason})` : results.remove.removedCount;
  if (results.install) s.installedActions = Array.isArray(results.install) ? results.install.length : 'dry-run';
  if (results.npm && results.npm.summary) s.npm = results.npm.summary;
  if (results.brew) s.brew = { present: results.brew.presentCount, missing: results.brew.missingCount };
  if (results.secrets) s.secretsVerified = results.secrets.verified !== undefined ? results.secrets.verified : 'dry-run';
  if (results.hooks) s.hooks = (results.hooks.results || []).map((r) => `${r.tool}:${r.changed ? 'registered' : r.skipped ? 'skipped' : 'up-to-date'}`);
  return s;
}

function printSummary(results) {
  const s = summarize(results);
  for (const [k, v] of Object.entries(s)) {
    console.log(`  ${C.dim}${k}:${C.off} ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
}

function status(flags) {
  banner('Status');
  const state = X.readJSON(P.STATE_FILE, null);
  const inv = X.readJSON(path.join(P.STATE_DIR, 'inventory.json'), null);
  const archives = archiver.listArchives();
  const lines = [];

  lines.push(['package root', P.PKG_ROOT, true]);
  lines.push(['shared-core', P.CORE, X.isDir(P.CORE)]);
  lines.push(['state file', P.STATE_FILE, X.isFile(P.STATE_FILE)]);
  lines.push(['installed manifest', P.MANIFEST_FILE, X.isFile(P.MANIFEST_FILE)]);
  lines.push(['archives', `${archives.length} (${archives.slice(-3).join(', ') || 'none'})`, archives.length > 0]);

  const lastArchive = X.readJSON(path.join(P.STATE_DIR, 'last-archive.json'), null);
  lines.push(['last archive tag', lastArchive && lastArchive.tag ? `${lastArchive.tag.tag || '-'}${lastArchive.tag.tagged ? '' : ' (untagged)'}` : 'none',
    !!(lastArchive && lastArchive.tag && lastArchive.tag.tagged)]);

  const secretsFile = path.join(P.ENV_DIR, 'secrets.env');
  if (X.isFile(secretsFile)) {
    const mode = (fs.statSync(secretsFile).mode & 0o777).toString(8);
    lines.push(['secrets.env', `${Object.keys(X.readFrom(secretsFile)).length} var(s), mode ${mode}`, mode === '600']);
  } else lines.push(['secrets.env', 'not created', false]);

  lines.push(['shell-env deployed', path.join(P.ENV_DIR, 'shell-env.sh'), X.isFile(path.join(P.ENV_DIR, 'shell-env.sh'))]);
  const sourced = P.dotfiles.filter((rc) => X.isFile(rc) && X.readFileSyncSafe(rc).includes(secretsmod.MARK_BEGIN)).map((rc) => path.basename(rc));
  lines.push(['shell rc wired', sourced.join(', ') || 'none', sourced.length > 0]);

  const skillCount = deploy.canonicalSkills().length;
  for (const [agent, dirFn] of Object.entries(deploy.AGENT_SKILL_DIRS)) {
    const dir = dirFn();
    const have = X.isDir(dir) ? X.listDirs(dir).filter((d) => X.isFile(path.join(dir, d, 'SKILL.md'))).length : 0;
    lines.push([`${agent} skills`, `${have}/${skillCount} canonical present in ${dir}`, have >= skillCount && skillCount > 0]);
  }

  const piExt = path.join(P.agents.pi.agentDir, 'extensions', 'asb-mods-hooks.ts');
  lines.push(['pi hook extension', piExt, X.isFile(piExt)]);
  const claudeSettings = X.readJSON(path.join(P.agents.claude.dir, 'settings.json'), {});
  const claudeTagged = JSON.stringify(claudeSettings.hooks || {}).includes(hookreg.MARK);
  lines.push(['claude hooks registered', claudeTagged ? 'asb-mods entries found' : 'no asb-mods entries', claudeTagged]);
  const codexHooks = X.readJSON(path.join(P.agents.codex.dir, 'hooks.json'), {});
  const codexTagged = JSON.stringify(codexHooks.hooks || {}).includes(hookreg.MARK);
  lines.push(['codex hooks registered', codexTagged ? 'asb-mods entries found' : 'no asb-mods entries', codexTagged]);

  for (const [k, v, ok] of lines) console.log(`  ${C[ok ? 'ok' : 'warn']}${ok ? '[ok]  ' : '[warn]'}${C.off}${k.padEnd(24)} ${v}`);

  if (inv) console.log(`\n  ${C.dim}last inventory: ${inv.summary.removableCount} removable / ${inv.summary.protectedCount} protected${C.off}`);
  if (state) console.log(`  ${C.dim}last run: ${state.updatedAt} (${state.lastPhase})${C.off}`);
  if (flags.json) console.log(JSON.stringify({ lines: lines.map(([k, v, ok]) => ({ k, v, ok })), state, archives }, null, 2));
  const failing = lines.filter(([, , ok]) => !ok).length;
  console.log(`\n  ${failing ? C.warn : C.ok}${lines.length - failing}/${lines.length} checks green${C.off}`);
}

main().catch((err) => {
  console.error(`${C.err}[fatal]${C.off} ${err.message}`);
  if (process.env.ASB_MODS_DEBUG) console.error(err.stack);
  process.exit(1);
});
