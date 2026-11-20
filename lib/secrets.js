'use strict';
// Phase 7 (a.k.a. objective step 5): propagate environment + collect secrets interactively.
//
// The packaged shell-env.sh is deployed to the state dir and sourced from the user's
// shell rc files inside a marked block (idempotent, reversible). Secret VALUES are never
// printed, never logged, and never written to any report — only variable NAMES and a hash
// prefix are recorded, which is what lets `status` verify presence without leaking.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const P = require('./paths');
const X = require('./fsx');

const MARK_BEGIN = '# >>> asb-mods shared environment >>>';
const MARK_END = '# <<< asb-mods shared environment <<<';

function templateVars() {
  const tpl = path.join(P.CORE, 'env', 'secrets.env.template');
  if (!X.isFile(tpl)) return [];
  const out = [];
  for (const line of fs.readFileSync(tpl, 'utf8').split(/\r?\n/)) {
    const comment = line.match(/^\s*#\s*(.+)$/);
    if (comment) { out.push({ _hint: comment[1] }); continue; }
    const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    const prev = out[out.length - 1];
    const hint = prev && prev._hint && !prev.name ? prev._hint : null;
    if (prev && prev._hint && !prev.name) out.pop();
    out.push({ name: m[1], placeholder: m[2].replace(/^["']|["']$/g, ''), hint });
  }
  return out.filter((v) => v.name);
}

// Masked prompt: echoes '*' instead of the typed character.
function askHidden(question) {
  if (!process.stdin.isTTY) return askViaShared(question);
  return new Promise((resolve) => {
    const out = process.stdout;
    let answer = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    out.write(question);
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          out.write('\n');
          return resolve(answer.trim());
        }
        if (ch === '') { if (answer) { answer = answer.slice(0, -1); out.write('\b \b'); } continue; }
        if (ch === '') { process.stdin.setRawMode(false); out.write('\n'); process.exit(130); }
        if (ch >= ' ') { answer += ch; out.write('*'); }
      }
    };
    process.stdin.on('data', onData);
  });
}

// One interface for the whole session. Creating an interface per question is what made
// piped/CI input silently stall: closing the first one leaves every later question
// unresolved, and Node then exits 0 with nothing collected.
let sharedRl = null;
let stdinEnded = false;
function getRl() {
  if (!sharedRl) sharedRl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return sharedRl;
}
function closeRl() {
  if (sharedRl) { sharedRl.close(); sharedRl = null; }
}
function askViaReadline(question) {
  return new Promise((resolve) => {
    const rl = getRl();
    let done = false;
    const onEnd = () => { if (!done) { done = true; stdinEnded = true; resolve(''); } };
    rl.once('close', onEnd);
    rl.question(question, (a) => {
      if (done) return;
      done = true;
      rl.removeListener('close', onEnd);
      resolve((a || '').trim());
    });
  });
}

// Piped/CI input arrives in a single chunk, so readline emits every buffered line at once
// and only the question registered at that instant receives one — the rest are dropped,
// which is why a piped run collected exactly one secret. Split lines ourselves and hand
// them out one per prompt.
const pendingLines = [];
const waitingReaders = [];
let queueStarted = false;
function startLineQueue() {
  if (queueStarted) return;
  queueStarted = true;
  let buf = '';
  const emit = (line) => {
    const waiter = waitingReaders.shift();
    if (waiter) waiter(line); else pendingLines.push(line);
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      emit(buf.slice(0, i).replace(/\r$/, ''));
      buf = buf.slice(i + 1);
    }
  });
  process.stdin.on('end', () => {
    stdinEnded = true;
    if (buf) { emit(buf.replace(/\r$/, '')); buf = ''; }
    while (waitingReaders.length) waitingReaders.shift()('');
  });
}
function nextLine() {
  startLineQueue();
  if (pendingLines.length) return Promise.resolve(pendingLines.shift());
  if (stdinEnded) return Promise.resolve('');
  return new Promise((res) => waitingReaders.push(res));
}

function askViaShared(question) {
  if (process.stdin.isTTY) return askViaReadline(question);
  process.stdout.write(question);
  return nextLine().then((l) => (l || '').trim());
}

function askVisible(question) { return askViaShared(question); }

