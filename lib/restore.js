'use strict';
// Restore what the cutover removed. Two levels:
//   restoreRemoved()  — replays a removal report, putting each deleted artifact back from
//                       the archive copy (scoped, fast).
//   restoreAgents()   — full-directory restore from the archive, matching the previous
//                       rollback.sh behaviour, for when a merge went wrong.

const path = require('path');
const fs = require('fs');
const P = require('./paths');
const X = require('./fsx');
const { latestArchive, listArchives } = require('./archive');

function removalReports() {
  if (!X.isDir(P.REPORT_DIR)) return [];
  return fs.readdirSync(P.REPORT_DIR)
    .filter((n) => n.startsWith('removal-') && n.endsWith('.json'))
    .map((n) => ({ name: n, p: path.join(P.REPORT_DIR, n), data: X.readJSON(path.join(P.REPORT_DIR, n), null) }))
    .filter((r) => r.data && Array.isArray(r.data.removed))
    .sort((a, b) => (a.data.at < b.data.at ? 1 : -1));
}

function restoreRemoved(opts, log) {
  const reports = removalReports();
  if (!reports.length) { if (log) log('warn', 'no removal reports found — nothing scoped to restore'); return { restored: [], reason: 'no reports' }; }
  const report = opts.reportName ? reports.find((r) => r.name === opts.reportName) : reports[0];
  if (!report) return { restored: [], reason: 'named report not found' };
  const { data } = report;
  if (data.dryRun) return { restored: [], reason: 'that run was a dry-run; nothing was removed' };

  const archive = latestArchive();
  if (!archive || !X.isDir(archive.dir)) return { restored: [], reason: 'archive directory missing' };

  const restored = [];
  const failed = [];
  for (const item of data.removed) {
    const rel = path.relative(P.HOME, item.path);
    // The archive stored each agent's directory contents under <stamp>/<agent>/...
    const candidates = [
      path.join(archive.dir, item.agent, rel),
      path.join(archive.dir, item.agent, rel.replace(/^[^/]+\/agent\//, '')),
      item.archivedTo,
    ].filter(Boolean);
    const src = candidates.find(X.exists);
    if (!src) { failed.push({ path: item.path, reason: 'not present in archive' }); continue; }
    try {
      X.copy(src, item.path);
      restored.push({ path: item.path, from: src, kind: item.kind, agent: item.agent });
      if (log) log('ok', `restored ${item.agent}/${item.kind}: ${rel}`);
    } catch (err) {
      failed.push({ path: item.path, reason: err.message.split('\n')[0] });
      if (log) log('err', `restore failed ${item.path}: ${err.message.split('\n')[0]}`);
    }
  }
  X.writeJSON(path.join(P.REPORT_DIR, `restore-${Date.now()}.json`), { at: new Date().toISOString(), fromReport: report.name, restored, failed });
  return { restored, failed, fromReport: report.name };
}

function restoreAgents(log, only) {
  const archive = latestArchive();
  if (!archive) { if (log) log('err', 'no backups found'); return { error: 'no backups' }; }
  const wanted = only && only.length ? only : ['pi', 'claude', 'codex'];
  const done = [];
  for (const agent of wanted) {
    const src = path.join(archive.dir, agent);
    if (!X.isDir(src)) { if (log) log('warn', `${agent}: no copy in ${archive.stamp}`); continue; }
    const dest = P.agents[agent] ? (P.agents[agent].agentDir || P.agents[agent].dir) : null;
    if (!dest) continue;
    X.copy(src, dest);
    done.push({ agent, from: src, to: dest });
    if (log) log('ok', `${agent} restored from ${archive.stamp}`);
  }
  return { archive: archive.stamp, restored: done, archives: listArchives() };
}

module.exports = { restoreRemoved, restoreAgents, removalReports };
