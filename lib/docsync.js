'use strict';
/*
 * Docs ↔ behaviour coupling (slice P12, plan §10; closes finding F12 "doc truth unguarded").
 *
 * Every claim in docs/wiki is hand-written today, and each one that happens to be correct is correct
 * by luck: nothing fails if `install.js` grows a verb, a flag or an environment variable that the
 * reference page never mentions, or if a page documents a variable the code stopped reading. This
 * module turns the four claims that matter into pure functions over text, so the test suite can fail
 * on the mismatch instead of a user finding it.
 *
 *   verbs        every command in KNOWN_COMMANDS has a row in wiki 04's Commands table
 *   flags        every --flag parseArgv accepts has a row in wiki 04's Flags table
 *   env vars     ASB_MODS_* read by code ⊆ documented, and documented ⊆ read by code
 *   payload dirs every shared-core/* subtree has a heading in wiki 06
 *   phases       no "Phase N" number in docs disagrees with the banner in install.js
 *   install story  no doc may advertise an `@asbmods/install` npm/npx route while publishing is parked
 *
 * Read-only, zero deps. `audit(repoDir)` returns { ok, findings: [{ check, message }] }.
 */
const fs = require('fs');
const path = require('path');

// Docs allowed to name the npm route once publishing happens. Empty today on purpose: @asbmods/install
// is not published, so any doc naming `npm i -g @asbmods/install` is describing a route no user can take.
const NPM_ROUTE_ALLOW = [];

// Some subtrees are documented on their own page rather than in wiki 06. That is fine as long as the
// named page really covers the directory — checked below, so a pointer to a page that never mentions
// the subtree cannot count as documentation.
const CROSS_PAGE = { tooling: 'docs/wiki/07-personal-tooling-vendoring.md' };

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

function verbsInCode(installerSrc) {
  const m = installerSrc.match(/const KNOWN_COMMANDS\s*=\s*\[([\s\S]*?)\];/);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function verbsInDocs(wikiCli) {
  return [...wikiCli.matchAll(/^\|\s*`([a-z][a-z-]*)`(?:\s*\((?:default|[^)]*)\))?\s*\|/gm)].map((m) => m[1]);
}

function flagsInCode(installerSrc) {
  const body = installerSrc.match(/function parseArgv\([\s\S]*?\n\}/);
  const src = body ? body[0] : installerSrc;
  return [...new Set([...src.matchAll(/a === '(--[a-z][a-z0-9-]*)'/g)].map((m) => m[1]))].sort();
}

function flagsInDocs(wikiCli) {
  return [...new Set([...wikiCli.matchAll(/`(--[a-z][a-z0-9-]*)`/g)].map((m) => m[1]))].sort();
}

function envVarsIn(src) {
  return [...new Set([...src.matchAll(/\b(ASB_MODS_[A-Z0-9_]+|ASBMODS_[A-Z0-9_]+)\b/g)].map((m) => m[1]))].sort();
}

function envVarsInDocs(wikiCli) {
  const rows = [...wikiCli.matchAll(/^\|\s*`(ASB_?MODS_[A-Z0-9_]+)`\s*\|/gm)].map((m) => m[1]);
  return [...new Set(rows)].sort();
}

