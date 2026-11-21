#!/usr/bin/env node
'use strict';
/*
 * Pack-time placeholder-token lint (slice P5, plan §10; closes limitation 29 / finding F13).
 *
 * The payload shared-core/** ships {{TOKEN}} placeholders that the installer substitutes per run.
 * Until now nothing checked that vocabulary: a payload file carrying {{WORKSPACE_DIR}} — a token no
 * module resolves — would ship, deploy, and land on the target machine as a literal string, which is
 * both wrong and silent. Here the vocabulary has exactly one owner, lib/fsx.js PLACEHOLDER_TOKENS
 * (the key set X.vars() emits), so a token added to a payload file without wiring it into the factory
 * fails the pack.
 *
 * Zero dependencies, Node 18+, safe in CI: reads only, writes nothing.
 *   node scripts/check-payload-tokens.cjs [--core=<dir>] [--json] [--allow=TOKEN,TOKEN]
 * exits 0 clean, 1 on an unknown token or on a scan that proved nothing (an empty file set is a
 * failure, never a pass — limitation 38).
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const { PLACEHOLDER_TOKENS } = require(path.join(REPO, 'lib/fsx.js'));

const args = process.argv.slice(2);
const flagVal = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const CORE = path.resolve(flagVal('core', path.join(REPO, 'shared-core')));
const AS_JSON = args.includes('--json');
const EXTRA_ALLOW = flagVal('allow', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const SKIP_DIRS = new Set(['.git', 'node_modules', 'test-tmp', '.asbtmp']);
// Anything a human or an installer edits counts as text; a NUL byte in the head demotes a file to binary.
const TEXT_EXT = new Set([
  '.json', '.md', '.sh', '.bash', '.zsh', '.js', '.cjs', '.mjs', '.ts', '.toml',
  '.yaml', '.yml', '.txt', '.env', '.ini', '.cfg', '.conf', '.ps1', '.py', '.rb', '.html',
]);
const TOKEN_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

function isTextCandidate(rel) {
  const ext = path.extname(rel);
  return ext === '' || TEXT_EXT.has(ext.toLowerCase());
}

function walk(dir, rel, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.DS_Store' || SKIP_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(abs, r, out);
    else if (e.isFile()) out.push({ abs, rel: r });
  }
  return out;
}

const findings = [];
let filesScanned = 0;
let tokenHits = 0;
const scanError = [];

if (!fs.existsSync(CORE) || !fs.statSync(CORE).isDirectory()) {
  scanError.push(`core directory not found: ${CORE}`);
} else {
  for (const { abs, rel } of walk(CORE, '', [])) {
    if (!isTextCandidate(rel)) continue;
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch (err) {
      scanError.push(`unreadable ${rel}: ${err.message}`);
      continue;
    }
    if (buf.subarray(0, 8192).includes(0)) continue; // binary payload (image, db, archive)
    filesScanned += 1;
    const text = buf.toString('utf8');
    TOKEN_RE.lastIndex = 0;
    let m;
    let line = 1;
    let last = 0;
    while ((m = TOKEN_RE.exec(text)) !== null) {
      tokenHits += 1;
      line += text.slice(last, m.index).split('\n').length - 1;
      last = m.index;
      if (!PLACEHOLDER_TOKENS.includes(m[1]) && !EXTRA_ALLOW.includes(m[1])) {
        findings.push({ file: rel, line, token: m[1], snippet: m[0] });
      }
    }
  }
}

// An empty scan proves nothing: a moved or renamed payload would otherwise look clean forever.
if (!scanError.length && filesScanned === 0) scanError.push(`no text files found under ${CORE} — the lint scanned nothing`);
if (!scanError.length && tokenHits === 0 && filesScanned > 0) {
  scanError.push(`scanned ${filesScanned} files and found zero {{TOKEN}} placeholders — the payload vocabulary vanished (core path wrong?)`);
}

const ok = !findings.length && !scanError.length;
if (AS_JSON) {
  console.log(JSON.stringify({ ok, core: CORE, filesScanned, tokenHits, allowed: PLACEHOLDER_TOKENS, extraAllow: EXTRA_ALLOW, findings, scanError }, null, 2));
} else {
  console.log(`payload token lint: ${filesScanned} file(s), ${tokenHits} placeholder(s), vocabulary ${PLACEHOLDER_TOKENS.join('/')}${EXTRA_ALLOW.length ? ` +${EXTRA_ALLOW.join('/')}` : ''}`);
  for (const f of findings) console.log(`  UNKNOWN TOKEN {{${f.token}}} at ${f.file}:${f.line} — add it to X.vars()/PLACEHOLDER_TOKENS in lib/fsx.js or fix the payload`);
  for (const e of scanError) console.log(`  SCAN ERROR: ${e}`);
  if (ok) console.log('  ok — every placeholder in the payload is resolved by the factory');
}
process.exit(ok ? 0 : 1);
