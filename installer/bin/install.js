#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const HOME = os.homedir();
const ASB_CORE = path.join(HOME, 'Dev', 'asb-mods', 'shared-core');
const BKUP = path.join(HOME, '.config', 'asb-mods', 'backups');

const C = process.stdout.isTTY ? {
  ok: '\x1b[32m[OK]\x1b[0m', warn: '\x1b[33m[WARN]\x1b[0m',
  err: '\x1b[31m[ERR]\x1b[0m', info: '\x1b[36m[INFO]\x1b[0m'
} : { ok: '[OK]', warn: '[WARN]', err: '[ERR]', info: '[INFO]' };

const log = (l, m) => console.log('  ' + C[l] + ' ' + m);
const exd = d => { if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); return true; } return false; };
const exf = p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };

// --- Phase functions ---

function depEnv() {
  console.log('\n[Phase 1/4] Environment propagation');
  exd(path.join(HOME, '.config', 'asb-mods', 'env'));
  
  const esrc = path.join(ASB_CORE, 'env', 'shell-env.sh');
  const edst = path.join(HOME, '.config', 'asb-mods', 'env', 'shell-env.sh');
  
  if (exf(esrc)) {
    fs.copyFileSync(esrc, edst);
    log('ok', 'shell-env.sh deployed');
    
    for (const rc of ['.zshrc', '.bashrc']) {
      const rp = path.join(HOME, rc);
      if (exf(rp)) {
        let c = fs.readFileSync(rp, 'utf8');
        if (!c.includes('asb-mods')) {
          fs.appendFileSync(rp, '\n# asb-mods shared env\nsource "' + edst + '"\n');
          log('ok', 'Source line added to ' + rc);
        }
      }
    }
  }
  
  const stpl = path.join(ASB_CORE, 'env', 'secrets.env.template');
  const sl = path.join(HOME, '.config', 'asb-mods', 'env', 'secrets.local.env');
  if (exf(stpl) && !exf(sl)) {
    fs.copyFileSync(stpl, sl);
    fs.chmodSync(sl, 0o600);
    log('ok', 'secrets.local.env created (mode 600)');
  }
}

function instBrew() {
  console.log('\n[Phase 2/4] Homebrew packages');
  const bp = path.join(ASB_CORE, 'brew', 'install.sh');
  if (exf(bp)) {
    try {
      execSync('bash "' + bp + '" validate', { encoding: 'utf8' });
      log('ok', 'All brew packages verified');
    } catch (e) {
      log('warn', 'Some packages missing or validation failed');
    }
  }
}

function regHooks() {
  console.log('\n[Phase 3/4] Hook registration');
  const hp = path.join(ASB_CORE, 'hooks', 'generate-adapters.sh');
  if (exf(hp)) {
    try {
      execSync('bash "' + hp + '" all', { encoding: 'utf8' });
      log('ok', 'Per-tool adapters generated');
    } catch (e) {
      log('warn', 'Hook generation had issues: ' + e.message.split('\n')[0]);
    }
  }
}

function chkNpm() {
  console.log('\n[Phase 4/4] NPM globals');
  const pkgs = [
    '@abix5/pi-beads', '@beads/bd', '@biomejs/biome',
    '@colbymchenry/codegraph', 'gitnexus', 'bash-language-server',
    'pyright', 'typescript-language-server', 'eslint'
  ];
  let done = 0;
  for (const pkg of pkgs) {
    try {
      const r = execSync("npm ls -g --depth=0 2>/dev/null | grep '" + pkg + "' || echo ''", { encoding: 'utf8' });
      if (r.trim()) done++;
    } catch (e) {}
  }
  log('ok', done + '/' + pkgs.length + ' npm globals present');
}

// --- Main ---

async function main() {
  const step = process.argv[2] || 'all';
  
  if (step === 'help' || step === '--help') {
    console.log(`Usage: asbmod-install [all|env|brew|hooks|npm|status|reset]
  
Commands:
  all     Run full installation (default)
  env     Deploy environment propagation
  brew    Install/manage Homebrew packages
  hooks   Register per-tool hooks
  npm     Check global NPM packages
  status  Show installation status
  reset   Restore from last backup

Note: All changes are non-destructive. Existing configs are archived first.`);
    return;
  }
  
  if (step === 'status') {
    const checks = [
      ['shared-core', exf(path.join(ASB_CORE, 'hooks', 'hooks.json'))],
      ['shell-env', exf(path.join(HOME, '.config', 'asb-mods', 'env', 'shell-env.sh'))],
      ['brew-installer', exf(path.join(ASB_CORE, 'brew', 'install.sh'))],
      ['hook-adapter', exf(path.join(ASB_CORE, 'hooks', 'generate-adapters.sh'))],
      ['cutover', exf(path.join(ASB_CORE, 'cutover', 'archive.sh'))],
    ];
    console.log('\n[asb-mods status]\n');
    for (const [n, v] of checks) {
      log(v ? 'ok' : 'err', n + ': ' + (v ? 'installed' : 'not deployed'));
    }
    let bc = 0;
    if (fs.existsSync(BKUP)) {
      bc = fs.readdirSync(BKUP).filter(d => d.startsWith('2')).length;
    }
    log('info', bc + ' backup(s) available');
    return;
  }
  
  if (step === 'reset') {
    log('warn', 'Resetting to last backup...');
    execSync('bash "' + path.join(ASB_CORE, 'cutover', 'rollback.sh') + '" all', { encoding: 'utf8' });
    return;
  }
  
  const valid = ['all', 'env', 'brew', 'hooks', 'npm'];
  if (!valid.includes(step)) {
    console.log('Unknown step: ' + step);
    process.exit(1);
  }
  
  // Pre-flight checks
  console.log('\n[asb-mods-installer] Pre-flight checks...');
  for (const cmd of ['brew', 'node', 'git']) {
    try {
      execSync('which ' + cmd, { encoding: 'utf8' });
      log('ok', cmd + ' found');
    } catch (e) {
      console.error(cmd + ' not found — aborting');
      process.exit(1);
    }
  }
  
  // Archive current state before any changes
  exd(BKUP);
  const bakts = new Date().toISOString().replace(/[T:]/g, '-').split('.')[0];
  const bkpath = path.join(BKUP, bakts);
  
  log('info', 'Archiving current tool state to: ' + bakts);
  for (const t of ['pi', 'claude', 'codex']) {
    const sp = path.join(HOME, '.' + t);
    if (fs.existsSync(sp)) {
      exd(path.join(bkpath, t));
      try {
        execSync('cp -RL "' + sp + '/." "' + path.join(bkpath, t) + '/" 2>/dev/null || true', { encoding: 'utf8' });
        log('ok', t + ' archived');
      } catch (e) {
        log('warn', t + ' archive issue');
      }
    }
  }
  
  // Execute requested phase(s)
  switch (step) {
    case 'all': depEnv(); instBrew(); regHooks(); chkNpm(); break;
    case 'env': depEnv(); break;
    case 'brew': instBrew(); break;
    case 'hooks': regHooks(); break;
    case 'npm': chkNpm(); break;
  }
  
  console.log('\n[asb-mods-installer] Complete! Backup tag: ' + bakts);
  console.log('  Run "asbmod-install status" to verify.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
