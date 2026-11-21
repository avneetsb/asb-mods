'use strict';
/*
 * Payload ownership + integrity (slice P6, plan §10; closes the coupling half of finding F11).
 *
 * shared-core/ is the payload this installer ships and deploys. Two facts about it were never
 * asserted anywhere: (1) which module is responsible for reading each subtree — so a subtree could
 * lose its reader, ship forever, and nobody would notice (config/ has been in exactly that state:
 * three files shipped, documented in wiki 06 and README, read by nothing); and (2) whether the
 * payload on a target machine is the payload that was packaged — until now the only hash taken was
 * at removal time (lib/remove.js), so a silently edited core file was invisible.
 *
 * So: OWNED declares one owner per payload path (readers are listed too, because lib/detect.js
 * legitimately inspects everything), UNREAD is a ratchet for the paths no code reads — it may only
 * shrink, and P7 is what shrinks it — and MANIFEST_NAME holds the packaged inventory in caliper's
 * shape (`<sha256>  ./<posix path>`, sorted) so verify-core can tell `missing` from `changed`.
 * An absent or malformed inventory is an error, never a pass: without it there is no chain to
 * verify against.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MANIFEST_NAME = 'MANIFEST.sha256';

// One owner per path. `owner` is the module that deploys or applies it; `readers` are modules that
// legitimately inspect it without owning it (the detector reports on everything it can find).
const OWNED = [
  { path: 'agents/agnostic', owner: 'lib/deploy.js', readers: ['lib/detect.js'], note: 'agnostic settings fragments merged into every host' },
  { path: 'agents/tool-specific', owner: 'lib/deploy.js', readers: ['lib/detect.js'], note: 'per-host settings-fragment.json, merged per agent' },
  { path: 'brew/formulae.csv', owner: 'lib/brew.js', readers: ['lib/detect.js', 'lib/ledger.js'], note: 'the formula/cask inventory the brew phase reads' },
  { path: 'env/secrets.env.template', owner: 'lib/secrets.js', note: 'drives interactive secret collection' },
  { path: 'env/shell-env.sh', owner: 'lib/secrets.js', note: 'deployed and sourced by the env phase' },
  { path: 'hooks/hooks.json', owner: 'lib/hooks.js', readers: ['lib/detect.js'], note: 'hook definitions flattened per host' },
  { path: 'hooks/bin', owner: 'lib/deploy.js', note: 'hook scripts copied into the state dir' },
  { path: 'npm/manifest.json', owner: 'lib/npmpkgs.js', readers: ['lib/detect.js', 'lib/ledger.js'], note: 'npm globals the npm phase installs' },
  { path: 'npm/agents.json', owner: 'lib/prereqs.js', note: 'agent CLI definitions behind --install-agents' },
  { path: 'prompts/master', owner: 'lib/deploy.js', note: 'shared prompt files deployed into each host prompt dir' },
  { path: 'skills/canonical', owner: 'lib/deploy.js', readers: ['lib/tooling.js'], note: 'canonical SKILL.md trees deployed per host' },
  { path: 'tooling/manifest.json', owner: 'lib/tooling.js', readers: ['lib/detect.js'], note: 'vendored tooling bundles and their destinations' },
  { path: 'tooling/policy.json', owner: 'tools/vendor.js', note: 'class policy the vendoring step applies' },
  { path: 'tooling/policy.local.json', owner: 'tools/vendor.js', note: 'local policy overrides the vendoring step layers on top' },
];

// Everything under here is deployed through the bundle list in tooling/manifest.json, so its owner
// is proven by the manifest naming it — not by a module happening to mention a directory name.
const BUNDLE_TREE = 'tooling';
const BUNDLE_MANIFEST = 'tooling/manifest.json';

// Shipped and documented, read by nothing. Every entry here is a real defect tracked by slice P7;
// the contract test asserts this list matches reality exactly, so it can only shrink.
const UNREAD = [
  // Measured, not guessed: enumerated by walking shared-core/ and asking which module names each path.
  'config/', // agent-overrides.json + agent-overrides/*, migrations.json + migrations/*, settings-schema.json
  'prompts/adapters/', // per-host prompt adapters; lib/deploy.js only reads prompts/master
  'brew/deps.json', // dependency graph beside formulae.csv, named by no module
  'prompts-sync-guide.md', // payload documentation for humans; the installer never opens it
  'skills/README.md', // the tree contract for canonical skills, written for humans; deployment walks skills/canonical/
  'npm/registry.conf', // public-registry statement (renamed from npm/.npmrc, which npm refuses to pack); lib/npmpkgs.js names the path and never passes it to npm
];

// What is *not* part of the packaged inventory, and therefore not promised to a machine that installs
// us. Four classes, each for a reason that has a measured fact behind it:
//   * the inventory itself (it cannot contain its own hash);
//   * per-machine scratch (`.DS_Store`, any `node_modules`);
//   * `tooling/policy.local.json` — untracked machine-local vocabulary. `.npmignore` and a nested
//     `shared-core/tooling/.npmignore` keep it out of the artifact, and a nested ignore still wins
//     inside a `files` allowlist (measured: without that nested file the allowlist put it back);
//   * ignore machinery (`.npmignore`, `.gitignore`) — npm strips dotfile config names from a tarball
//     regardless of `files`, which is why the payload's registry statement is `npm/registry.conf`
//     rather than the `npm/.npmrc` it used to be. An inventory entry the artifact cannot carry is a
//     false promise, so it does not belong in the inventory.
function skipPath(rel) {
  const base = rel.split('/').pop();
  return rel === MANIFEST_NAME || rel.endsWith('.DS_Store') || rel.split('/').includes('node_modules')
    || rel === 'tooling/policy.local.json' || base === '.npmignore' || base === '.gitignore';
}

function walk(dir, rel, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(abs, r, out);
    else if (e.isFile() && !skipPath(r)) out.push({ abs, rel: r });
  }
  return out;
}

const sha256File = (abs) => crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');

// caliper's inventory shape: `"<sha256>  ./<posix path>"`, sorted by path, so a diff of two
// inventories is readable and the format stays parseable by anything that already reads theirs.
function buildManifest(coreDir) {
  const rows = walk(coreDir, '', [])
    .map(({ abs, rel }) => `${sha256File(abs)}  ./${rel.split(path.sep).join('/')}`)
    .sort((a, b) => a.slice(a.indexOf('  ./') + 3).localeCompare(b.slice(b.indexOf('  ./') + 3)));
  return rows.join('\n') + '\n';
}

function parseManifest(text) {
  const entries = [];
  const malformed = [];
  text.split('\n').forEach((line, idx) => {
    if (!line.trim()) return;
    const m = line.match(/^([0-9a-f]{64}) {2}\.\/(.+)$/);
    if (!m) malformed.push(`line ${idx + 1}: ${line.slice(0, 80)}`);
    else entries.push({ sha: m[1], rel: m[2] });
  });
  return { entries, malformed };
}

/*
 * Read-only integrity check of a core directory against its packaged inventory.
 * Verdicts: missing (in the inventory, not on disk), changed (bytes differ), untracked (on disk,
 * never hashed). `inventory: 'ok' | 'absent' | 'malformed'` — an absent or malformed inventory is
 * an error, because there is no chain to verify against.
 */
