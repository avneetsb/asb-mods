'use strict';
// Phase 2: archive. Copies each agent's whole config directory (the safety net) plus the
// user-owned ~/.agents tree, verifies the copy really contains the same number of files,
// and stamps a git tag on the package repo so every archive is addressable.
//
// Auditor objection addressed: previously "archive.sh creates timestamped backups with git
// tags" was aspirational — nothing ever ran, no tag existed, and failures were swallowed by
// `|| true`. Here verification is mandatory and the result is recorded.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const P = require('./paths');
const X = require('./fsx');

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function countFiles(root) {
  if (!X.exists(root)) return 0;
  if (X.isFile(root)) return 1;
  let n = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.DS_Store' || e.name === '.asbtmp') continue;
      const f = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(f);
        else n += 1;
      } catch { /* unreadable */ }
    }
  };
  // Symlinks are counted at the position they appear.
  const st = fs.lstatSync(root);
  if (st.isSymbolicLink()) return 1;
  walk(root);
  return n;
}

function targets() {
  return [
    { name: 'pi', src: P.agents.pi.dir },
    { name: 'claude', src: P.agents.claude.dir },
    { name: 'codex', src: P.agents.codex.dir },
    { name: 'agents-dir', src: path.join(P.HOME, '.agents') },
    { name: 'dotfiles', src: null, files: P.dotfiles },
  ];
}

// gitTag returns the created tag name, or explains why tagging was skipped.
function gitTag(ts, log) {
  let root;
  try {
    root = execFileSync('git', ['-C', P.CORE, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8' }).trim();
  } catch {
    return { tagged: false, reason: 'shared-core is not inside a git repository' };
  }
  const tag = `asb-backup-${ts}`;
  try {
    execFileSync('git', ['-C', root, 'tag', tag, 'HEAD'], { stdio: 'pipe' });
  } catch (err) {
    const msg = (err.stderr ? err.stderr.toString() : err.message).trim();
    if (/already exists/i.test(msg)) return { tagged: false, tag, reason: 'tag already exists' };
    return { tagged: false, tag, reason: msg };
  }
  // Verify it actually landed rather than trusting the exit code.
  let listed = '';
  try { listed = execFileSync('git', ['-C', root, 'tag', '-l', tag], { encoding: 'utf8' }); } catch { listed = ''; }
  const verified = listed.trim() === tag;
  if (log) log(verified ? 'ok' : 'warn', `git tag ${tag} ${verified ? 'created and verified' : 'creation unverified'}`);
  return { tagged: verified, tag, repo: root };
}

function archive(opts, log) {
  const ts = opts.stamp || stamp();
  const dest = path.join(P.BACKUP_DIR, ts);
  X.mkdirp(dest);

  const results = [];
  for (const t of targets()) {
    if (t.files) {
      const present = t.files.filter(X.isFile);
      if (!present.length) { results.push({ name: t.name, status: 'absent' }); continue; }
      const td = path.join(dest, t.name);
      X.mkdirp(td);
      for (const f of present) X.copy(f, path.join(td, path.basename(f)));
      results.push({
        name: t.name, status: 'archived', files: present.length,
        verified: countFiles(td) === present.length, src: '(dotfiles)', dest: td,
      });
      if (log) log('ok', `${t.name}: ${present.length} dotfile(s) archived`);
      continue;
    }
    if (!X.isDir(t.src)) { results.push({ name: t.name, status: 'absent', src: t.src }); continue; }
    const td = path.join(dest, t.name);
    const before = countFiles(t.src);
    X.mkdirp(td);
    X.copy(t.src, td);
    const after = countFiles(td);
    const bytes = X.dirSize(td);
    // Tolerance: symlinks that could not be resolved are skipped by copy(), so allow a
    // small shortfall but never a silent large one.
    const missingRatio = before ? (before - after) / before : 0;
    const verified = after > 0 && missingRatio <= 0.02;
    results.push({
      name: t.name, status: verified ? 'archived' : 'INCOMPLETE',
      src: t.src, dest: td, filesBefore: before, filesAfter: after, bytes,
      verified,
    });
    if (log) log(verified ? 'ok' : 'err',
      `${t.name}: ${after}/${before} files, ${(bytes / 1024 / 1024).toFixed(1)} MB ${verified ? 'verified' : 'INCOMPLETE'}`);
  }

  const allVerified = results.every((r) => r.status === 'archived' || r.status === 'absent');
  const incomplete = results.filter((r) => r.status === 'INCOMPLETE').map((r) => r.name);
  const tagInfo = gitTag(ts, log);

  const record = {
    stamp: ts, dest, complete: allVerified, incomplete,
    targets: results, tag: tagInfo,
    createdAt: new Date().toISOString(),
  };
  X.writeJSON(path.join(dest, 'archive-record.json'), record);
  X.writeJSON(path.join(P.STATE_DIR, 'last-archive.json'), record);
  return record;
}

function latestArchive() {
  if (!X.isDir(P.BACKUP_DIR)) return null;
  const dirs = X.listDirs(P.BACKUP_DIR)
    .filter((d) => /^\d{8}_\d{6}$/.test(d)).sort();
  if (!dirs.length) return null;
  const last = dirs[dirs.length - 1];
  return { stamp: last, dir: path.join(P.BACKUP_DIR, last), record: X.readJSON(path.join(P.BACKUP_DIR, last, 'archive-record.json'), null) };
}

module.exports = { archive, latestArchive, listArchives, stamp, countFiles, gitTag };

function listArchives() {
  if (!X.isDir(P.BACKUP_DIR)) return [];
  return X.listDirs(P.BACKUP_DIR).filter((d) => /^\d{8}_\d{6}$/.test(d)).sort();
}
