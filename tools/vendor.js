#!/usr/bin/env node
'use strict';
// Vendor the personal tooling that the destructive phase removes into shared-core/tooling/, so
// the package alone can reproduce an environment on a fresh machine.
//
//   node tools/vendor.js [--dry-run] [--clean]
//
// Scope is decided by shared-core/tooling/policy.json, not by this script: personal tooling only,
// dependency trees/caches/scratch never, and nothing that names the author's absolute home path or
// an employer's internal systems. Offending *docs and tests* are dropped from the bundle; an
// offending *source* file excludes the whole bundle, because shipping half a package is worse than
// shipping none. Every exclusion is written into manifest.json, so `asbmods status` and a human
// reviewer can see what a fresh machine will NOT get — and `asbmods reset` still restores it here,
// since the archive is on-machine and predates any of this filtering.

const fs = require('fs');
const path = require('path');
const { CLASSES, manifestPath } = require('../lib/tooling');
const { isProtected } = require('../lib/detect');

const ROOT = path.join(__dirname, '..');
const HOME = process.env.ASB_MODS_HOME || process.env.HOME;
const TOOLING_DIR = path.join(ROOT, 'shared-core', 'tooling');
const POLICY_PATH = path.join(TOOLING_DIR, 'policy.json');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const clean = args.includes('--clean');

const POLICY = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
const SCAN_HOME = HOME; // literal home path is never written into a shipped file
const LOCAL_TERMS = path.join(TOOLING_DIR, 'policy.local.json');
const SCAN_TERMS = (fs.existsSync(LOCAL_TERMS)
  ? (JSON.parse(fs.readFileSync(LOCAL_TERMS, 'utf8')).internalTerms || [])
  : (POLICY.scan.internalTerms || []))
  .map((t) => t.toLowerCase());
if (!SCAN_TERMS.length) {
  process.stderr.write(
    'warning: internal term vocabulary absent — shared-core/tooling/policy.local.json does not exist, ' +
      'so employer-infrastructure screening is inactive (see policy.json scan.internalTermsFile)\n'
  );
}
const SEGMENTS = new Set(POLICY.skipPathSegments);
const DROP_RES = (POLICY.dropInsteadOfBundle || []).map((p) => new RegExp(p, 'i'));
const isDropOnly = (rel) => DROP_RES.some((re) => re.test(rel));

// Dependency trees, caches, scratch and backups are never tooling. The top-level name is checked
// too, otherwise a stray `__pycache__` directory inside .agents/scripts becomes a "bundle".
const SKIP_DIRS = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.git', '.cache',
  'dist', 'build', '.turbo', '.next', 'coverage', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '_scratch', 'scratch', 'logs', 'tmp', '.DS_Store', ...SEGMENTS]);
const EXCLUDE_EXT = /\.(pyc|pyo|log|lock|tmp|swp|bak|pdf|zip|png|jpg|gif|ico|woff2?|sqlite\d*|db|dylib|node|wasm)$/i;
const BACKUP_NAME = /(\.pre-|\.orig$|~$|\.backup\.)/;
const SECRET_FILE = /(secret|credential|token|password|\.pem$|\.key$|id_[a-z0-9]+$)/i;
const MAX_FILE_BYTES = 1024 * 1024;

const offenders = (text) => {
  const hits = [];
  if (text.includes(SCAN_HOME)) hits.push('homePath');
  // *Any* macOS user-home path is machine-specific, not only this machine's $HOME.
  if (/\/Users\/[A-Za-z0-9._-]+\//.test(text)) hits.push('userHomePath');
  const low = text.toLowerCase();
  for (const t of SCAN_TERMS) if (low.includes(t)) hits.push(t);
  return hits;
};

/** Never echo the matched vocabulary into a shipped file: report a category, not the terms. */
const classify = (hits) => (hits.includes('homePath') || hits.includes('userHomePath')
  ? 'a machine home path' : 'an employer-internal reference');

const denied = (cls, name) => (POLICY.denyBundles || [])
  .find((d) => (d.cls === cls || d.cls === '*') && (d.name === '*' || d.name === name));

const walk = (dir, rel, out) => {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (SKIP_DIRS.has(e.name)) continue;
    if (BACKUP_NAME.test(e.name)) continue;
    const fp = path.join(dir, e.name);
    const rp = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { walk(fp, rp, out); continue; }
    if (!e.isFile()) continue;
    if (EXCLUDE_EXT.test(e.name)) continue;
    let st; try { st = fs.statSync(fp); } catch { continue; }
    if (st.size > MAX_FILE_BYTES) continue;
    out.push({ fp, rp, mode: st.mode & 0o777 });
  }
};