function verifyCore(coreDir) {
  const checks = [];
  const push = (name, verdict, detail, fix) => checks.push({ name, verdict, detail, fix });
  if (!fs.existsSync(coreDir) || !fs.statSync(coreDir).isDirectory()) {
    push('core-present', 'fail', `no core directory at ${coreDir}`, 'unset ASB_MODS_CORE, or run node tools/vendor.js then re-run');
    return { checks, summary: { missing: 0, changed: 0, untracked: 0, entries: 0 }, inventory: 'absent' };
  }
  const manPath = path.join(coreDir, MANIFEST_NAME);
  if (!fs.existsSync(manPath)) {
    push('inventory-present', 'fail', `${MANIFEST_NAME} absent from ${coreDir}`, 'node tools/make-manifest.js && git add shared-core/' + MANIFEST_NAME);
    return { checks, summary: { missing: 0, changed: 0, untracked: 0, entries: 0 }, inventory: 'absent' };
  }
  const { entries, malformed } = parseManifest(fs.readFileSync(manPath, 'utf8'));
  if (malformed.length) {
    push('inventory-parse', 'fail', `${malformed.length} malformed line(s): ${malformed[0]}`, `regenerate with node tools/make-manifest.js`);
    return { checks, summary: { missing: 0, changed: 0, untracked: 0, entries: entries.length }, inventory: 'malformed' };
  }
  push('inventory-parse', 'pass', `${entries.length} hashed file(s)`, null);

  const seen = new Set();
  let missing = 0;
  let changed = 0;
  for (const e of entries) {
    const abs = path.join(coreDir, ...e.rel.split('/'));
    seen.add(path.normalize(abs));
    if (!fs.existsSync(abs)) {
      missing += 1;
      push(`missing:${e.rel}`, 'fail', 'hashed by the inventory, absent from disk', `restore it from git: git checkout -- shared-core/${e.rel}`);
      continue;
    }
    if (sha256File(abs) !== e.sha) {
      changed += 1;
      push(`changed:${e.rel}`, 'fail', 'bytes differ from the packaged hash', `review the edit, then node tools/make-manifest.js if it was intentional`);
    }
  }
  let untracked = 0;
  for (const { abs, rel } of walk(coreDir, '', [])) {
    if (seen.has(path.normalize(abs))) continue;
    untracked += 1;
    push(`untracked:${rel}`, 'fail', 'present on disk but not in the inventory', `node tools/make-manifest.js so it ships hashed`);
  }
  if (!missing && !changed && !untracked) push('payload-integrity', 'pass', `${entries.length} file(s) match the packaged inventory`, null);
  return { checks, summary: { missing, changed, untracked, entries: entries.length }, inventory: 'ok' };
}

