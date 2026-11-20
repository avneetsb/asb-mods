'use strict';
// Phase 3: remove the archived custom tooling.
//
// Safety model (this is what makes "completely removes them" safe to run):
//   1. Refuses unless a *verified complete* archive exists for this run.
//   2. Removes only the artifact list produced by detect.js — never an agent root dir,
//      because those hold auth.json / *.sqlite / history.jsonl / session indexes.
//   3. Re-checks the protection denylist at removal time (detection may be stale).
//   4. Every path must resolve inside the target home; anything else is refused.
//   5. Records each removal with its archive location and content hash, so
//      `rollback` restores exactly what was taken.

const fs = require('fs');
const path = require('path');
const P = require('./paths');
const X = require('./fsx');
const { isProtected } = require('./detect');

function insideHome(p) {
  const rel = path.relative(P.HOME, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function snapshotEntry(p) {
  try {
    const st = fs.lstatSync(p);
    if (st.isDirectory()) return { type: 'dir', bytes: X.dirSize(p), sha: null };
    if (st.isSymbolicLink()) return { type: 'symlink', target: fs.readlinkSync(p), sha: null };
    return { type: 'file', bytes: st.size, sha: X.sha256(p).slice(0, 16) };
  } catch { return { type: 'missing' }; }
}

function removeArchived(opts, log) {
  const entries = opts.entries || [];
  const archiveRecord = opts.archiveRecord;

  if (!opts.allowDestructive) {
    return { skipped: true, reason: 'destructive phase not authorised (pass --allow-destructive)', removed: [], refused: [] };
  }
  if (!archiveRecord || !archiveRecord.complete) {
    return {
      skipped: true,
      reason: 'refusing to remove anything before a verified complete archive exists',
      removed: [], refused: entries.map((e) => e.path),
    };
  }

  const removed = [];
  const refused = [];
  const failed = [];

  for (const e of entries) {
    const abs = path.resolve(e.path);
    if (!insideHome(abs)) {
      refused.push({ path: abs, reason: 'outside target home' });
      continue;
    }
    const rel = path.relative(P.HOME, abs);
    if (isProtected(rel) || isProtected(abs)) {
      refused.push({ path: abs, reason: 'protected (live agent state)' });
      continue;
    }
    if (!X.exists(abs) && !fs.existsSync(abs)) {
      refused.push({ path: abs, reason: 'already absent' });
      continue;
    }

    const snap = snapshotEntry(abs);
    // Where the archive holds this file, so rollback knows the source.
    const archivedTo = path.join(archiveRecord.dest, e.agent, rel.replace(/^\.?\/?/, '')
      .replace(new RegExp('^' + e.agent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '') || rel);

    if (opts.dryRun) {
      removed.push({ ...e, path: abs, ...snap, dryRun: true });
      if (log) log('info', `dry-run would remove ${e.agent}/${e.kind}: ${rel}`);
      continue;
    }

    try {
      const ok = X.rmrf(abs);
      if (!ok) throw new Error('rmrf returned false');
      removed.push({ ...e, path: abs, ...snap, archivedTo });
      if (log) log('ok', `removed ${e.agent}/${e.kind}: ${rel}`);
    } catch (err) {
      failed.push({ path: abs, reason: err.message.split('\n')[0] });
      if (log) log('err', `failed to remove ${abs}: ${err.message.split('\n')[0]}`);
    }
  }

  const record = {
    at: new Date().toISOString(),
    archive: archiveRecord.stamp,
    dryRun: !!opts.dryRun,
    removedCount: removed.length,
    refusedCount: refused.length,
    failedCount: failed.length,
    removed, refused, failed,
  };
  X.writeJSON(path.join(P.REPORT_DIR, `removal-${archiveRecord.stamp}.json`), record);
  return record;
}

module.exports = { removeArchived, insideHome };
