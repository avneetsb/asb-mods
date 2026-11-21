#!/usr/bin/env node
'use strict';
// Sec 1 packaging contract (plan/2026-11-21_agent-compat-040.md §1, slice `P` row for package layout).
//
// Three things this refuses to let rot, each one measured rather than asserted:
//
//  1. **The allowlist is real.** `package.json` → `files` must name the runtime trees. Before this
//     check existed there was no `files` array at all, so the published artifact was whatever
//     `.npmignore` failed to exclude — dev-only code included, and nothing said which trees are
//     load-bearing.
//  2. **Everything the package needs is in it.** Every file under `lib/`, `scripts/` and
//     `shared-core/` on disk has to appear in the pack inventory. A new payload directory that
//     `files` does not reach (or an `.npmignore` rule that quietly swallows one) fails here instead
//     of failing on someone's fresh machine.
//  3. **The tarball numbers in the docs are true.** `docs/wiki/15-release-and-publishing.md` carries a
//     measured "Tarball shape" row. It was stale (it claimed 233 files; `npm pack` produced 241) and
//     no test noticed, because nothing compared the number to the artifact. Now the comparison is the
//     check: change the payload, the row goes red until it is re-measured.
//
// §1's tree also names paths that do not exist yet (lib/mcp.js, shared-core/mcp/servers.json …). They
// are listed in PLAN_ONE_PATHS below, and each is only required *once it exists on disk* — so the
// slice that lands lib/mcp.js inherits this guard automatically instead of having to remember to add
// one. Paths §1 says are runtime state rather than payload (`state/*.json`) are deliberately absent:
// nothing may ship a pre-populated state directory.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { MANIFEST_NAME, skipPath } = require('../lib/payload');

const REPO = path.resolve(__dirname, '..');
const REQUIRED_TREES = ['lib/', 'shared-core/', 'scripts/'];

// Mirrors plan §1's tree. Value is the repo-relative path that file becomes when it lands.
const PLAN_ONE_PATHS = {
  'shared-core/mcp/servers.json': 'shared-core/mcp/servers.json',
  'shared-core/toolchain/tools.json': 'shared-core/toolchain/tools.json',
  'shared-core/.claude-plugin/marketplace.json': 'shared-core/.claude-plugin/marketplace.json',
  'lib/mcp.js': 'lib/mcp.js',
  'lib/toolchain.js': 'lib/toolchain.js',
  'lib/skillsbridge.js': 'lib/skillsbridge.js',
  'lib/claudeplugin.js': 'lib/claudeplugin.js',
  'lib/state.js': 'lib/state.js',
};

// Must never reach a published artifact. `plan/` and `policy.local.json` are already in .npmignore;
// naming them here means a re-arranged ignore file is caught rather than trusted.
const FORBIDDEN = [/^plan\//, /^node_modules\//, /^\.git\//, /\.tgz$/, /policy\.local\.json$/, /^backups\//, /^test\//, /^tools\//];

// npm refuses to pack these names regardless of `files` — measured here, a payload file named
// `npm/.npmrc` never appeared in the artifact, which is why it is now `npm/registry.conf`. As ignore
// machinery they are exempt from the completeness pass below; a *payload* file carrying one of these
// names is a real defect, and the shared-core inventory pass is what reports that.
const IGNORE_MACHINERY = ['.npmignore', '.gitignore'];

function inventoryFromPack(repoDir) {
  const r = cp.spawnSync('npm', ['pack', '--dry-run', '--json'],
    { cwd: repoDir, encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`npm pack --dry-run exited ${r.status}: ${(r.stderr || '').slice(0, 400)}`);
  const parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf('[')));
  return { files: parsed[0].files.map((f) => f.path), packedBytes: parsed[0].size, name: parsed[0].name, version: parsed[0].version };
}

