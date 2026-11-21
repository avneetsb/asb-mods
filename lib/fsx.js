'use strict';
// Small filesystem helpers shared by every phase. No third-party deps.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); return p; }

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { if (fallback !== undefined) return fallback; throw e; }
}

// Atomic-ish write: temp file then rename, so a crash never leaves a half-written config.
function writeJSON(p, obj, mode) {
  mkdirp(path.dirname(p));
  const tmp = p + '.asbtmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  if (mode !== undefined) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, p);
  return p;
}

function writeFile(p, text, mode) {
  mkdirp(path.dirname(p));
  const tmp = p + '.asbtmp';
  fs.writeFileSync(tmp, text);
  if (mode !== undefined) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, p);
  return p;
}

// Copy a single file or a whole tree, following symlinks (matches `cp -rL`).
function copy(src, dest) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    const resolved = fs.realpathSync(src);
    if (!exists(resolved)) return { skipped: src, reason: 'broken-symlink' };
    return copy(resolved, dest);
  }
  if (st.isDirectory()) {
    mkdirp(dest);
    let n = 0;
    for (const entry of fs.readdirSync(src)) {
      if (entry === '.DS_Store') continue;
      const r = copy(path.join(src, entry), path.join(dest, entry));
      n += (r && r.copied) || 0;
    }
    return { copied: n };
  }
  mkdirp(path.dirname(dest));
  fs.copyFileSync(src, dest);
  try { fs.chmodSync(dest, st.mode & 0o7777); } catch { /* best-effort mode copy */ }
  return { copied: 1 };
}

function rmrf(p) {
  if (!exists(p)) return false;
  fs.rmSync(p, { recursive: true, force: true });
  return !exists(p);
}

function sha256(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.update ? h.digest('hex') : '';
}

function hashString(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function dirSize(p) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(f);
        else if (e.isFile()) total += fs.statSync(f).size;
      } catch { /* unreadable entry: skip */ }
    }
  };
  if (isDir(p)) walk(p);
  else if (isFile(p)) return fs.statSync(p).size;
  return total;
}

function listDirs(p) {
  if (!isDir(p)) return [];
  return fs.readdirSync(p, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

function expandTilde(p) {
  if (typeof p !== 'string') return p;
  // Honours ASB_MODS_HOME so a fixture/target home is respected everywhere.
  const home = process.env.ASB_MODS_HOME || os.homedir();
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

// Read a file as text, or null when absent/unreadable (comparison paths use this).
function readFileSyncSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// Capture the pre-edit contents of a config file into the state dir before overwriting,
// keyed by path hash + timestamp so repeated runs never clobber each other's backup.
function backupString(targetPath, contents) {
  const dir = path.join(path.dirname(STATE_DIR_FALLBACK()), 'asb-mods', 'file-backups');
  mkdirp(dir);
  const key = hashString(path.resolve(targetPath)).slice(0, 12);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `${path.basename(targetPath)}.${key}.${ts}`);
  fs.writeFileSync(dest, contents);
  return dest;
}

// paths.js owns STATE_DIR, but requiring it here would create a cycle, so resolve the
// same location locally.
function STATE_DIR_FALLBACK() {
  const cfg = process.env.XDG_CONFIG_HOME || path.join(process.env.ASB_MODS_HOME || os.homedir(), '.config');
  return cfg;
}

// Parse a KEY="value" style env file into an object (used to read/update secrets.env).
function parseDotEnv(text) {
  const out = {};
  if (!text) return out;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1).replace(/\\"/g, '"');
    }
    out[m[1]] = v;
  }
  return out;
}

function readFrom(p) {
  const text = readFileSyncSafe(p);
  return text === null ? {} : parseDotEnv(text);
}

// Packaged config must not carry one machine's absolute paths. Anything shipped in
// shared-core may use {{HOME}}, {{STATE_DIR}} or {{CORE}}, resolved against the caller's
// paths.js at deploy/registration time (vars passed in so fsx never requires paths).
function resolvePlaceholders(value, vars) {
  if (typeof value === 'string') {
    let out = value;
    for (const [token, replacement] of Object.entries(vars || {})) out = out.split(token).join(replacement);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => resolvePlaceholders(v, vars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolvePlaceholders(v, vars);
    return out;
  }
  return value;
}

// True when shipped text still names a specific home directory (portability check used
// by the test suite to prove packaged data stays machine-independent).
function mentionsHomeDir(text, home) {
  if (typeof text !== 'string' || !home) return false;
  return text.includes(home);
}

// Recursive file list relative to dir (used for prompts/*/ and hooks/bin/).
function filesIn(dir) {
  if (!isDir(dir)) return [];
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.DS_Store') continue;
      const abs = path.join(d, e.name);
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

// The one owner of the payload placeholder vocabulary (plan §10 P5, limitation 29 / F13).
// Every module that resolves {{TOKEN}}s builds its map here, and scripts/check-payload-tokens.cjs
// fails the pack when shared-core ships a token this factory does not emit — so a token added to
// a payload file without wiring it here cannot ship unnoticed. {{NAME}} stays code-side on
// purpose: per-entry destination templates in lib/tooling.js substitute it row by row, and the
// pack lint refuses it inside a payload file.
const PLACEHOLDER_TOKENS = ['HOME', 'STATE_DIR', 'CORE'];

function vars(p, extra) {
  const map = { '{{HOME}}': p.HOME, '{{STATE_DIR}}': p.STATE_DIR, '{{CORE}}': p.CORE };
  return Object.assign(map, extra || {});
}

module.exports = {
  exists, isFile, isDir, mkdirp, readJSON, writeJSON, writeFile,
  copy, rmrf, sha256, hashString, dirSize, listDirs, expandTilde,
  readFileSyncSafe, backupString, parseDotEnv, readFrom,
  resolvePlaceholders, mentionsHomeDir, filesIn,
  vars, PLACEHOLDER_TOKENS,
};