async function collect(opts = {}, log) {
  const vars = templateVars();
  const target = path.join(P.ENV_DIR, 'secrets.env');
  X.mkdirp(P.ENV_DIR);

  const existing = X.readFrom(target);
  const existingNames = new Set(Object.keys(existing || {}));
  const collected = {};
  const skipped = [];
  const prompted = [];

  for (const v of vars) {
    const isSecret = /KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL/i.test(v.name);
    if (opts.noInput) { skipped.push(v.name); continue; }
    if (existingNames.has(v.name) && !opts.rotateSecrets) {
      if (log) log('info', `${v.name} already set in ${target} — left untouched`);
      skipped.push(v.name);
      continue;
    }
    const hint = v.hint ? ` (${v.hint})` : '';
    const q = `${v.name}${hint} [empty = keep unset]: `;
    if (stdinEnded) { skipped.push(v.name); continue; }
    const value = isSecret ? await askHidden(q) : await askVisible(q);
    if (!value) { skipped.push(v.name); continue; }
    collected[v.name] = value;
    prompted.push(v.name);
  }

  // Release stdin before writing so a piped/CI run cannot hang on the open interface.
  closeRl();
  const merged = { ...(existing || {}), ...collected };
  const lines = [
    '# asb-mods shared secrets — created by @asbmods/install.',
    '# Read by shared-core/env/shell-env.sh. chmod 600. Do not commit.',
    '',
    ...Object.entries(merged).map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`),
    '',
  ];
  fs.writeFileSync(target, lines.join('\n'), { mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch { /* platform without chmod */ }

  // Verification: the file must be readable, 0600, and contain every collected name.
  const st = fs.statSync(target);
  const written = X.readFrom(target);
  const allPresent = Object.keys(collected).every((k) => written && k in written);
  const perms = (st.mode & 0o777).toString(8);

  const record = {
    at: new Date().toISOString(),
    target,
    fileMode: perms,
    namesSet: Object.keys(written).sort(),
    newlyCollected: prompted.sort(),
    skipped: skipped.sort(),
    valuesRecorded: false,
    fingerprints: Object.fromEntries(prompted.sort().map((k) => [k, X.hashString(String(written[k])).slice(0, 12)])),
    verified: allPresent && perms === '600',
  };
  X.writeJSON(path.join(P.REPORT_DIR, `secrets-${Date.now()}.json`), record);
  if (log) log(record.verified ? 'ok' : 'warn', `secrets.env written (mode ${perms}, ${record.namesSet.length} var(s), values not logged)`);
  return record;
}

function deployShellEnv(log, dryRun) {
  const src = path.join(P.CORE, 'env', 'shell-env.sh');
  const dst = path.join(P.ENV_DIR, 'shell-env.sh');
  if (!X.isFile(src)) { if (log) log('err', `packaged shell-env.sh missing at ${src}`); return { error: 'missing' }; }
  if (dryRun) return { dryRun: true, dst };
  X.copy(src, dst);
  try { fs.chmodSync(dst, 0o644); } catch { /* ignore */ }

  const touched = [];
  const block = `\n${MARK_BEGIN}\n[ -f "${dst}" ] && source "${dst}"\n${MARK_END}\n`;
  const created = [];
  // A fresh home has no rc files at all, which made this phase a silent no-op there: with
  // nothing to append to, nothing sourced shell-env.sh. .zshenv is created unconditionally
  // (zsh reads it for non-interactive shells too); the other rc files only on an empty home.
  const anyRc = P.dotfiles.some((rc) => X.isFile(rc));
  for (const rc of P.dotfiles) {
    const base = path.basename(rc);
    if (!X.isFile(rc)) {
      if (!(base === '.zshenv' || !anyRc)) continue;
      X.mkdirp(path.dirname(rc));
      fs.writeFileSync(rc, '', { mode: 0o644 });
      created.push(base);
    }
    const cur = fs.readFileSync(rc, 'utf8');
    if (cur.includes(MARK_BEGIN)) {
      const stripped = cur.replace(new RegExp(`${MARK_BEGIN}[\\s\\S]*${MARK_END}`), `${MARK_BEGIN}\n[ -f "${dst}" ] && source "${dst}"\n${MARK_END}`);
      if (stripped !== cur) { X.backupString(rc, cur); fs.writeFileSync(rc, stripped); touched.push(base); }
      continue;
    }
    X.backupString(rc, cur);
    fs.appendFileSync(rc, block);
    touched.push(base);
  }
  const where = touched.length ? touched.join(', ') : 'no rc files matched';
  const madeNote = created.length ? ', created ' + created.join(', ') : '';
  if (log) log('ok', `shell-env.sh deployed; source block ensured in ${where}${madeNote}`);
  return { dst, touched, created, sourceBlock: { begin: MARK_BEGIN, end: MARK_END } };
}

module.exports = { collect, deployShellEnv, templateVars, MARK_BEGIN, MARK_END };