function filesOnDisk(repoDir, tree) {
  const root = path.join(repoDir, tree);
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out.push(path.relative(repoDir, abs).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

// The doc row reads: "| Tarball shape (re-measure any payload change) | 233 files; 478.8 kB packed …".
function docTarballClaim(docText) {
  const row = (docText.split('\n').find((l) => /Tarball shape/.test(l)) || '');
  const m = row.match(/(\d+)\s+files/);
  return { row, claimedFiles: m ? Number(m[1]) : null };
}

function check({ repoDir = REPO, inventory, docText, pkg }) {
  const problems = [];
  const inv = inventory || inventoryFromPack(repoDir);
  const manifest = pkg || JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'));
  const invSet = new Set(inv.files);

  if (!Array.isArray(manifest.files) || !manifest.files.length) {
    problems.push('package.json has no "files" array: the artifact is defined by what .npmignore fails to exclude');
  } else {
    for (const t of REQUIRED_TREES) {
      const hit = manifest.files.some((f) => f === t || f === t.replace(/\/$/, '') || f.replace(/\/$/, '') === t.replace(/\/$/, ''));
      if (!hit) problems.push(`package.json "files" does not name ${t} — nothing in it ships`);
    }
  }

  // Payload completeness: the artifact must contain every file in the trees it claims to own.
  for (const t of REQUIRED_TREES) {
    for (const f of filesOnDisk(repoDir, t)) {
      // One definition of "not part of the packaged inventory", shared with the payload walker in
      // lib/payload.js: the inventory itself, per-machine scratch, the untracked machine-local
      // vocabulary override, and dotfile ignore machinery npm strips whatever `files` says.
      if (IGNORE_MACHINERY.includes(path.basename(f)) || skipPath(f.replace(/^shared-core\//, ''))) continue;
      if (!invSet.has(f)) problems.push(`${f} exists on disk but is not in the tarball`);
    }
  }

  // shared-core's own inventory is what the installer holds itself to, so every path it names has to
  // be in the artifact. This is the pass that reports a payload file npm dropped on the floor (it
  // strips some names whatever `files` says), and it is the same list the install-time missing-file
  // guard refuses on — so "the tarball is missing a file" fails here rather than on a stranger's
  // half-installed machine.
  const manifestRel = `shared-core/${MANIFEST_NAME}`;
  if (fs.existsSync(path.join(repoDir, manifestRel))) {
    const lines = fs.readFileSync(path.join(repoDir, manifestRel), 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^[0-9a-f]{64}\s+\.\/(.+)$/);
      if (!m) continue;
      const rel = `shared-core/${m[1]}`;
      if (IGNORE_MACHINERY.includes(path.basename(rel))) continue;
      if (!invSet.has(rel)) problems.push(`${rel} is listed in ${manifestRel} but absent from the tarball — npm strips some names regardless of "files", so rename it`);
    }
  }

  // §1 paths that exist must be packed; ones not written yet are simply not applicable.
  const planOne = [];
  for (const [named, rel] of Object.entries(PLAN_ONE_PATHS)) {
    if (!fs.existsSync(path.join(repoDir, rel))) continue;
    planOne.push(rel);
    if (!invSet.has(rel)) problems.push(`plan §1 path ${named} exists but is not packed`);
  }

  for (const f of inv.files) {
    for (const re of FORBIDDEN) {
      if (re.test(f)) problems.push(`tarball contains ${f}, which matches the forbidden pattern ${re}`);
    }
  }

  // The measured claim in the release page.
  const docs = docText !== undefined ? docText
    : (fs.existsSync(path.join(repoDir, 'docs/wiki/15-release-and-publishing.md'))
      ? fs.readFileSync(path.join(repoDir, 'docs/wiki/15-release-and-publishing.md'), 'utf8') : '');
  const claim = docTarballClaim(docs);
    // Checked against whatever inventory is in hand, injected or measured, so a test can prove the
  // comparison bites without paying for another `npm pack`.
  if (docs) {
    if (claim.claimedFiles === null) problems.push('docs/wiki/15-release-and-publishing.md has no "Tarball shape … N files" row to check');
    else if (claim.claimedFiles !== inv.files.length) {
      problems.push(`docs/wiki/15 says ${claim.claimedFiles} tarball files; npm pack produced ${inv.files.length} — re-measure the row`);
    }
  }

  // A scoped name becomes a flattened filename on disk, and wiki 15 quotes that filename.
  const artifact = `${inv.name.replace(/^@/, '').replace(/\//g, '-')}-${inv.version}.tgz`;
  return { ok: problems.length === 0, problems, packedFiles: inv.files.length, packedBytes: inv.packedBytes, artifact, planOnePresent: planOne };
}

if (require.main === module) {
  const asJson = process.argv.includes('--json');
  let res;
  try {
    res = check({});
  } catch (err) {
    console.error(`[pack-coverage] could not measure the artifact: ${err.message}`);
    process.exit(2);
  }
  if (asJson) console.log(JSON.stringify(res, null, 2));
  else {
    if (res.ok) console.log(`[pack-coverage] ok — ${res.packedFiles} files, ${(res.packedBytes / 1024).toFixed(1)} kB packed (${res.artifact}); §1 paths already on disk: ${res.planOnePresent.length}`);
    else for (const p of res.problems) console.error(`[pack-coverage] ${p}`);
  }
  process.exit(res.ok ? 0 : 1);
}

module.exports = { check, filesOnDisk, docTarballClaim, REQUIRED_TREES, PLAN_ONE_PATHS, FORBIDDEN, inventoryFromPack };