// Coupling report: every top-level subtree must be covered by a declared owner, every declared path
// must exist, and every owner must actually name what it owns. UNREAD is checked exactly, so the
// unread set can only shrink.
function checkCoupling(coreDir) {
  const problems = [];
  const onDisk = fs.existsSync(coreDir) ? fs.readdirSync(coreDir) : [];
  const covered = new Set(OWNED.map((o) => o.path.split('/')[0]).concat(UNREAD.map((u) => u.split('/')[0])));
  for (const subtree of onDisk.sort()) {
    if (!fs.statSync(path.join(coreDir, subtree)).isDirectory()) continue;
    if (covered.has(subtree)) continue;
    problems.push(`shared-core/${subtree}: no declared owner and not listed as unread`);
  }
  const owners = new Map();
  for (const o of OWNED) {
    const key = o.path;
    if (owners.has(key)) problems.push(`${key}: declared owner twice (${owners.get(key)} and ${o.owner})`);
    owners.set(key, o.owner);
    if (!fs.existsSync(path.join(coreDir, ...key.split('/')))) problems.push(`${key}: declared path does not exist under shared-core`);
    const ownerFile = path.join(__dirname, '..', o.owner);
    if (!fs.existsSync(ownerFile)) { problems.push(`${key}: owner module ${o.owner} is gone`); continue; }
    const leaf = key.split('/').pop();
    if (!fs.readFileSync(ownerFile, 'utf8').includes(leaf)) {
      problems.push(`${key}: ${o.owner} never mentions "${leaf}", so it does not read what it claims to own`);
    }
  }
  // A file is owned if it sits under a declared owner path, or if it lives in the vendored tooling
  // tree and tooling/manifest.json names a bundle covering it. The manifest is what actually deploys
  // those files, so ownership there is proven instead of inferred from a module mentioning a name.
  const bundlePaths = [];
  const bundleManifestAbs = path.join(coreDir, ...BUNDLE_MANIFEST.split('/'));
  if (fs.existsSync(bundleManifestAbs)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(bundleManifestAbs, 'utf8'));
      for (const b of manifest.bundles || []) {
        if (typeof b.bundle === 'string') bundlePaths.push(b.bundle.replace(/^shared-core\//, ''));
      }
    } catch (e) {
      problems.push(`${BUNDLE_MANIFEST}: unparseable (${e.message}), so nothing under ${BUNDLE_TREE}/ can be proven owned`);
    }
  } else {
    problems.push(`${BUNDLE_MANIFEST} is absent, so nothing under ${BUNDLE_TREE}/ can be proven owned`);
  }
  const coveredByBundle = (rel) => rel.startsWith(`${BUNDLE_TREE}/`)
    && bundlePaths.some((bp) => rel === bp || rel.startsWith(bp.endsWith('/') ? bp : `${bp}/`));

  const strays = [];
  const unreadHits = new Set();
  for (const { rel } of walk(coreDir, '', [])) {
    if (OWNED.some((o) => rel === o.path || rel.startsWith(`${o.path}/`)) || coveredByBundle(rel)) continue;
    const declared = UNREAD.find((u) => rel === u || rel.startsWith(u.endsWith('/') ? u : `${u}/`));
    if (declared) unreadHits.add(declared);
    else strays.push(rel);
  }
  // A declared-unread prefix that covers nothing any more (wired up, or deleted) must leave the list,
  // otherwise the ratchet quietly permits new unread files under the same name.
  const staleUnread = UNREAD.filter((u) => !unreadHits.has(u));
  return {
    problems,
    strays,
    staleUnread,
    unreadCovered: [...unreadHits].sort(),
    bundlePaths: bundlePaths.length,
    subtrees: onDisk.filter((e) => fs.statSync(path.join(coreDir, e)).isDirectory()),
  };
}

// The install-time missing-file guard (plan §1's "a missing-file guard refuses install"). verifyCore()
// answers "is the payload intact" for a human or CI; this answers the narrower question that has to be
// settled before a run starts: does every file the inventory names actually exist? Absent files stop the
// run because a half-present payload installs *something* — hooks with no definitions, an npm phase with
// no manifest, a brew phase with no inventory — and reports success while doing it.
//
// A missing inventory itself is deliberately NOT reported here: verifyCore() already calls that
// `unverifiable`, and a hand-written payload (a fixture home, a vendored copy) may legitimately have no
// MANIFEST. Refusing on that would make this guard a new failure mode rather than a safety net.
function missingPayloadFiles(coreDir) {
  const manifestPath = path.join(coreDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return { verifiable: false, listed: 0, missing: [] };
  const { entries } = parseManifest(fs.readFileSync(manifestPath, 'utf8'));
  const missing = entries
    .filter((e) => !fs.existsSync(path.join(coreDir, ...e.rel.split('/'))))
    .map((e) => e.rel);
  return { verifiable: true, listed: entries.length, missing };
}

module.exports = { MANIFEST_NAME, OWNED, UNREAD, buildManifest, parseManifest, verifyCore, checkCoupling, missingPayloadFiles, skipPath, walk, sha256File };