function phaseNumbersInCode(installerSrc) {
  // Banners are the truth about phase numbering: banner('Phase 4b — npm globals from manifest').
  return [...new Set([...installerSrc.matchAll(/banner\('Phase (\d+[a-z]?)\b/g)].map((m) => m[1]))].sort();
}

function phaseNumbersInDocs(wikiPhases) {
  return [...new Set([...wikiPhases.matchAll(/^#{1,4}\s+Phase\s+(\d+[a-z]?)(?:\s|—|-|:|$)/gm)].map((m) => m[1]))].sort();
}

function payloadDirs(coreDir) {
  if (!fs.existsSync(coreDir)) return [];
  return fs.readdirSync(coreDir).filter((e) => {
    try { return fs.statSync(path.join(coreDir, e)).isDirectory(); } catch { return false; }
  }).sort();
}

// A subtree counts as documented when some heading names it, including a combined heading such as
// "## `prompts/` and `skills/canonical/`" — what matters is that a reader can find the page section.
function documentedPayloadDirs(wikiCore) {
  const found = new Set();
  for (const line of wikiCore.split('\n')) {
    if (!/^#{1,4}\s/.test(line)) continue;
    for (const m of line.matchAll(/`([a-z][a-z0-9-]*)\//g)) found.add(m[1]);
  }
  return [...found].sort();
}

/*
 * Which npm/npx mentions are a lie. Only a runnable example can send a user to a command that 404s, so
 * a mention in prose is never an instruction: "`npx @asbmods/install` (bare name) does not work — the
 * package is not published" is documentation and stays, and so does a fenced block that shows the E404.
 * What gets flagged is an instruction — a line in command position, or a fenced block nowhere in which
 * anything negates the route — because that is what a reader will paste.
 */
const MENTIONS_ROUTE = /@asbmods\/install/;
const RUNS_NPM = /\b(npm (?:i|install|add|view)|npx)\b/;
const COMMAND_POSITION = /^\s*(?:\$ )?(?:npm (?:i|install|add|view)|npx)\b/;
const SELF_NEGATING = /(not published|does ?n.t work|404|E404|until (?:it is |the )?publish|once published|after publishing|will start working|fails|not yet)/i;

function npmRouteClaims(docTexts) {
  const hits = [];
  for (const [name, text] of Object.entries(docTexts)) {
    if (NPM_ROUTE_ALLOW.includes(name)) continue;
    const lines = text.split('\n');
    let fenceStart = -1;
    // A fenced block is judged as a unit: `npm view @asbmods/install` followed by `E404` documents the
    // failure, while the same command with an npm error absent tells the reader to go run it.
    const flushFence = (from, to) => {
      const block = lines.slice(from + 1, to);
      if (!block.some((l) => MENTIONS_ROUTE.test(l) && RUNS_NPM.test(l))) return;
      if (block.some((l) => SELF_NEGATING.test(l))) return;
      block.forEach((l, i) => { if (MENTIONS_ROUTE.test(l) && RUNS_NPM.test(l)) hits.push(`${name}:${from + i + 2}: ${l.trim().slice(0, 110)}`); });
    };
    lines.forEach((line, i) => {
      if (/^\s*```/.test(line)) {
        if (fenceStart === -1) fenceStart = i; else { flushFence(fenceStart, i); fenceStart = -1; }
        return;
      }
      if (fenceStart !== -1) return;                        // its block decides
      if (!MENTIONS_ROUTE.test(line) || !RUNS_NPM.test(line)) return;
      if (!COMMAND_POSITION.test(line)) return;             // prose is not an instruction to run
      if (SELF_NEGATING.test(line)) return;
      hits.push(`${name}:${i + 1}: ${line.trim().slice(0, 110)}`);
    });
    if (fenceStart !== -1) flushFence(fenceStart, lines.length); // unterminated fence at EOF
  }
  return hits;
}

function audit(repoDir) {
  const findings = [];
  const add = (check, message) => findings.push({ check, message });
  const installerSrc = read(path.join(repoDir, 'install.js'));
  const wikiCli = read(path.join(repoDir, 'docs/wiki/04-cli-reference.md'));
  const wikiPhases = read(path.join(repoDir, 'docs/wiki/03-phases.md'));
  const wikiCore = read(path.join(repoDir, 'docs/wiki/06-shared-core-reference.md'));

  const codeVerbs = verbsInCode(installerSrc);
  if (!codeVerbs) add('verbs', 'could not find KNOWN_COMMANDS in install.js — the verb guard is blind');
  else {
    const docVerbs = new Set(verbsInDocs(wikiCli));
    for (const v of codeVerbs) if (!docVerbs.has(v)) add('verbs', `command "${v}" exists in code but has no row in docs/wiki/04-cli-reference.md Commands table`);
    for (const v of docVerbs) if (!codeVerbs.includes(v)) add('verbs', `docs/wiki/04-cli-reference.md documents command "${v}" that code rejects as unknown`);
  }

  const codeFlags = flagsInCode(installerSrc);
  const docFlags = new Set(flagsInDocs(wikiCli));
  for (const f of codeFlags) if (!docFlags.has(f)) add('flags', `flag ${f} is parsed but not in docs/wiki/04-cli-reference.md Flags table`);

  const codeVars = new Set(envVarsIn([installerSrc, ...fs.readdirSync(path.join(repoDir, 'lib')).filter((f) => f.endsWith('.js')).map((f) => read(path.join(repoDir, 'lib', f)))].join('\n')));
  const docVars = envVarsInDocs(wikiCli);
  for (const v of codeVars) if (!docVars.includes(v)) add('env', `${v} is read by code but has no row in docs/wiki/04-cli-reference.md Environment variables`);
  const codeText = [installerSrc, ...fs.readdirSync(path.join(repoDir, 'lib')).filter((f) => f.endsWith('.js')).map((f) => read(path.join(repoDir, 'lib', f)))].join('\n');
  for (const v of docVars) if (!codeVars.has(v) && !codeText.includes(v)) add('env', `docs/wiki/04-cli-reference.md documents ${v}, which no code reads any more`);

  const dirs = payloadDirs(path.join(repoDir, 'shared-core'));
  const docDirs = new Set(documentedPayloadDirs(wikiCore));
  for (const d of dirs) {
    if (docDirs.has(d)) continue;
    const other = CROSS_PAGE[d];
    if (other) {
      // Pointing elsewhere is allowed, but the page named has to actually cover the subtree.
      if (!read(path.join(repoDir, other)).includes(`${d}/`)) add('payload-dirs', `shared-core/${d}/ is pointed at ${other}, which never names "${d}/"`);
      continue;
    }
    add('payload-dirs', `shared-core/${d}/ has no section in docs/wiki/06-shared-core-reference.md and no cross-page owner`);
  }

  const codePhases = phaseNumbersInCode(installerSrc);
  const docPhases = new Set(phaseNumbersInDocs(wikiPhases));
  for (const p of codePhases) if (!docPhases.has(p)) add('phases', `install.js runs "Phase ${p}" but docs/wiki/03-phases.md has no such heading`);

  const docTexts = {};
  const docsDir = path.join(repoDir, 'docs/wiki');
  if (fs.existsSync(docsDir)) {
    for (const f of fs.readdirSync(docsDir).filter((f) => f.endsWith('.md'))) docTexts[`docs/wiki/${f}`] = read(path.join(docsDir, f));
  }
  docTexts['README.md'] = read(path.join(repoDir, 'README.md'));
  for (const hit of npmRouteClaims(docTexts)) {
    add('install-story', `doc names an npm/npx route to @asbmods/install that no user can take (publishing is parked; the from-source path is the truth): ${hit}`);
  }

  return { ok: findings.length === 0, findings, counts: { codeVerbs: codeVerbs ? codeVerbs.length : 0, codeFlags: codeFlags.length, codeVars: codeVars.size, docVars: docVars.length, dirs: dirs.length, codePhases: codePhases.length } };
}

module.exports = { audit, verbsInCode, verbsInDocs, flagsInCode, flagsInDocs, envVarsIn, envVarsInDocs, phaseNumbersInCode, phaseNumbersInDocs, payloadDirs, documentedPayloadDirs, npmRouteClaims, NPM_ROUTE_ALLOW };