const bundles = [];
const excluded = [];
const denials = new Map();
let droppedFiles = 0;
let skippedProtected = 0;

if (clean && !dryRun) {
  for (const sub of fs.readdirSync(TOOLING_DIR)) {
    if (['manifest.json', 'policy.json'].includes(sub)) continue;
    fs.rmSync(path.join(TOOLING_DIR, sub), { recursive: true, force: true });
  }
}

for (const [cls, c] of Object.entries(CLASSES)) {
  if (cls === 'agentsPackages') continue; // same directory as piPackages
  const abs = path.join(HOME, c.srcDir);
  let names = [];
  try { names = fs.readdirSync(abs).sort(); } catch { continue; }

  for (const name of names) {
    if (name === '.DS_Store' || SKIP_DIRS.has(name) || BACKUP_NAME.test(name)) continue;
    if (c.personalList && !(POLICY[c.personalList] || []).includes(name)) {
      const why = POLICY.unlistedNote || 'not declared personal-authored';
      const key = `${cls}\u0000${why}`;
      const agg = denials.get(key) || { cls, reason: why, count: 0, nameDigests: [] };
      agg.count += 1;
      agg.nameDigests.push(require('crypto').createHash('sha1').update(name).digest('hex').slice(0, 8));
      denials.set(key, agg);
      continue;
    }
    const d = denied(cls, name);
    if (d) {
      // The filenames themselves are disclosure (an agent named after an internal system says
      // who the employer is), so denials are aggregated: count + reason + a digest for audit.
      const key = `${cls}\u0000${d.reason}`;
      const agg = denials.get(key) || { cls, reason: d.reason, count: 0, nameDigests: [] };
      agg.count += 1;
      agg.nameDigests.push(require('crypto').createHash('sha1').update(name).digest('hex').slice(0, 8));
      denials.set(key, agg);
      continue;
    }

    const src = path.join(HOME, c.srcDir, name);
    let st; try { st = fs.statSync(src); } catch { continue; }
    if (isProtected(src)) { skippedProtected += 1; continue; }

    const isDir = st.isDirectory();
    if (!isDir && SECRET_FILE.test(name)) { skippedProtected += 1; continue; }
    if (!isDir && c.exts && !c.exts.includes(path.extname(name))) continue;

    const files = [];
    if (isDir) walk(src, '', files);
    else files.push({ fp: src, rp: name, mode: st.mode & 0o777 });
    if (!files.length) continue;

    // content gate: docs/tests are dropped, source offenders exclude the bundle
    let fatal = null;
    const keep = [];
    for (const f of files) {
      let text;
      try { text = fs.readFileSync(f.fp, 'utf8'); } catch { continue; }
      if (text.includes('\u0000')) continue; // binary
      const hits = offenders(text);
      if (!hits.length) { keep.push(f); continue; }
      if (isDropOnly(f.rp)) {
        droppedFiles += 1;
        excluded.push({ cls, name, file: f.rp, reason: `documentation/test carries ${classify(hits)}` });
        continue;
      }
      fatal = { file: f.rp, hits };
      break;
    }
    if (fatal) {
      excluded.push({ cls, name, reason: `source file ${fatal.file} carries ${classify(fatal.hits)}` });
      continue;
    }
    if (!keep.length) { excluded.push({ cls, name, reason: 'nothing left after dropping non-portable files' }); continue; }

    const bundleDir = path.join(TOOLING_DIR, c.bundleRoot.replace(/^shared-core\/tooling\//, ''), name);
    if (!dryRun) {
      fs.rmSync(bundleDir, { recursive: true, force: true });
      for (const f of keep) {
        const dst = path.join(bundleDir, f.rp);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(f.fp, dst);
        try { fs.chmodSync(dst, f.mode); } catch { /* platform without chmod */ }
      }
    }
    bundles.push({
      cls, name,
      bundle: path.relative(ROOT, bundleDir).split(path.sep).join('/'),
      layout: isDir ? 'dir' : c.layout,
      dest: (isDir
        ? (c.destDir || (/\{\{NAME\}\}/.test(c.dest || '') ? c.dest : `${c.dest}/{{NAME}}`))
        : (c.dest || c.destDir.replace(/\/\{\{NAME\}\}$/, ''))).replace('{{NAME}}', name),
      fileCount: keep.length,
      bytes: keep.reduce((n, f) => n + fs.statSync(f.fp).size, 0),
    });
  }
}

for (const v of denials.values()) excluded.push({ cls: v.cls, count: v.count, nameDigests: v.nameDigests, reason: v.reason });

const manifest = {
  generatedAt: new Date().toISOString(),
  generator: 'tools/vendor.js',
  policy: 'shared-core/tooling/policy.json',
  note: 'Regenerate with `node tools/vendor.js`. Dependency trees, caches, scratch, machine state and'
    + ' anything naming the author home path or employer internal systems are never vendored; see the'
    + ' exclusions array. npm globals and shared-core/brew/formulae.csv restore dependencies, and'
    + ' secrets are collected by the installer prompt rather than shipped.',
  totals: {
    bundles: bundles.length,
    files: bundles.reduce((n, x) => n + x.fileCount, 0),
    bytes: bundles.reduce((n, x) => n + x.bytes, 0),
    droppedFiles,
    skippedProtected,
    exclusions: excluded.length,
  },
  byClass: bundles.reduce((acc, b) => {
    acc[b.cls] = acc[b.cls] || { bundles: 0, files: 0 };
    acc[b.cls].bundles += 1; acc[b.cls].files += b.fileCount; return acc;
  }, {}),
  exclusions: excluded.sort((a, b) => (a.cls === b.cls ? String(a.name).localeCompare(b.name) : a.cls.localeCompare(b.cls))),
  bundles: bundles.sort((a, b) => (a.cls === b.cls ? a.name.localeCompare(b.name) : a.cls.localeCompare(b.cls))),
};

if (dryRun) {
  console.log('DRY RUN — would vendor:');
  for (const [k, v] of Object.entries(manifest.byClass)) console.log(`  ${k}: ${v.bundles} bundle(s), ${v.files} files`);
  console.log(`total ${manifest.totals.bundles} bundles, ${manifest.totals.files} files,`
    + ` ${(manifest.totals.bytes / 1048576).toFixed(1)}M | excluded ${excluded.length} (dropped files ${droppedFiles})`);
  for (const e of excluded.filter((x) => !x.file && !x.count)) console.log(`  EXCLUDE ${e.cls}/${e.name}: ${e.reason}`);
  for (const e of excluded.filter((x) => x.count)) console.log(`  EXCLUDE ${e.cls} x${e.count}: ${e.reason}`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(manifestPath()), { recursive: true });
fs.writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2) + '\n');
console.log(`vendored ${manifest.totals.bundles} bundle(s), ${manifest.totals.files} files,`
  + ` ${(manifest.totals.bytes / 1048576).toFixed(1)}M -> ${path.relative(ROOT, TOOLING_DIR)}`);
console.log(`exclusions ${excluded.length} (dropped doc/test files ${droppedFiles}, protected ${skippedProtected}) -> ${path.relative(ROOT, manifestPath())}`);
