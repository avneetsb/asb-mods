#!/usr/bin/env node
'use strict';
/*
 * Regenerate shared-core/MANIFEST.sha256 (slice P6). The installer never runs this: it is a
 * build-time step, and the test suite asserts the committed inventory still matches the tree, so a
 * payload edit without regeneration fails CI rather than shipping an inventory that lies.
 *
 *   node tools/make-manifest.js [--core=<dir>] [--check]
 * --check compares and exits 1 with the differing paths instead of writing (used by npm test).
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const P = require(path.join(REPO, 'lib/payload.js'));

const args = process.argv.slice(2);
const hit = args.find((a) => a.startsWith('--core='));
const CORE = path.resolve(hit ? hit.slice(7) : path.join(REPO, 'shared-core'));
const CHECK = args.includes('--check');

if (!fs.existsSync(CORE) || !fs.statSync(CORE).isDirectory()) {
  console.error(`no core directory at ${CORE}`);
  process.exit(1);
}

const target = path.join(CORE, P.MANIFEST_NAME);
const fresh = P.buildManifest(CORE);

if (CHECK) {
  if (!fs.existsSync(target)) {
    console.error(`${P.MANIFEST_NAME} is absent — run node tools/make-manifest.js`);
    process.exit(1);
  }
  const committed = fs.readFileSync(target, 'utf8');
  if (committed === fresh) {
    const { entries } = P.parseManifest(committed);
    console.log(`${P.MANIFEST_NAME} matches the tree (${entries.length} files)`);
    process.exit(0);
  }
  const asMap = (text) => new Map(P.parseManifest(text).entries.map((e) => [e.rel, e.sha]));
  const a = asMap(committed);
  const b = asMap(fresh);
  const diffs = [];
  for (const rel of b.keys()) if (!a.has(rel)) diffs.push(`+ ${rel}`);
  for (const [rel] of a) if (!b.has(rel)) diffs.push(`- ${rel}`);
  for (const [rel, sha] of b) if (a.has(rel) && a.get(rel) !== sha) diffs.push(`~ ${rel}`);
  console.error(`${P.MANIFEST_NAME} is stale — ${diffs.length} path(s) differ:`);
  for (const d of diffs.slice(0, 20)) console.error(`  ${d}`);
  if (diffs.length > 20) console.error(`  … ${diffs.length - 20} more`);
  console.error('fix: node tools/make-manifest.js && git add shared-core/' + P.MANIFEST_NAME);
  process.exit(1);
}

fs.writeFileSync(target, fresh);
const { entries } = P.parseManifest(fresh);
console.log(`wrote ${path.relative(REPO, target)} (${entries.length} files)`);
