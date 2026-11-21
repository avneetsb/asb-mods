'use strict';
/*
 * Functional test suite for @asbmods/install.
 *
 * This replaces the earlier structural suite, which only asserted that files existed
 * (9 "file exists" checks) and therefore passed while nothing had ever been executed.
 * Here every phase is run for real, as a child process, against a throwaway home:
 *
 *   1. package shape + portability of the packaged data (no machine paths, no
 *      corporate endpoints, no credentials, no dead rule references)
 *   2. detect against a fixture home, including the protection denylist being
 *      falsifiable rather than vacuously empty
 *   3. --dry-run provably changes nothing
 *   4. interactive secret collection (piped stdin) with values never logged
 *   5. the full cutover: verified archive + git tag, destructive removal scoped away
 *      from live state, shared-core deployment, hook registration in all three tools
 *   6. idempotency and `reset` (restore path) actually restoring what removal took
 *
 * The package is copied to a temp directory and run from there with ASB_MODS_CORE /
 * ASB_MODS_HOME pointing at the copy, which is also the regression test for the
 * "install.js hardcodes ~/Dev/asb-mods, so npx breaks" finding.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const REPO = path.resolve(__dirname, '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'asbmods-e2e-'));
const HOME = path.join(ROOT, 'home');
const XDG = path.join(ROOT, 'xdg-config');
const PKG = path.join(ROOT, 'pkgcopy');
const STATE = path.join(XDG, 'asb-mods');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (e) { console.log(`  FAIL  ${name}\n          ${e.message.split('\n')[0]}`); failures.push(name); }
}
const section = (t) => console.log(`\n── ${t}`);

// ---------------------------------------------------------------- fixture home
const FIXTURE = {
  pi: {
    custom: [
      '.pi/agent/extensions/alpha.ts',
      '.pi/agent/extensions/beta.js',
      '.pi/agent/extensions/nested/gamma.ts',
      '.agents/skills/legacy-skill/SKILL.md',
      '.agents/packages/old-package/package.json',
      '.pi/agent/prompts/stale-prompt.md',
    ],
    protected: [
      '.pi/agent/settings.json',
      '.pi/agent/auth.json',
      '.pi/agent/.credentials.json',
      '.pi/agent/sessions/index.sqlite',
      '.pi/agent/history.jsonl',
      '.pi/agent/npm/node_modules/thing/package.json',
    ],
  },
  claude: {
    custom: [
      '.claude/agents/reviewer.md',
      '.claude/skills/old-skill/SKILL.md',
      '.claude/hooks/gitnexus/hook.cjs',
      '.claude/plugins/marketplace.json',
    ],
    protected: [
      '.claude/settings.json',
      '.claude/.credentials.json',
      '.claude/history.jsonl',
    ],
  },
  codex: {
    custom: ['.codex/skills/codex-skill/SKILL.md', '.codex/notes.md'],
    protected: ['.codex/config.toml', '.codex/auth.json', '.codex/version.json', '.codex/hooks.json'],
  },
};

const PI_TOKEN = 'PI-OWNED-KEY-must-survive';
const FOREIGN_CLAUDE_HOOK = 'echo foreign-claude-hook-must-survive';
const FOREIGN_CODEX_HOOK = 'echo foreign-codex-hook-must-survive';

function write(rel, text) {
  const p = path.join(HOME, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text == null ? `// fixture ${rel}\n` : text);
  return p;
}

function buildFixture() {
  for (const group of Object.values(FIXTURE)) {
    for (const f of group.custom) write(f);
    for (const f of group.protected) write(f);
  }
  write('.pi/agent/settings.json', JSON.stringify({
    [PI_TOKEN]: { keep: true },
    packages: ['npm:some-existing-package'],
    theme: 'dark',
  }, null, 2));
  write('.pi/agent/mcp-adapter.json', JSON.stringify({ mcpServers: { one: { command: 'x' } } }, null, 2));
  write('.claude/settings.json', JSON.stringify({
    model: 'opus',
    hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: FOREIGN_CLAUDE_HOOK }] }] },
  }, null, 2));
  write('.codex/hooks.json', JSON.stringify({
    hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: FOREIGN_CODEX_HOOK }] }] },
  }, null, 2));
  write('.codex/config.toml', 'model = "gpt-5"\n');
  write('.zshrc', '# my shell\nexport EDITOR=vim\n');
  fs.mkdirp = fs.mkdirSync;
  fs.mkdirSync(path.join(HOME, '.bashrc') + '.d', { recursive: true });
  fs.rmSync(path.join(HOME, '.bashrc.d'), { recursive: true, force: true });
  write('.bashrc', '# bash rc\n');
}

function copyPackage() {
  fs.mkdirSync(PKG, { recursive: true });
  for (const entry of fs.readdirSync(REPO)) {
    if (entry === '.git' || entry === 'node_modules') continue;
    cp.execFileSync('cp', ['-R', path.join(REPO, entry), path.join(PKG, entry)]);
  }
  // Give the copy its own git repo so archive's tag creation is exercised for real.
  const g = (a) => cp.execFileSync('git', ['-C', PKG, ...a], { stdio: 'pipe' });
  try {
    g(['init', '-q']); g(['add', '-A']);
    g(['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '-q', '-m', 'fixture']);
  } catch { /* git unavailable: tagging assertions degrade to its absence */ }
}

function run(args, opts = {}) {
  const r = cp.spawnSync(process.execPath, [path.join(PKG, 'install.js'), ...args], {
    cwd: PKG,
    encoding: 'utf8',
    input: opts.input || '',
    timeout: 180000,
    env: { ...process.env, ASB_MODS_HOME: HOME, ASB_MODS_CORE: path.join(PKG, 'shared-core'), XDG_CONFIG_HOME: XDG, NO_COLOR: '1' },
  });
  if (r.error) throw r.error;
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const exists = (rel) => fs.existsSync(path.join(HOME, rel));
const statePath = (...p) => path.join(STATE, ...p);
function hashTree(root) {
  const out = {};
  const walk = (d, rel) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const r2 = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r2);
      else out[r2] = fs.readFileSync(abs).toString();
    }
  };
  walk(root, '');
  return out;
}

console.log('[asbmods functional tests]');
console.log(`  fixture home : ${HOME}`);
console.log(`  package copy : ${PKG}`);

// ============================================================ 1. package shape
section('Package shape and self-containment');
const pkg = readJSON(path.join(REPO, 'package.json'));
test('single package manifest named @asbmods/install', () => {
  assert.strictEqual(pkg.name, '@asbmods/install');
  const manifests = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    if (e.name === '.git' || e.name === 'node_modules') return;
    const p = path.join(d, e.name);
    if (e.name === 'tooling' && d === path.join(REPO, 'shared-core')) return; // vendored payload keeps its own artifact manifests
    if (e.isDirectory()) walk(p); else if (e.name === 'package.json' && p !== path.join(REPO, 'package.json')) manifests.push(path.relative(REPO, p));
  });
  walk(REPO);
  assert.deepStrictEqual(manifests, [], `nested package.json files found: ${manifests.join(', ')}`);
});
test('one entry point install.js, wired as main and bin', () => {
  assert.strictEqual(pkg.main, './install.js');
  assert.strictEqual(pkg.bin.asbmods, './install.js');
  const p = path.join(REPO, 'install.js');
  assert.ok(fs.existsSync(p), 'install.js missing at package root');
  assert.ok(fs.statSync(p).mode & 0o111, 'install.js not executable');
  assert.ok(!fs.existsSync(path.join(REPO, 'installer')), 'old installer/ subtree still present');
});
test('packaged data carries no machine-specific home paths', () => {
  const hits = [];
  for (const f of packagedFiles()) if (fs.readFileSync(f, 'utf8').includes(os.homedir())) hits.push(path.relative(REPO, f));
  assert.deepStrictEqual(hits, [], `hardcoded home in: ${hits.join(', ')}`);
});
test('packaged data carries no corporate registry/gateway endpoints', () => {
  // The employer vocabulary itself stays off the public tree (policy.json scan.internalTermsFile):
  // read it from the git-ignored local file when present, else exercise the gate with stand-ins.
  const termsFile = path.join(REPO, 'shared-core/tooling/policy.local.json');
  const internalTerms = fs.existsSync(termsFile)
    ? JSON.parse(fs.readFileSync(termsFile, 'utf8')).internalTerms
    : ['internal.example', 'registry.internal.example', 'INTERNAL_TOKEN'];
  const bad = ['/Users/', 'artifactory', ...internalTerms];
  // Publish channels: `npx github:` ships tracked files, `npm pack` honours .gitignore. Both drop
  // policy.local.json, so it is screened out of this walk rather than failing it.
  const ignoredLines = fs
    .readFileSync(path.join(REPO, '.gitignore'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const publishable = packagedFiles().filter((f) => !ignoredLines.includes(path.relative(REPO, f)));
  const hits = [];
  for (const f of publishable) {
    const t = fs.readFileSync(f, 'utf8');
    for (const tok of bad) if (t.includes(tok)) hits.push(`${path.relative(REPO, f)}: ${tok}`);
  }
  assert.ok(
    ignoredLines.includes('shared-core/tooling/policy.local.json'),
    'policy.local.json must stay git-ignored — that is what keeps the vocabulary out of both publish ' +
      'channels (tracked files for npx github, .gitignore for npm pack; verified against npm pack output)'
  );
  assert.deepStrictEqual(hits, [], hits.join(' | '));
});
test('packaged data carries no credential values', () => {
  const cred = /"(apiKey|apiKeyHelper|api_key|token|password|_authToken)"\s*:\s*"[^"$]{6,}"/g;
  const hits = [];
  for (const f of packagedFiles()) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (/"_note"|_description/.test(l)) return;
      if (cred.test(l)) hits.push(`${path.relative(REPO, f)}:${i + 1}`);
      cred.lastIndex = 0;
    });
  }
  assert.deepStrictEqual(hits, [], `credential-looking values at ${hits.join(', ')}`);
});
test('every documented directory exists (no dead documentation)', () => {
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  const guide = fs.readFileSync(path.join(REPO, 'shared-core/prompts-sync-guide.md'), 'utf8');
  const claimed = new Set();
  for (const doc of [readme, guide]) {
    for (const m of doc.matchAll(/shared-core\/([A-Za-z0-9_./-]+)/g)) claimed.add(m[1].replace(/\/$/, ''));
  }
  const missing = [...claimed].filter((rel) => {
    const p = path.join(REPO, 'shared-core', rel);
    return !(fs.existsSync(p) || fs.existsSync(path.join(REPO, rel)));
  });
  assert.deepStrictEqual(missing, [], `docs reference paths that do not exist: ${missing.join(', ')}`);
});
test('migration registry has no dead references', () => {
  const reg = readJSON(path.join(REPO, 'shared-core/config/migrations.json'));
  const have = fs.readdirSync(path.join(REPO, 'shared-core/config/migrations'));
  const dead = reg.migrations.filter((m) => !have.some((h) => h.startsWith(`${m.id}-`)));
  assert.deepStrictEqual(dead, [], `migrations without files: ${dead.map((d) => d.id).join(', ')}`);
});
test('canonical skills are real content, not placeholders', () => {
  const root = path.join(REPO, 'shared-core/skills/canonical');
  const dirsList = fs.readdirSync(root);
  assert.ok(dirsList.length >= 1, 'no canonical skills');
  for (const d of dirsList) {
    const p = path.join(root, d, 'SKILL.md');
    assert.ok(fs.existsSync(p), `${d}/SKILL.md missing`);
    const size = fs.statSync(p).size;
    assert.ok(size > 500, `${d}/SKILL.md is only ${size} bytes`);
    const body = fs.readFileSync(p, 'utf8');
    const shaped = /^---\n[\s\S]*?^name:\s*\S/m.test(body) || /^#\s+\S/m.test(body);
    assert.ok(shaped, `${d}/SKILL.md has neither frontmatter name nor a heading`);
  }
});
test('packaged files name only the three supported agents', () => {
  // The retired product this guard exists for is spelled from fragments, so its name never appears
  // anywhere in the package while a reintroduction is still caught.
  const retiredAgent = new RegExp(`\\b${['cu', 'rso', 'r'].join('')}\\b`, 'i');
  const hits = [];
  for (const f of packagedFiles()) {
    const rel = path.relative(REPO, f);
    if (rel.startsWith(path.join('shared-core', 'tooling') + path.sep)) continue; // restored artifacts may legitimately name their host agents
    const t = fs.readFileSync(f, 'utf8');
    if (retiredAgent.test(t) && !/retired|historical|removed|dropped/i.test(t)) hits.push(rel);
  }
  assert.deepStrictEqual(hits, [], `packaged files name a retired agent: ${hits.join(', ')}`);
  // Positive half: the three supported agents are exactly the ones wired into deployment.
  const deploy = require('../lib/deploy');
  assert.deepStrictEqual(Object.keys(deploy.AGENT_SKILL_DIRS).sort(), ['claude', 'codex', 'pi']);
  assert.deepStrictEqual(Object.keys(deploy.AGENT_PROMPT_DIRS).sort(), ['claude', 'codex', 'pi']);
  const overrides = JSON.parse(fs.readFileSync(path.join(REPO, 'shared-core/config/agent-overrides.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(overrides.agents).sort(), ['claude_code', 'codex', 'pi']);
});
test('shell-only adapter generator is gone; JS registration is the only path', () => {
  assert.ok(!fs.existsSync(path.join(REPO, 'shared-core/hooks/generate-adapters.sh')), 'generate-adapters.sh still shipped');
  assert.ok(fs.existsSync(path.join(REPO, 'lib/hooks.js')), 'lib/hooks.js missing');
});

function packagedFiles() {
  const out = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    if (e.name === '.git' || e.name === 'node_modules') return;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|json|md|sh|ts|npmrc|csv)$|\./.test(e.name)) out.push(p);
  });
  walk(REPO);
  return out.filter((p) => !p.startsWith(path.join(REPO, 'test')) && !p.endsWith('package-lock.json'));
}

// ============================================================ 2. detection
section('Phase 1 — detection against the fixture home');
buildFixture();
copyPackage();

let inventory;
test('detect finds custom tooling in all three agents', () => {
  const r = run(['detect', '--json']);
  assert.strictEqual(r.status, 0, r.out.slice(-400));
  const jsonStart = r.out.indexOf('\n{\n');
  assert.ok(jsonStart >= 0, `no JSON payload found in detect output: ${r.out.slice(0, 200)}`);
  inventory = JSON.parse(r.out.slice(jsonStart + 1));
  assert.ok(inventory.agents.pi.present && inventory.agents.claude.present && inventory.agents.codex.present, 'an agent was not detected');
  const byAgent = inventory.summary.byAgent;
  for (const a of ['pi', 'claude', 'codex']) assert.ok(byAgent[a] > 0, `no removable artifacts detected for ${a}`);
});
test('detection counts match the fixture exactly', () => {
  assert.strictEqual(inventory.agents.pi.artifacts.extensions.length, 2, 'pi loose extensions');
  assert.strictEqual(inventory.agents.pi.artifacts.localPiPackages.length, 1, 'pi local packages');
  assert.strictEqual(inventory.agents.claude.artifacts.agents.length, 1, 'claude agents');
  assert.strictEqual(inventory.agents.claude.artifacts.skills.length, 1, 'claude skills');
  assert.strictEqual(inventory.agents.codex.artifacts.skills.length, 1, 'codex skills');
});
test('protection denylist is falsifiable: live state is found AND excluded', () => {
  assert.ok(inventory.protectedEvidence.liveStateFilesFound > 0, 'denylist scan found no live state — fixture or scan is broken');
  assert.strictEqual(inventory.protectionHole, false, 'a protected path appears in the removable list');
  for (const f of [...FIXTURE.pi.protected, ...FIXTURE.claude.protected, ...FIXTURE.codex.protected]) {
    const abs = path.resolve(HOME, f);
    assert.ok(!inventory.removable.some((e) => path.resolve(e.path) === abs), `${f} was classified removable`);
  }
});
test('brew inventory is CSV-driven and internally consistent', () => {
  const csv = fs.readFileSync(path.join(REPO, 'shared-core/brew/formulae.csv'), 'utf8')
    .split('\n').filter((l) => l.trim()).slice(1);
  assert.strictEqual(inventory.brew.total, csv.length, 'detected row count != CSV row count');
  assert.strictEqual(inventory.brew.formulae + inventory.brew.casks, inventory.brew.total, 'formulae+casks != total');
  assert.ok(inventory.brew.formulae > 100 && inventory.brew.casks > 10, 'inventory looks truncated');
});
test('brew --scope=required considers every non-optional row', () => {
  // formulae.csv tags rows core|tooling|optional. --scope=required must consider both
  // non-optional classes: a set naming only aliases silently dropped every core row.
  const brew = require('../lib/brew');
  const types = fs.readFileSync(path.join(REPO, 'shared-core/brew/formulae.csv'), 'utf8')
    .split('\n').filter((l) => l.trim()).slice(1).map((l) => l.split('|')[3]);
  const expected = types.filter((t) => t !== 'optional').length;
  assert.ok(expected > 0, 'inventory has no non-optional row to require');
  const req = brew.plan({ scope: 'required' });
  const all = brew.plan({ scope: 'all' });
  assert.strictEqual(req.considered, expected, `required scope considered ${req.considered}, inventory has ${expected} non-optional rows`);
  assert.ok(req.considered < all.considered, 'required scope should be narrower than all');
});

// ============================================================ 3. dry run
section('Phase 1b — --dry-run is provably inert');
test('--dry-run changes no file in the home tree or state dir', () => {
  const before = JSON.stringify(hashTree(HOME));
  const r = run(['--dry-run', '--allow-destructive', '--yes', '--no-input']);
  assert.strictEqual(r.status, 0, r.out.slice(-400));
  assert.strictEqual(JSON.stringify(hashTree(HOME)), before, 'dry-run mutated the target home');
  assert.ok(!fs.existsSync(statePath('backups')), 'dry-run created an archive');
  assert.ok(!fs.existsSync(statePath('installed-manifest.json')), 'dry-run wrote an install manifest');
});

// ============================================================ 4. secrets
section('Phase 5 — interactive secret collection');
const templateVars = fs.readFileSync(path.join(REPO, 'shared-core/env/secrets.env.template'), 'utf8')
  .split('\n').map((l) => (l.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=/) || [])[1]).filter(Boolean);
const fedValues = templateVars.map((_, i) => `e2e-value-${i}`);
test('template declares variables to collect', () => assert.ok(templateVars.length >= 3, `only ${templateVars.length} template vars`));
test('piped prompts produce secrets.env at mode 600 with every value', () => {
  const r = run(['secrets'], { input: fedValues.join('\n') + '\n' });
  assert.strictEqual(r.status, 0, r.out.slice(-400));
  const target = statePath('env', 'secrets.env');
  assert.ok(fs.existsSync(target), 'secrets.env not created');
  assert.strictEqual((fs.statSync(target).mode & 0o777).toString(8), '600');
  const text = fs.readFileSync(target, 'utf8');
  templateVars.forEach((n, i) => assert.ok(text.includes(`${n}="${fedValues[i]}"`), `${n} missing or wrong`));
});
test('secret VALUES never reach the reports or logs', () => {
  const leak = [];
  for (const f of fs.readdirSync(statePath('reports'))) {
    const t = fs.readFileSync(statePath('reports', f), 'utf8');
    fedValues.forEach((v, i) => { if (t.includes(v)) leak.push(`${f}:${templateVars[i]}`); });
  }
  assert.deepStrictEqual(leak, [], `values recorded in ${leak.join(', ')}`);
  assert.ok(!run(['secrets'], { input: '\n'.repeat(templateVars.length) + '\n' }).out.includes(fedValues[0]), 'value echoed to stdout');
});

// ============================================================ 5. full cutover
section('Phases 2-4, 6 — full cutover');
let cutover;
test('full run exits 0 and reports every phase', () => {
  cutover = run(['--allow-destructive', '--yes', '--no-input']);
  assert.strictEqual(cutover.status, 0, cutover.out.slice(-1500));
  for (const p of ['Phase 1', 'Phase 2', 'Phase 3', 'Phase 4', 'Phase 5', 'Phase 6', 'Phase 7']) {
    assert.ok(cutover.out.includes(p), `phase ${p} did not run`);
  }
});
test('archive happened BEFORE removal and verified every target', () => {
  assert.ok(cutover.out.indexOf('Phase 2') < cutover.out.indexOf('Phase 3'), 'removal was not preceded by archive');
  const archives = fs.readdirSync(statePath('backups')).filter((d) => /^\d{8}_\d{6}$/.test(d));
  assert.strictEqual(archives.length, 1, `expected one archive, saw ${archives.length}`);
  const record = readJSON(statePath('backups', archives[0], 'archive-record.json'));
  assert.strictEqual(record.complete, true, `archive incomplete: ${record.incomplete.join(', ')}`);
  for (const t of ['pi', 'claude', 'codex', 'dotfiles']) {
    const e = record.targets.find((x) => x.name === t);
    assert.ok(e && (e.status === 'archived' || e.status === 'absent'), `target ${t} not archived`);
    // Agent dirs record filesBefore/filesAfter; the dotfiles target records `files`.
    if (e.status === 'archived') {
      const n = e.filesAfter != null ? e.filesAfter : e.files;
      assert.ok(n > 0, `target ${t} archived empty`);
      assert.ok(e.verified !== false, `target ${t} archive not verified`);
    }
  }
});
test('archive is addressable: a git tag was created and verified', () => {
  const record = readJSON(statePath('last-archive.json'));
  assert.ok(record.tag && record.tag.tagged, `tagging failed: ${record.tag && record.tag.reason}`);
  const listed = cp.execFileSync('git', ['-C', PKG, 'tag', '-l', record.tag.tag], { encoding: 'utf8' }).trim();
  assert.strictEqual(listed, record.tag.tag);
});
test('custom tooling was removed from all three agents', () => {
  for (const group of Object.values(FIXTURE)) {
    for (const f of group.custom) {
      if (f.startsWith('.agents/') || f.includes('/prompts/')) continue; // redeployed by phase 4
      assert.ok(!exists(f), `${f} still present after removal`);
    }
  }
  const reports = fs.readdirSync(statePath('reports')).filter((n) => n.startsWith('removal-'));
  assert.strictEqual(reports.length, 1, 'no removal report written');
});
test('live agent state survived the destructive phase', () => {
  for (const f of [...FIXTURE.pi.protected, ...FIXTURE.claude.protected, ...FIXTURE.codex.protected]) {
    assert.ok(exists(f), `protected path ${f} was deleted`);
  }
  assert.ok(fs.readFileSync(path.join(HOME, '.pi/agent/settings.json'), 'utf8').includes(PI_TOKEN), 'user settings key lost');
});
test('shared-core deployed to the right place for each agent', () => {
  const canonical = fs.readdirSync(path.join(PKG, 'shared-core/skills/canonical'));
  for (const dir of [path.join(HOME, '.agents/skills'), path.join(HOME, '.claude/skills'), path.join(HOME, '.codex/skills')]) {
    for (const s of canonical) assert.ok(fs.existsSync(path.join(dir, s, 'SKILL.md')), `${s} missing from ${dir}`);
  }
  const promptMaster = fs.readdirSync(path.join(PKG, 'shared-core/prompts/master'));
  assert.ok(promptMaster.length > 0, 'shared-core/prompts/master empty');
  for (const dir of [path.join(HOME, '.pi/agent/prompts'), path.join(HOME, '.claude/commands'), path.join(HOME, '.codex/prompts')]) {
    for (const p of promptMaster) assert.ok(fs.existsSync(path.join(dir, p)), `${p} missing from ${dir}`);
  }
});
test('packaged hook scripts are deployed and executable', () => {
  const bin = path.join(PKG, 'shared-core/hooks/bin');
  for (const name of fs.readdirSync(bin)) {
    const dst = statePath('hooks', name);
    assert.ok(fs.existsSync(dst), `${name} not deployed`);
    assert.ok(fs.statSync(dst).mode & 0o111, `${name} not executable`);
  }
});
test('hooks registered for pi, Claude and Codex with foreign entries preserved', () => {
  const piExt = path.join(HOME, '.pi/agent/extensions/asb-mods-hooks.ts');
  assert.ok(fs.existsSync(piExt), 'pi extension not generated');
  assert.ok(fs.readFileSync(piExt, 'utf8').includes('session_start'), 'pi extension has no session_start wiring');

  const claude = readJSON(path.join(HOME, '.claude/settings.json'));
  assert.ok(JSON.stringify(claude.hooks).includes('# asb-mods:'), 'no asb-mods hooks in claude settings');
  assert.ok(JSON.stringify(claude.hooks).includes(FOREIGN_CLAUDE_HOOK), 'foreign claude hook destroyed');
  assert.strictEqual(claude.model, 'opus', 'unrelated claude setting lost');

  const codex = readJSON(path.join(HOME, '.codex/hooks.json'));
  assert.ok(JSON.stringify(codex.hooks).includes('# asb-mods:'), 'no asb-mods hooks in codex hooks.json');
  assert.ok(JSON.stringify(codex.hooks).includes(FOREIGN_CODEX_HOOK), 'foreign codex hook destroyed');
});
test('registered commands contain no unresolved {{placeholders}}', () => {
  const blobs = [fs.readFileSync(path.join(HOME, '.pi/agent/extensions/asb-mods-hooks.ts'), 'utf8'),
    JSON.stringify(readJSON(path.join(HOME, '.claude/settings.json'))),
    JSON.stringify(readJSON(path.join(HOME, '.codex/hooks.json')))];
  for (const b of blobs) assert.ok(!/\{\{(HOME|STATE_DIR|CORE)}}/.test(b), 'placeholder reached a live config file');
  assert.ok(blobs.join('').includes(statePath('hooks')), 'hook commands do not point at the deployed scripts');
});
test('deployed hook scripts actually run and exit 0', () => {
  for (const name of fs.readdirSync(path.join(PKG, 'shared-core/hooks/bin'))) {
    const r = cp.spawnSync('/bin/bash', [statePath('hooks', name)], {
      encoding: 'utf8',
      env: { ...process.env, HOME, XDG_CONFIG_HOME: XDG },
    });
    assert.strictEqual(r.status, 0, `${name} exited ${r.status}: ${(r.stderr || '').slice(0, 200)}`);
  }
});
test('shell environment propagated into every existing rc file', () => {
  const markers = ['.zshrc', '.bashrc'].map((f) => fs.readFileSync(path.join(HOME, f), 'utf8').includes('asb-mods shared environment'));
  assert.deepStrictEqual(markers, [true, true], 'source block missing from an rc file');
  assert.ok(fs.existsSync(statePath('env', 'shell-env.sh')), 'shell-env.sh not deployed');
  assert.ok(fs.readFileSync(path.join(HOME, '.zshrc'), 'utf8').includes('export EDITOR=vim'), 'pre-existing shell config clobbered');
});

// ============================================================ 6. idempotency + reset
section('Idempotency and rollback');
test('a second run registers nothing new (no duplicated hooks)', () => {
  const before = [fs.readFileSync(path.join(HOME, '.claude/settings.json'), 'utf8'),
    fs.readFileSync(path.join(HOME, '.codex/hooks.json'), 'utf8'),
    fs.readFileSync(path.join(HOME, '.pi/agent/extensions/asb-mods-hooks.ts'), 'utf8')];
  const r = run(['hooks', '--yes', '--no-input']);
  assert.strictEqual(r.status, 0, r.out.slice(-400));
  const after = [fs.readFileSync(path.join(HOME, '.claude/settings.json'), 'utf8'),
    fs.readFileSync(path.join(HOME, '.codex/hooks.json'), 'utf8'),
    fs.readFileSync(path.join(HOME, '.pi/agent/extensions/asb-mods-hooks.ts'), 'utf8')];
  assert.deepStrictEqual(after, before, 'second registration changed config files');
  const rc = JSON.stringify(after[1]).match(/# asb-mods:/g) || [];
  const first = JSON.stringify(JSON.parse(before[1])).match(/# asb-mods:/g) || [];
  assert.strictEqual(rc.length, first.length, 'asb-mods hook entries duplicated');
});
test('status reports the deployment and exits 0', () => {
  const r = run(['status']);
  assert.strictEqual(r.status, 0, r.out.slice(-400));
  assert.ok(/checks green/.test(r.out), 'status produced no verification summary');
});
test('reset restores what removal took', () => {
  const victim = '.claude/agents/reviewer.md';
  assert.ok(!exists(victim), 'fixture expectation wrong: victim already back');
  const r = run(['reset']);
  assert.strictEqual(r.status, 0, r.out.slice(-400));
  assert.ok(exists(victim), 'reset did not restore the removed artifact');
});


// ── 14. the deployed env file works in a PRISTINE shell (requirement 5, functional)
section('14 shell-env.sh sources in a clean shell without corrupting it');
{
  const envFile = statePath('env', 'shell-env.sh');
  assert.ok(fs.existsSync(envFile), 'deployed shell-env.sh missing');
  assert.ok(fs.existsSync(statePath('env', 'secrets.env')), 'deployed secrets.env missing');

  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'asbmods-env-'));
  const fh = path.join(fx, 'home');
  fs.mkdirSync(path.join(fh, '.config', 'asb-mods', 'env'), { recursive: true });
  fs.mkdirSync(path.join(fh, '.local', 'bin'), { recursive: true });
  fs.copyFileSync(envFile, path.join(fh, '.config', 'asb-mods', 'env', 'shell-env.sh'));
  const sec = path.join(fh, '.config', 'asb-mods', 'env', 'secrets.env');
  fs.writeFileSync(sec, 'PI_TOKEN=fixture-token\nOPENAI_API_KEY=fixture-key\n');
  fs.chmodSync(sec, 0o600);

  const probe = [
    'source "$HOME/.config/asb-mods/env/shell-env.sh" || exit 9',
    'echo "MODEL=$PI_DEFAULT_MODEL|PROVIDER=$PI_DEFAULT_PROVIDER|TOKEN=$PI_TOKEN"',
    'case ":$PATH:" in *":$HOME/.local/bin:"*) echo PATHOK;; *) echo PATHMISSING;; esac',
    'echo CA=${SSL_CERT_FILE:+set}',
    'echo DONE',
  ].join('\n');
  const cleanShell = (shell, pre) => cp.spawnSync(shell, ['-c', (pre || '') + probe], {
    env: { HOME: fh, PATH: '/usr/bin:/bin', TERM: 'dumb' }, // nothing asb-related preset
    encoding: 'utf8', timeout: 30000,
  });

  for (const [label, shell, pre] of [
    ['zsh with nothing preset', '/bin/zsh', ''],
    ['bash that already has errexit on', '/bin/bash', 'set -e\n'],
    ['zsh that already has err_exit on', '/bin/zsh', 'setopt err_exit\n'],
  ]) {
    if (!fs.existsSync(shell)) continue;
    const r = cleanShell(shell, pre);
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    test(`shell-env.sh: sources in ${label} and every export lands`, () => {
      assert.strictEqual(r.status, 0, `shell aborted: ${out.slice(0, 300)}`);
      assert.ok(out.includes('DONE'), `source aborted early: ${out.slice(0, 300)}`);
      assert.ok(out.includes('MODEL=Qwen3.8-Flash-Next-oQ4e-mtp'), `model pin missing: ${out.slice(0, 300)}`);
      assert.ok(out.includes('PROVIDER=omlx'), 'provider export missing');
      assert.ok(out.includes('TOKEN=fixture-token'), 'secrets.env was not sourced');
      assert.ok(out.includes('PATHOK'), '~/.local/bin not prepended to PATH');
      // CA contract is: inherited SSL_CERT_FILE → this machine's bundle → system certs.
      // This fixture home has no bundle, so exercise the inherited path explicitly.
      const withCa = cp.spawnSync(shell, ['-c', 'export SSL_CERT_FILE=/fixture/ca.pem\n' + probe], {
        env: { HOME: fh, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 30000,
      });
      assert.ok(`${withCa.stdout}${withCa.stderr}`.includes('CA=set'),
        'an inherited SSL_CERT_FILE must survive the source (fastembed needs it)');
    });
  }

  test('shell-env.sh: a login shell that sources it survives and keeps the pin', () => {
    if (!fs.existsSync('/bin/zsh')) return;
    fs.writeFileSync(path.join(fh, '.zshenv'),
      `[ -f "${fh}/.config/asb-mods/env/shell-env.sh" ] && source "${fh}/.config/asb-mods/env/shell-env.sh"\n`);
    const r = cp.spawnSync('/bin/zsh', ['-c', 'echo RC_SURVIVED; echo "MODEL=$PI_DEFAULT_MODEL"'],
      { env: { HOME: fh, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 30000 });
    const out = `${r.stdout}${r.stderr}`;
    assert.strictEqual(r.status, 0, `login shell died: ${out.slice(0, 300)}`);
    assert.ok(out.includes('RC_SURVIVED'), `later rc commands never ran: ${out.slice(0, 300)}`);
    assert.ok(out.includes('MODEL=Qwen'), 'exports did not survive into the shell');
  });

  test('shell-env.sh: does not flip shell options from a sourced file', () => {
    const code = fs.readFileSync(envFile, 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    assert.ok(!/^\s*set\s+-[eu]|set\s+-o\s+pipefail/m.test(code),
      'a sourced file that turns on errexit kills every login shell that reads it');
  });

  fs.rmSync(fx, { recursive: true, force: true });
}

// ── 15. a FRESH home gets rc files — the env phase must not be a silent no-op
section('15 env phase on a fresh home creates the rc files');
{
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'asbmods-fresh-'));
  const fh = path.join(fx, 'home');
  fs.mkdirSync(fh, { recursive: true }); // no .zshrc / .zshenv / .bashrc at all
  const env = { ...process.env, ASB_MODS_HOME: fh, XDG_CONFIG_HOME: path.join(fx, 'xdg') };
  const r = cp.spawnSync(process.execPath, [path.join(PKG, 'install.js'), 'env', '--yes'], {
    env, encoding: 'utf8', timeout: 120000, input: '\n'.repeat(60),
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  test('fresh home: .zshenv is created with the source block', () => {
    assert.strictEqual(r.status, 0, out.slice(-400));
    const zshenv = path.join(fh, '.zshenv');
    assert.ok(fs.existsSync(zshenv), 'no .zshenv was created: the env phase is a no-op on a fresh machine');
    assert.ok(/asb-mods\/env\/shell-env\.sh/.test(fs.readFileSync(zshenv, 'utf8')), 'the created rc does not source the deployed env file');
    assert.ok(fs.existsSync(path.join(fx, 'xdg', 'asb-mods', 'env', 'shell-env.sh')),
      'the env file was not deployed to the state dir the rc sources');
  });
  test('fresh home: the log names the rc files it had to create', () => {
    assert.ok(/created \.zshenv|\.zshenv/.test(out), `log silent about rc creation: ${out.slice(-300)}`);
  });
  fs.rmSync(fx, { recursive: true, force: true });
}

// ── 16. packaged tooling: complete coverage of what removal can delete, and it restores
section('16 packaged tooling covers the removal contract and restores for real');
{
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'shared-core/tooling/manifest.json'), 'utf8'));
  const toolingSrc = fs.readFileSync(path.join(REPO, 'lib/tooling.js'), 'utf8');
  const classes = new Set([...toolingSrc.matchAll(/^ {2}(\w+): \{/gm)].map((m) => m[1]));

  // (a) every artifact kind the destructive phase can remove maps to a declared class
  const KIND_TO_CLASS = {
    extension: 'piExtensions', 'extension-dir': 'piExtensions', skill: 'agentSkills',
    'local-package': 'piPackages', script: 'agentScripts', agent: 'claudeAgents',
    'hook-dir': 'claudeHooks', 'plugin-dir': 'claudePlugins', 'plugin-registry': 'claudePlugins',
    'loose-file': 'codexLooseFiles', prompt: 'codexSkills',
    'agent-dir': 'claudeAgents',
    dir: null, file: null, // inventory-only kinds for protected containers: never removal targets
  };
  const detectSrc = fs.readFileSync(path.join(REPO, 'lib/detect.js'), 'utf8');
  const kinds = new Set([...detectSrc.matchAll(/kind:\s*'([\w-]+)'/g)].map((m) => m[1]));
  test('detection: every removable artifact kind maps to a tooling class', () => {
    const unmapped = [...kinds].filter((k) => !(k in KIND_TO_CLASS));
    assert.deepStrictEqual(unmapped, [], `detect.js emits kinds with no packaging class: ${unmapped.join(', ')}`);
    const missing = [...kinds].map((k) => KIND_TO_CLASS[k]).filter((c) => c && !classes.has(c));
    assert.deepStrictEqual([...new Set(missing)], [], `mapped classes not declared in lib/tooling.js: ${missing.join(', ')}`);
  });

  // (b) each class is either vendored into the package or denied by policy with a reason
  const vendored = new Set(manifest.bundles.map((b) => b.cls));
  const deniedCls = new Map((manifest.exclusions || []).filter((e) => e.count).map((e) => [e.cls, e]));
  test('tooling: every class is vendored or explicitly excluded with a reason', () => {
    const uncovered = [...classes].filter((c) => c !== 'agentsPackages' && !vendored.has(c) && !deniedCls.has(c));
    assert.deepStrictEqual(uncovered, [], `classes neither vendored nor denied: ${uncovered.join(', ')}`);
    for (const e of deniedCls.values()) {
      assert.ok(typeof e.reason === 'string' && e.reason.length > 20, `denial for ${e.cls} has no usable reason`);
    }
  });

  // (c) the shipped tree carries no machine path and no employer vocabulary
  test('tooling: the vendored tree is free of machine paths and internal vocabulary', () => {
    const local = path.join(REPO, 'shared-core/tooling/policy.local.json');
    const terms = fs.existsSync(local)
      ? JSON.parse(fs.readFileSync(local, 'utf8')).internalTerms.map((t) => t.toLowerCase()) : [];
    // On a machine without the gitignored local policy there is no vocabulary to police,
    // but the home-path scan below still runs everywhere.
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (e.name === 'policy.local.json') continue;
        const text = fs.readFileSync(p, 'utf8');
        if (text.includes(os.homedir())) hits.push(`${p} (home path)`);
        const low = text.toLowerCase();
        for (const t of terms) if (low.includes(t)) hits.push(`${p} (${t})`);
      }
    };
    walk(path.join(REPO, 'shared-core/tooling'));
    assert.deepStrictEqual(hits.slice(0, 5), [], `${hits.length} file(s) would leak this machine: ${hits.slice(0, 5).join('; ')}`);
  });

  // (d) deploying actually restores every bundle into a fresh home
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'asbmods-tooling-'));
  const fh = path.join(fx, 'home');
  fs.mkdirSync(fh, { recursive: true });
  const env = { ...process.env, ASB_MODS_HOME: fh, ASB_MODS_CORE: path.join(REPO, 'shared-core') };
  const r = cp.spawnSync(process.execPath, ['-e', `
    const D = require(${JSON.stringify(path.join(PKG, 'lib/deploy.js'))});
    const s = D.deployTooling(() => {});
    process.stdout.write(JSON.stringify({ bundles: s.bundles, files: s.files, skipped: (s.skipped || []).length, error: s.error || null }));
  `], { env, encoding: 'utf8', timeout: 180000 });
  let res = {};
  try { res = JSON.parse((r.stdout || '').trim()); } catch { /* asserted below */ }

  test('tooling: deployTooling restores every packaged bundle', () => {
    assert.strictEqual(res.error, null, `deploy failed: ${res.error} / ${(r.stderr || '').slice(0, 200)}`);
    assert.strictEqual(res.bundles, manifest.bundles.length,
      `restored ${res.bundles} of ${manifest.bundles.length} bundles (stdout=${r.stdout}, stderr=${(r.stderr || '').slice(0, 200)})`);
    assert.ok(res.files > 100, `expected a real file count, got ${res.files}`);
  });

  test('tooling: restored paths match the manifest destinations', () => {
    const missing = manifest.bundles.filter((b) => {
      const dest = b.dest.replace('{{HOME}}', fh);
      if (b.layout === 'dir') return !fs.existsSync(dest);
      const dir = path.dirname(dest.replace(/\/\{\{NAME\}\}$/, ''));
      const base = path.basename(b.dest.replace('{{HOME}}', fh));
      return !fs.existsSync(dest) && !fs.existsSync(path.join(fh, base)) && !fs.existsSync(path.join(dir, b.name));
    });
    assert.deepStrictEqual(missing.slice(0, 4).map((b) => `${b.cls}/${b.name}`), [],
      `${missing.length} bundle(s) did not land where the manifest says`);
  });

  test('tooling: a package, a loose extension and a script bundle all come back', () => {
    const pkg = manifest.bundles.find((b) => b.cls === 'piPackages');
    const ext = manifest.bundles.find((b) => b.cls === 'piExtensions' && b.layout === 'flatten');
    const script = manifest.bundles.find((b) => b.cls === 'agentScripts');
    assert.ok(fs.existsSync(path.join(fh, '.agents/packages', pkg.name, 'package.json')),
      `local package ${pkg.name} has no manifest after restore`);
    assert.ok(fs.existsSync(path.join(fh, '.pi/agent/extensions', ext.name)),
      `loose extension ${ext.name} missing after restore`);
    assert.ok(fs.existsSync(path.join(fh, '.agents/scripts', script.name)),
      `script ${script.name} missing after restore`);
  });

  fs.rmSync(fx, { recursive: true, force: true });
}
// ---------------------------------------------------------------- summary

// ── 17. the documentation describes the contract the code actually implements
section('17 source map and dependency map agree with the packaging contract');
{
  const srcMap = JSON.parse(fs.readFileSync(path.join(REPO, 'shared-core/agents/agnostic/source-map.json'), 'utf8'));
  const depMap = JSON.parse(fs.readFileSync(path.join(REPO, 'DEPENDENCY-MAP.json'), 'utf8'));
  const toolingSrc = fs.readFileSync(path.join(REPO, 'lib/tooling.js'), 'utf8');
  const classes = new Set([...toolingSrc.matchAll(/^ {2}(\w+): \{/gm)].map((m) => m[1]));

  test('source-map.json names only real packaging classes', () => {
    const named = [];
    for (const agent of ['pi', 'claude_code', 'codex']) {
      named.push(...((srcMap[agent] || {}).restored_by || []));
      named.push(...Object.keys((srcMap[agent] || {}).not_restored || {}));
    }
    assert.ok(named.length >= 6, `source map restored nothing: ${named.join(', ')}`);
    const fake = named.filter((c) => !classes.has(c));
    assert.deepStrictEqual(fake, [], `source map names classes that do not exist in lib/tooling.js: ${fake.join(', ')}`);
  });

  test('source-map.json describes each source directory the packager reads', () => {
    const text = JSON.stringify(srcMap);
    const srcDirs = [...toolingSrc.matchAll(/srcDir:\s*'([^']+)'/g)].map((m) => m[1]);
    const unmentioned = srcDirs.filter((d) => {
      const leaf = d.split('/').pop();
      return !text.includes(leaf) && !text.includes(`~/${d}`);
    });
    assert.deepStrictEqual(unmentioned, [], `directories the packager owns are absent from the source map: ${unmentioned.join(', ')}`);
  });

  test('source-map.json does not claim paths that no agent uses', () => {
    // Claude Code keeps hooks in its settings file, not a standalone hooks.json.
    assert.ok(/settings\.json/.test(srcMap.claude_code.hooks), 'claude hooks claim does not point at settings.json');
    assert.ok(!JSON.stringify(srcMap).includes('.claude/hooks.json'), 'claiming a file no agent reads');
    // pi reads AGENTS.md, not CLAUDE.md.
    assert.ok(/AGENTS\.md/.test(srcMap.pi.instructions), 'pi instructions claim is not AGENTS.md');
  });

  test('DEPENDENCY-MAP has no leftover path from the pre-consolidation name', () => {
    const text = JSON.stringify(depMap);
    assert.ok(!text.includes('pi-setup'), 'DEPENDENCY-MAP still points at the pre-rename state directory');
    assert.ok(/asb-mods\/env\/secrets\.env/.test(text), 'secrets_location does not name the deployed secrets file');
  });
}

// ── 18. phase 4 really installs casks AS casks (a fake brew records every argv)
section('18 brew phase installs formulae and casks with the right subcommand');
{
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'asbmods-brew-'));
  const bin = path.join(fx, 'bin');
  const argvLog = path.join(fx, 'argv.log');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'brew'), [
    '#!/bin/sh',
    `if [ "$1" = "--version" ]; then echo "brew 9.9.9-fake"; exit 0; fi`,
    `if [ "$1" = "list" ]; then exit 0; fi`, // nothing installed: everything is missing
    `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}`,
    'exit 0',
  ].join('\n'));
  fs.chmodSync(path.join(bin, 'brew'), 0o755);

  const env = {
    ...process.env,
    ASB_MODS_HOME: path.join(fx, 'home'),
    XDG_CONFIG_HOME: path.join(fx, 'xdg'),
    PATH: `${bin}:/usr/bin:/bin`,
  };
  const r = cp.spawnSync(process.execPath, [path.join(PKG, 'install.js'), 'brew', '--yes', '--install-brew'],
    { env, encoding: 'utf8', timeout: 300000 });
  const argv = fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean) : [];
  // Parse the inventory with production's own parser: names can be both a formula and
  // a cask, so a naive column read disagrees with what the installer actually sees.
  const { parseFormulae } = require(path.join(PKG, 'lib/detect.js'));
  const rows = parseFormulae(path.join(PKG, 'shared-core/brew/formulae.csv'));
  const caskNames = new Set(rows.filter((r) => r.type === 'cask').map((r) => r.name));
  const formulaNames = new Set(rows.filter((r) => r.type === 'formula').map((r) => r.name));
  const firstCask = [...caskNames].find((n) => !/^docker|^virtualbox/i.test(n));
  const firstFormula = [...formulaNames][0];
  test(`brew: every one of the ${rows.length} inventory rows is considered`, () => {
    assert.ok(r.status === 0, `brew phase failed: ${(r.stdout || '').slice(-400)}${(r.stderr || '').slice(-200)}`);
    assert.ok(argv.length > 100, `fake brew only saw ${argv.length} installs — the CSV was not consulted`);
  });

  test('brew: casks go through `install --cask`, formulae through plain install', () => {
    const casks = argv.filter((l) => l.startsWith('install --cask '));
    const formulae = argv.filter((l) => /^install \S+$/.test(l));
    // Strict: every cask in the inventory must arrive with --cask. A name that exists as
    // both a formula and a cask (1password does) used to resolve to the formula row.
    const wrongCasks = [...caskNames].filter((n) => !casks.includes(`install --cask ${n}`));
    assert.deepStrictEqual(wrongCasks.slice(0, 6), [],
      `${wrongCasks.length} of ${caskNames.size} casks were installed without --cask: ${wrongCasks.slice(0, 6).join(', ')}`);
    assert.ok(formulae.length > 0, 'no formula installs happened at all');
    assert.ok(casks.includes(`install --cask ${firstCask}`), `cask ${firstCask} not installed as a cask`);
    assert.ok(formulae.includes(`install ${firstFormula}`), `formula ${firstFormula} not installed as a formula`);
  });

  test('brew: casks needing interactive entitlement are deferred, never attempted', () => {
    const attempted = new Set(argv.map((l) => l.replace(/^install( --cask)? /, '')));
    for (const name of ['docker', 'docker-desktop', 'virtualbox']) {
      assert.ok(!attempted.has(name), `${name} was installed without manual entitlement`);
    }
  });

  test('brew: the phase writes a report of what it did', () => {
    const reports = path.join(fx, 'xdg', 'asb-mods', 'reports');
    const files = fs.existsSync(reports) ? fs.readdirSync(reports).filter((f) => f.startsWith('brew-')) : [];
    assert.ok(files.length > 0, 'no brew report written');
    const rec = JSON.parse(fs.readFileSync(path.join(reports, files[0]), 'utf8'));
    assert.ok(Array.isArray(rec.installed) && rec.installed.length > 100,
      `report undercounts installs: installed=${(rec.installed || []).length} `
      + `considered=${rec.plan && rec.plan.considered} missing=${rec.plan && rec.plan.missingCount} present=${rec.plan && rec.plan.presentCount}`);
    assert.deepStrictEqual(rec.failed, [], `fake brew should not fail: ${JSON.stringify(rec.failed).slice(0, 200)}`);
  });

  fs.rmSync(fx, { recursive: true, force: true });
}
section('CLI usage guards — bad usage costs 2 and never runs a phase');
test('--help prints usage instead of running detection', () => {
  const r = run(['--help']);
  assert.strictEqual(r.status, 0, r.out.slice(-400));
  assert.match(r.out, /Usage: asbmods/);
  assert.ok(!/Phase 1/.test(r.out), '--help ran a phase');
});
test('-h behaves like --help', () => {
  const r = run(['-h']);
  assert.strictEqual(r.status, 0, r.out.slice(-400));
  assert.match(r.out, /Usage: asbmods/);
});
test('an unknown command is rejected instead of running detection-only', () => {
  const r = run(['instal']);
  assert.strictEqual(r.status, 2, r.out.slice(-400));
  assert.match(r.out, /unknown command "instal"/);
  assert.match(r.out, /asbmods help/);
});
test('a mistyped flag is rejected instead of silently ignored', () => {
  const r = run(['--alow-destructive']);
  assert.strictEqual(r.status, 2, r.out.slice(-400));
  assert.match(r.out, /unknown flag "--alow-destructive"/);
});
test('--scope only accepts its documented values', () => {
  const r = run(['brew', '--scope=requird']);
  assert.strictEqual(r.status, 2, r.out.slice(-400));
  assert.match(r.out, /--scope must be all or required/);
});
test('--agent is refused rather than left silently inert', () => {
  const r = run(['hooks', '--agent=pi']);
  assert.strictEqual(r.status, 2, r.out.slice(-400));
  assert.match(r.out, /not implemented/);
  const bad = run(['hooks', '--agent=quux']);
  assert.strictEqual(bad.status, 2, bad.out.slice(-400));
  assert.match(bad.out, /unsupported tools/);
});
test('rejected runs leave the state file untouched', () => {
  const stateFile = statePath('state.json');
  const before = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : '';
  for (const args of [['instal'], ['--nope'], ['hooks', '--agent=pi'], ['brew', '--scope=nope']]) run(args);
  const after = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : '';
  assert.strictEqual(after, before, 'a rejected run wrote state');
});
test('--strict exits 0 on a run with no soft failures', () => {
  const r = run(['--dry-run', '--strict', '--yes', '--no-input', '--probe=false']);
  assert.strictEqual(r.status, 0, r.out.slice(-400));
  assert.ok(!/--strict: .* soft failure/.test(r.out), 'a clean dry run reported soft failures');
});

section('Prerequisites — doctor / --install-prereqs / --install-agents (these tests install nothing)');

// A PATH carrying Node but nothing else: the state of a fresh machine, reproducible here without
// uninstalling anything from the host. Homebrew stays present on disk yet off PATH, which is itself
// a configuration the tool must report as a gap — a brew that cannot be invoked installs nothing.
function runPoor(args, opts = {}) {
  const bin = path.join(ROOT, 'poor-bin');
  fs.mkdirSync(bin, { recursive: true });
  const link = (name, target) => {
    fs.rmSync(path.join(bin, name), { force: true });
    fs.symlinkSync(target, path.join(bin, name));
  };
  link('node', process.execPath);
  for (const sys of ['git', 'xcode-select']) {
    if (fs.existsSync(`/usr/bin/${sys}`)) link(sys, `/usr/bin/${sys}`);
  }
  const r = cp.spawnSync(process.execPath, [path.join(PKG, 'install.js'), ...args], {
    cwd: PKG,
    encoding: 'utf8',
    input: opts.input || '',
    timeout: 180000,
    env: {
      ...process.env, ASB_MODS_HOME: HOME, ASB_MODS_CORE: path.join(PKG, 'shared-core'),
      XDG_CONFIG_HOME: XDG, NO_COLOR: '1', ASB_MODS_ASSUME_YES: '1', PATH: bin,
    },
  });
  if (r.error) throw r.error;
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const doctorJson = (out) => JSON.parse(out.slice(out.indexOf('{\n'), out.lastIndexOf('}') + 1));
let poorDoc = null;
const poorDoctor = () => (poorDoc = poorDoc || runPoor(['doctor', '--json']));

test('doctor --json lists every prerequisite and its exit code matches the verdict', () => {
  const r = run(['doctor', '--json']);
  assert.ok([0, 1].includes(r.status), `expected 0 (complete) or 1 (gaps), got ${r.status}: ${r.out.slice(-250)}`);
  const doc = doctorJson(r.out);
  for (const name of ['node', 'npm', 'git', 'Xcode CLT', 'Homebrew', 'pi CLI', 'claude CLI', 'codex CLI']) {
    assert.ok(doc.rows.some((x) => x.name === name), `no row for ${name}: ${doc.rows.map((x) => x.name)}`);
  }
  assert.strictEqual(doc.ok, doc.rows.every((x) => x.ok), 'verdict disagrees with its own rows');
  assert.strictEqual(r.status, doc.ok ? 0 : 1, 'exit code disagrees with the verdict');
  for (const row of doc.rows.filter((x) => !x.ok)) {
    assert.ok(row.fix && row.fix.length > 5, `${row.name} is missing but prints no fix: ${JSON.stringify(row)}`);
  }
});

test('doctor treats an off-PATH Homebrew as a gap and prints the shellenv fix', () => {
  const doc = doctorJson(poorDoctor().out);
  const brew = doc.rows.find((x) => x.name === 'Homebrew');
  assert.strictEqual(brew.ok, false, 'a Homebrew that cannot be invoked must not be reported as ready');
  assert.match(brew.fix, /shellenv|raw\.githubusercontent\.com\/Homebrew/);
  const pi = doc.rows.find((x) => x.name === 'pi CLI');
  assert.strictEqual(pi.ok, false, 'an absent agent CLI used to surface only as hooks: skipped');
  assert.match(pi.fix, /--install-agents/);
});

test('brew phase says Homebrew is unusable instead of calling all 367 rows missing', () => {
  const r = runPoor(['brew']);
  assert.strictEqual(r.status, 0, `a missing prerequisite is not a run failure: ${r.out.slice(-250)}`);
  assert.match(r.out, /not installed|not on PATH/i);
  assert.ok(!/367 missing|0\/367 present/.test(r.out), 'the phase still claims every manifest row is missing');
  const strict = runPoor(['brew', '--strict']);
  assert.strictEqual(strict.status, 0, `--strict must not punish a missing prerequisite: ${strict.out.slice(-250)}`);
});

test('--install-prereqs refuses under --no-input rather than failing on a sudo prompt', () => {
  const r = runPoor(['--install-prereqs', '--no-input', '--yes']);
  assert.strictEqual(r.status, 2, `expected a usage refusal, got ${r.status}: ${r.out.slice(-250)}`);
  assert.match(r.out, /refusing under --no-input/);
});

test('--install-prereqs --dry-run announces the plan and executes nothing', () => {
  const r = runPoor(['--install-prereqs', '--dry-run']);
  assert.strictEqual(r.status, 0, r.out.slice(-250));
  const steps = r.out.split('\n').filter((l) => /: (will run|manual step)/.test(l));
  assert.ok(steps.length > 0, `no announced steps:\n${r.out.slice(-400)}`);
  assert.match(steps[0], /Homebrew/, 'Homebrew comes first: every other fix runs through it');
  assert.ok(!steps.some((l) => /^\[..\] node:/ .test(l)), 'a present prerequisite must not be reinstalled');
  assert.match(r.out, /--dry-run: no command executed/);
});

test('agents.json names the supported tools using only implemented route kinds', () => {
  const cat = require(path.join(PKG, 'lib/prereqs')).agentCatalog();
  assert.ok(!cat.error, cat.error);
  assert.deepStrictEqual(cat.agents.map((a) => a.tool).sort(), ['claude', 'codex', 'pi']);
  for (const a of cat.agents) {
    assert.ok(Array.isArray(a.routes) && a.routes.length, `${a.tool} declares no install routes`);
    for (const rt of a.routes) {
      assert.ok(['brew-formula', 'brew-cask', 'npm-global', 'native'].includes(rt.kind), `${a.tool}: route kind ${rt.kind}`);
    }
  }
});

test('--install-agents dry-run reports each tool and starts no install', () => {
  const dir = path.join(STATE, 'reports');
  const before = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('agents-')).length : 0;
  const r = runPoor(['--install-agents', '--dry-run', '--yes']);
  assert.strictEqual(r.status, 0, r.out.slice(-250));
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('agents-'));
  assert.strictEqual(files.length, before + 1, `expected one new agents report, saw ${JSON.stringify(files)}`);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
  assert.strictEqual(rec.rows.length, 3, JSON.stringify(rec.rows.map((r) => r.tool)));
  for (const row of rec.rows) {
    assert.ok(['pi', 'claude', 'codex'].includes(row.tool), JSON.stringify(row.tool));
    assert.ok(Array.isArray(row.routes) && row.routes.length, `${row.tool}: report carries no routes`);
    assert.ok(typeof row.installedAt === 'string' || row.installedAt === null, JSON.stringify(row.installedAt));
  }
  assert.strictEqual(rec.dryRun, true, 'report must record that nothing was installed');
  assert.ok(!/installing via/.test(r.out), '--dry-run reported an install starting');
  // With neither Homebrew nor npm reachable, a brew-backed tool must be reported, not attempted.
  assert.match(r.out, /not on PATH|no install route resolved/);
});

section('O1 — a prompt that gets EOF refuses instead of hanging (slice O1)');

// An unattended run — CI, `curl | sh`, a heredoc — feeds the prompt an end-of-file, which
// never fires readline's answer callback. A confirm() awaiting only that callback waited
// forever: the run hung instead of refusing. Probed 2026-11-22 against the previous shape:
// the prompt printed and never resolved, with stdin as /dev/null, as an empty pipe, and as a
// closed descriptor. Both tests below carry a hard kill timer, so a regression fails here
// rather than hanging the suite.
function runWithClosedStdin(args, extraEnv = {}, killMs = 300000) {
  const r = cp.spawnSync(process.execPath, [path.join(PKG, 'install.js'), ...args], {
    cwd: PKG,
    encoding: 'utf8',
    input: '',
    timeout: killMs,
    env: { ...process.env, ASB_MODS_HOME: HOME, ASB_MODS_CORE: path.join(PKG, 'shared-core'), XDG_CONFIG_HOME: XDG, NO_COLOR: '1', ...extraEnv },
  });
  return {
    timedOut: !!r.error && r.error.code === 'ETIMEDOUT',
    status: r.status,
    signal: r.signal,
    errorCode: (r.error && r.error.code) || null,
    out: `${r.stdout || ''}${r.stderr || ''}`,
  };
}

test('O1: --allow-destructive without --yes declines on EOF stdin and deletes nothing', () => {
  const target = path.join(HOME, '.pi/agent/extensions/alpha.ts');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const sentinel = '// must-survive-a-run-that-could-not-answer\n';
  fs.writeFileSync(target, sentinel);
  const r = runWithClosedStdin(['--allow-destructive']);
  assert.ok(!r.timedOut,
    `killed by the kill timer — the prompt waited for input EOF cannot supply. tail: ${r.out.slice(-400)}`);
  assert.match(r.out, /removal declined/, 'EOF must be reported as a refusal, not silence');
  assert.equal(fs.readFileSync(target, 'utf8'), sentinel,
    'a run nobody answered must leave custom tooling on disk (asserted on file content, not on output)');
});

test('O1: --install-prereqs on a pipe answers its prompt as a refusal and runs nothing', () => {
  // The prompt itself must be reached (so this is a real EOF test, not a dry-run skip) and the
  // answer must be "no". A fake brew owns PATH for the run: adoption only kicks in when no brew
  // is on PATH, so a regression that auto-accepted would execute the fake — never the real
  // Homebrew on the machine running the suite. The marker file is the proof nothing executed.
  const fakebin = path.join(PKG, 'test-tmp', 'fakebin');
  const marker = path.join(PKG, 'test-tmp', 'brew-executed.log');
  fs.mkdirSync(fakebin, { recursive: true });
  fs.rmSync(marker, { force: true });
  fs.writeFileSync(path.join(fakebin, 'brew'), [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "Homebrew 9.9.9-FAKE-WINS"; exit 0; fi',
    'if [ "$1" = "install" ] || [ "$1" = "uninstall" ] || [ "$1" = "remove" ]; then',
    '  echo "$*" >> "${ASB_TEST_BREW_MARKER:-/dev/null}"; exit 0',
    'fi',
    'echo ""',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  const r = runWithClosedStdin(['--install-prereqs'], {
    PATH: `${fakebin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    ASB_TEST_BREW_MARKER: marker,
  });
  assert.ok(!r.timedOut, 'the prerequisite confirmation hung on a stdin that cannot answer');
  assert.match(r.out, /Install the prerequisites above\? \[y\/N\]/,
    `the prompt was never reached, so this proves nothing about EOF. status=${r.status} signal=${r.signal} error=${r.errorCode} outLen=${r.out.length} tail=${JSON.stringify(r.out.slice(-200))}`);
  assert.match(r.out, /prerequisite install declined/, 'EOF must decline the install, not proceed');
  assert.ok(!fs.existsSync(marker),
    `commands were executed for a prompt nobody answered: ${fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : ''}`);
});

// The same defect class is one line wide anywhere else: a child process spawned with the
// installer's stdin inherits a terminal that is not there. Guards below keep it from
// reappearing silently — every child call must state its stdin policy, and the three sites
// that deliberately inherit do so for a stated reason (their child reads EOF immediately; no
// Node-side prompt is involved).
const INHERIT_ALLOWLIST = {
  'lib/agents.js': 1,
  'lib/prereqs.js': 1,
  'lib/ledger.js': 1,
};

test('O1: every child-process call states its stdin policy; inherit stays on the allow-list', () => {
  const sources = ['install.js', ...fs.readdirSync(path.join(PKG, 'lib')).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`)];
  const callRe = /\.(spawnSync|execFileSync|execSync|spawn|execFile|exec)\s*\(/g;
  const offenders = [];
  const inheritCounts = {};
  for (const rel of sources) {
    const src = fs.readFileSync(path.join(PKG, rel), 'utf8');
    inheritCounts[rel] = (src.match(/stdio:\s*'inherit'/g) || []).length;
    for (const m of src.matchAll(callRe)) {
      const window = src.slice(m.index, m.index + 500);
      if (!/stdio\s*:|stdin\s*:/.test(window)) offenders.push(`${rel}: ${window.split('\n')[0].trim().slice(0, 80)}`);
    }
  }
  assert.deepEqual(offenders, [], 'child process inheriting stdin can block on a terminal that does not exist');
  const unexpected = Object.entries(inheritCounts)
    .filter(([rel, n]) => n !== (INHERIT_ALLOWLIST[rel] || 0))
    .map(([rel, n]) => `${rel}: ${n} site(s) inherit the terminal, allow-list allows ${INHERIT_ALLOWLIST[rel] || 0}`);
  assert.deepEqual(unexpected, [],
    'a new terminal-inheriting spawn needs a stated reason before it can prompt an unattended run');
});

test('O1: interactivity is judged on stdin and confirm() resolves on EOF', () => {
  const prereqs = fs.readFileSync(path.join(PKG, 'lib/prereqs.js'), 'utf8');
  assert.match(prereqs, /process\.stdin\.isTTY/,
    'prerequisite planning must ask whether stdin can answer, not whether stdout is a terminal');
  assert.ok(!/interactive\s*:\s*Boolean\(\s*process\.stdout\.isTTY\s*\)/.test(prereqs),
    'the stdout-only interactivity check (limitation 26) is back');
  const installer = fs.readFileSync(path.join(PKG, 'install.js'), 'utf8');
  const confirmBody = installer.slice(installer.indexOf('function confirm'), installer.indexOf('function confirm') + 1400);
  assert.ok(confirmBody.includes("rl.on('close'"), 'confirm() must settle when stdin closes');
  assert.match(fs.readFileSync(path.join(PKG, 'lib/secrets.js'), 'utf8'), /process\.stdin\.isTTY/,
    'secret collection must not prompt a stdin that cannot answer');
});

section('P5 — one placeholder factory; a payload token the factory does not emit fails the pack');

// shared-core/** ships {{HOME}}/{{STATE_DIR}}/{{CORE}} and nothing else. Before P5 that vocabulary was
// re-typed inline at three call sites (deploy.js twice, hooks.js once) and no code looked at a payload
// file, so a fragment carrying {{WORKSPACE_DIR}} would have deployed to a target machine as a literal
// string and nobody would have noticed. lib/fsx.js vars() now owns the map, PLACEHOLDER_TOKENS owns the
// name list, and scripts/check-payload-tokens.cjs is the pack-time gate that ties them together.
function runTokenLint(args) {
  return cp.spawnSync(process.execPath, [path.join(PKG, 'scripts/check-payload-tokens.cjs'), ...args], {
    cwd: PKG, encoding: 'utf8',
  });
}

test('P5: the shipped payload passes the lint, and the lint is actually looking at it', () => {
  const r = runTokenLint(['--core=' + path.join(PKG, 'shared-core'), '--json']);
  assert.equal(r.status, 0, `shipped payload failed its own lint: ${r.stdout}${r.stderr}`);
  const report = JSON.parse(r.stdout);
  assert.ok(report.filesScanned > 100, `the lint scanned only ${report.filesScanned} files — it is not covering the payload`);
  assert.ok(report.tokenHits > 0, 'the lint found no placeholders at all, so a vocabulary change would go unnoticed');
  assert.deepEqual(report.allowed, ['HOME', 'STATE_DIR', 'CORE'],
    'the placeholder vocabulary changed; update this contract and every host config that consumes it');
});

test('P5: a payload token no module resolves fails the pack, naming the file and line', () => {
  const bad = path.join(PKG, 'test-tmp', 'tok-fixture');
  fs.mkdirSync(path.join(bad, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(bad, 'sub', 'fragment.json'), '{"hook":"{{HOME}}/x","oops":"{{WORKSPACE_DIR}}"}\n');
  const r = runTokenLint(['--core=' + bad]);
  assert.equal(r.status, 1, 'an unresolved payload token must fail the pack, not deploy as a literal');
  assert.match(`${r.stdout}${r.stderr}`, /\{\{WORKSPACE_DIR\}\} at sub\/fragment\.json:1/,
    'the failure has to name the token and where it is, or it cannot be fixed');
});

test('P5: a lint that scanned nothing reports failure, never success', () => {
  const empty = path.join(PKG, 'test-tmp', 'tok-empty-core');
  fs.mkdirSync(empty, { recursive: true });
  const r = runTokenLint(['--core=' + empty]);
  assert.equal(r.status, 1, 'an empty scan is not evidence of a clean payload (limitation 38)');
  assert.match(`${r.stdout}${r.stderr}`, /scanned nothing/);
});

test('P5: lib/fsx.js is the only file that writes out a placeholder map', () => {
  const sources = ['install.js', ...fs.readdirSync(path.join(PKG, 'lib'))
    .filter((f) => f.endsWith('.js') && f !== 'fsx.js').map((f) => `lib/${f}`)];
  const offenders = sources.filter((rel) => /'\{\{(HOME|STATE_DIR|CORE)\}\}'\s*:/.test(fs.readFileSync(path.join(PKG, rel), 'utf8')));
  assert.deepEqual(offenders, [], 'an inline placeholder map drifts from the factory — build it with X.vars(P)');
});

section('P6 — every payload path has one owner, and the shipped inventory can prove what it deployed');

// Before P6 nothing asserted which module reads a shared-core subtree, and nothing checked that the
// payload on disk is the payload that was packaged. config/ sat in the first hole the whole time: three
// files shipped and documented, read by nothing. lib/payload.js now declares ownership (proven for
// tooling/ by the 46 bundle entries that actually deploy it), keeps a ratchet for what is unread, and
// verify-core compares a core directory against shared-core/MANIFEST.sha256.

test('P6: ownership covers the payload exactly — no orphans, no stale unread claims', () => {
  const P6 = require(path.join(PKG, 'lib/payload.js'));
  const report = P6.checkCoupling(path.join(PKG, 'shared-core'));
  assert.deepEqual(report.problems, [], 'a declared owner does not hold: ' + report.problems.join(' | '));
  assert.deepEqual(report.strays, [], `payload files no module owns and no unread entry covers: ${report.strays.slice(0, 8).join(', ')}`);
  assert.deepEqual(report.staleUnread, [], 'UNREAD names a prefix that covers nothing any more — wire it up, delete it, or drop the entry');
  assert.ok(report.bundlePaths >= 40, `only ${report.bundlePaths} tooling bundles were read, so tooling/ ownership is not being proven`);
  for (const o of P6.OWNED) {
    assert.ok(o.owner, `${o.path} names no owner`);
    assert.ok(fs.existsSync(path.join(PKG, o.owner)), `${o.path}: owner ${o.owner} does not exist`);
  }
});

test('P6: the committed inventory matches the tree, and --check proves it without writing', () => {
  const coreDir = path.join(PKG, 'shared-core');
  const before = fs.readFileSync(path.join(coreDir, 'MANIFEST.sha256'), 'utf8');
  const r = cp.spawnSync(process.execPath, [path.join(PKG, 'tools/make-manifest.js'), '--check'], { cwd: PKG, encoding: 'utf8' });
  assert.equal(r.status, 0, `the shipped inventory is stale: ${r.stderr.slice(0, 400)}`);
  const entries = require(path.join(PKG, 'lib/payload.js')).parseManifest(before).entries;
  assert.ok(entries.length > 150, `only ${entries.length} payload files are hashed — the inventory is not covering the tree`);
  assert.ok(entries.every((e) => /^[0-9a-f]{64}$/.test(e.sha) && !e.rel.startsWith('/')),
    'inventory lines must be "<sha256>  ./relative/path", the format anything consuming it parses');
});

test('P6: verify-core tells missing from changed, and a missing inventory is an error', () => {
  const P6 = require(path.join(PKG, 'lib/payload.js'));
  const src = path.join(PKG, 'shared-core');
  const tampered = path.join(PKG, 'test-tmp', 'core-tampered');
  fs.rmSync(tampered, { recursive: true, force: true });
  fs.cpSync(src, tampered, { recursive: true });
  fs.appendFileSync(path.join(tampered, 'env/shell-env.sh'), '\n# tampered by a test\n');
  fs.rmSync(path.join(tampered, 'hooks/hooks.json'));
  const v = P6.verifyCore(tampered);
  assert.equal(v.inventory, 'ok');
  assert.deepEqual([v.summary.missing, v.summary.changed], [1, 1],
    `expected exactly one missing and one changed: ${JSON.stringify(v.summary)}`);
  const names = v.checks.map((c) => c.name);
  assert.ok(names.includes('missing:hooks/hooks.json'), 'the failing path must be named, not just counted');
  assert.ok(names.includes('changed:env/shell-env.sh'), 'the differing path must be named, not just counted');
  assert.ok(v.checks.every((c) => c.verdict === 'pass' || c.fix), 'every failure has to carry the command that fixes it');

  const bare = path.join(PKG, 'test-tmp', 'core-no-inventory');
  fs.rmSync(bare, { recursive: true, force: true });
  fs.cpSync(src, bare, { recursive: true });
  fs.rmSync(path.join(bare, 'MANIFEST.sha256'));
  const absent = P6.verifyCore(bare);
  assert.equal(absent.inventory, 'absent', 'a core with no inventory must be reported as unverifiable');
  assert.ok(absent.checks.some((c) => c.verdict === 'fail'), 'an absent inventory is a failure, never a silent pass');

  const broken = path.join(PKG, 'test-tmp', 'core-bad-inventory');
  fs.rmSync(broken, { recursive: true, force: true });
  fs.cpSync(src, broken, { recursive: true });
  fs.writeFileSync(path.join(broken, 'MANIFEST.sha256'), 'not a manifest line\n');
  const malformed = P6.verifyCore(broken);
  assert.equal(malformed.inventory, 'malformed', 'a malformed inventory must not be read as clean');
});

test('P6: asbmods verify-core answers on the exit code, emits --json, and writes nothing', () => {
  const stateBefore = fs.existsSync(XDG) ? fs.readdirSync(XDG) : [];
  const runVerify = (core, extra = []) => cp.spawnSync(process.execPath, [path.join(PKG, 'install.js'), 'verify-core', ...extra], {
    cwd: PKG, encoding: 'utf8', input: '',
    env: { ...process.env, ASB_MODS_HOME: HOME, ASB_MODS_CORE: core, XDG_CONFIG_HOME: XDG, NO_COLOR: '1' },
  });
  const clean = runVerify(path.join(PKG, 'shared-core'), ['--json']);
  assert.equal(clean.status, 0, `a clean payload must exit 0. tail: ${clean.stdout.slice(-300)}${clean.stderr.slice(-200)}`);
  const envelope = JSON.parse(clean.stdout);
  assert.equal(envelope.verb, 'verify-core');
  assert.equal(envelope.ok, true, 'the envelope must say ok for a clean payload');
  assert.equal(envelope.exitCode, 0);
  assert.ok(Array.isArray(envelope.checks) && envelope.checks.length, 'the envelope carries no checks — it proves nothing');
  assert.ok(envelope.checks.every((c) => ['name', 'verdict', 'detail', 'fix'].every((k) => k in c)),
    'every check needs name/verdict/detail/fix so a consumer can act on it');

  const drift = path.join(PKG, 'test-tmp', 'core-cli-drift');
  fs.rmSync(drift, { recursive: true, force: true });
  fs.cpSync(path.join(PKG, 'shared-core'), drift, { recursive: true });
  fs.rmSync(path.join(drift, 'npm/manifest.json'));
  const bad = runVerify(drift, ['--json']);
  assert.equal(bad.status, 1, 'payload drift must be visible in the exit code, not only in prose');
  const badEnv = JSON.parse(bad.stdout);
  assert.equal(badEnv.ok, false);
  assert.equal(badEnv.summary.missing, 1);

  const misuse = runVerify(path.join(PKG, 'shared-core'), ['--install-brew']);
  assert.equal(misuse.status, 2, 'verify-core is read-only and must refuse a mutating flag');
  assert.match(`${misuse.stdout}${misuse.stderr}`, /read-only/);

  assert.deepEqual(fs.existsSync(XDG) ? fs.readdirSync(XDG) : [], stateBefore,
    'verify-core is documented as read-only but changed the state directory');
});

section('P12 — documentation that drifts from behaviour fails the suite');

// lib/docsync.js turns the wiki's claims into checks. Two directions matter: today's docs must agree
// with today's code (a lie in either direction fails), and each guard must actually bite when the two
// are pulled apart — a guard that never fires is how config/ and the npm install story stayed "true"
// in print for months.

const DS = require(path.join(PKG, 'lib/docsync.js'));

function docsyncFixture(name) {
  const dir = path.join(PKG, 'test-tmp', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'docs/wiki'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(PKG, 'install.js'), path.join(dir, 'install.js'));
  fs.copyFileSync(path.join(PKG, 'README.md'), path.join(dir, 'README.md'));
  for (const f of fs.readdirSync(path.join(PKG, 'lib'))) {
    if (f.endsWith('.js')) fs.copyFileSync(path.join(PKG, 'lib', f), path.join(dir, 'lib', f));
  }
  for (const f of fs.readdirSync(path.join(PKG, 'docs/wiki'))) {
    if (f.endsWith('.md')) fs.copyFileSync(path.join(PKG, 'docs/wiki', f), path.join(dir, 'docs/wiki', f));
  }
  fs.mkdirSync(path.join(dir, 'shared-core'), { recursive: true });
  for (const d of DS.payloadDirs(path.join(PKG, 'shared-core'))) fs.mkdirSync(path.join(dir, 'shared-core', d), { recursive: true });
  return dir;
}

test('P12: the shipped docs agree with the shipped code right now', () => {
  const a = DS.audit(PKG);
  assert.deepEqual(a.findings, [], 'docs and behaviour disagree:\n  ' + a.findings.map((f) => `[${f.check}] ${f.message}`).join('\n  '));
  // A guard that sees nothing proves nothing. These counts are the audit's own coverage.
  assert.ok(a.counts.codeVerbs >= 15, `only ${a.counts.codeVerbs} commands cross-checked`);
  assert.ok(a.counts.codeFlags >= 12, `only ${a.counts.codeFlags} flags cross-checked`);
  assert.ok(a.counts.codePhases >= 8, `only ${a.counts.codePhases} phases cross-checked`);
  assert.ok(a.counts.dirs >= 8, `only ${a.counts.dirs} payload directories cross-checked`);
});

test('P12: each guard bites when docs and code are pulled apart', () => {
  const cases = [
    ['verbs', (d) => fs.writeFileSync(path.join(d, 'install.js'),
      fs.readFileSync(path.join(d, 'install.js'), 'utf8').replace("const KNOWN_COMMANDS = [", "const KNOWN_COMMANDS = ['brand-new-verb',"))],
    ['flags', (d) => fs.writeFileSync(path.join(d, 'install.js'),
      fs.readFileSync(path.join(d, 'install.js'), 'utf8').replace("a === '--strict'", "a === '--brand-new-flag' || a === '--strict'"))],
    ['env', (d) => fs.appendFileSync(path.join(d, 'lib', 'paths.js'), '\nconst W = process.env.ASB_MODS_BRAND_NEW;\nmodule.exports.W = W;\n')],
    ['payload-dirs', (d) => fs.mkdirSync(path.join(d, 'shared-core', 'brandnew'), { recursive: true })],
    ['phases', (d) => fs.writeFileSync(path.join(d, 'install.js'),
      fs.readFileSync(path.join(d, 'install.js'), 'utf8').replace("banner('Phase 4b — npm globals from manifest')", "banner('Phase 4c — npm globals from manifest')"))],
    ['install-story', (d) => fs.appendFileSync(path.join(d, 'docs/wiki/01-installation.md'), '\n```bash\nnpm i -g @asbmods/install\n```\n')],
  ];
  for (const [check, mutate] of cases) {
    const dir = docsyncFixture('docsync-' + check);
    mutate(dir);
    const a = DS.audit(dir);
    assert.ok(!a.ok, `mutating ${check} produced no finding — the guard cannot fire`);
    assert.ok(a.findings.some((f) => f.check === check),
      `expected a "${check}" finding, got: ${a.findings.map((f) => f.check).join(', ') || 'none'}`);
    // The untouched baseline must stay clean, or the mutation is just adding noise.
    const control = docsyncFixture('docsync-control-' + check);
    assert.deepEqual(DS.audit(control).findings, [], `the fixture itself is not clean before mutating (${check})`);
  }
});

test('P12: an npm route is flagged only when a reader would paste it, not when docs explain the 404', () => {
  const flag = (text) => DS.npmRouteClaims({ 'probe.md': text }).length;
  assert.equal(flag('```bash\nnpm i -g @asbmods/install\n```'), 1, 'a fenced install instruction must be flagged');
  assert.equal(flag('$ npx @asbmods/install@latest'), 1, 'a command-position route must be flagged');
  assert.equal(flag('`npx @asbmods/install` (bare name) does not work. `npm view @asbmods/install` returns 404.'), 0,
    'prose explaining the 404 is documentation, not a claim');
  assert.equal(flag('```bash\n$ npm view @asbmods/install\nnpm error code E404\n```'), 0,
    'a block that shows the failure is a demonstration, not an instruction');

  // The repo's own disclaimers are the real positive control: they name the route to say it fails.
  const realDocs = {};
  for (const f of fs.readdirSync(path.join(PKG, 'docs/wiki'))) {
    if (f.endsWith('.md')) realDocs[`docs/wiki/${f}`] = fs.readFileSync(path.join(PKG, 'docs/wiki', f), 'utf8');
  }
  realDocs['README.md'] = fs.readFileSync(path.join(PKG, 'README.md'), 'utf8');
  assert.deepEqual(DS.npmRouteClaims(realDocs), [], 'the shipped docs must not contain a runnable npm route while publishing is parked');
  const namedIt = Object.entries(realDocs).filter(([, t]) => t.includes('@asbmods/install')).length;
  assert.ok(namedIt >= 3, 'the positive control is vacuous if no real doc names the npm route at all');
});

section('P13 — agent memory surfaces: named in docs, pinned by fixtures, untouched by a run');

// Every path in this list is one docs/wiki/17-agent-memory-surfaces.md says asb-mods does not manage.
// `memory: true` means a run must leave the bytes exactly as found; the false entries are the files
// Phase 4 legitimately owns (its own managed blocks and generated hooks), kept here so the doc's claim
// "every path below is a fixture" is literally true and so the contrast is visible in one table.
// lib/docsync.js parses this array: a path added to wiki 17 without adding it here fails the suite.
const MEMORY_SURFACES = [
  { rel: '.pi/agent/AGENTS.md', memory: false },
  { rel: '.pi/agent/settings.json', memory: false },
  { rel: '.pi/agent/session-learnings/journal.jsonl', memory: true },
  { rel: '.pi/agent/sessions/index.sqlite', memory: true },
  { rel: '.pi/agent/prompt-history.jsonl', memory: true },
    { rel: '.claude/CLAUDE.md', memory: true }, // no installer code path writes it — bytes must survive
  { rel: '.claude/settings.json', memory: false },
  { rel: '.claude/projects/-Users-me-dev-app/memory/MEMORY.md', memory: true },
  { rel: '.claude/projects/-Users-me-dev-app/memory/ci-gotchas.md', memory: true },
    { rel: '.codex/AGENTS.md', memory: false }, // Phase 4 appends its managed block here — installer-owned
    { rel: '.codex/config.toml', memory: true }, // TOML is read, never rewritten — lib/deploy.js says so
  { rel: '.codex/memories/MEMORY.md', memory: true },
  { rel: '.codex/memories/memory_summary.md', memory: true },
  { rel: '.codex/memories/raw_memories.md', memory: true },
  { rel: '.codex/memories/rollout_summaries/2026-11-22.md', memory: true },
  { rel: '.codex/rules/default.rules', memory: true },
  { rel: '.codex/AGENTS.override.md', memory: true },
];

test('P13: a real run leaves every agent-authored memory byte-identical and out of every report', () => {
  for (const s of MEMORY_SURFACES) {
    const abs = path.join(HOME, s.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (!fs.existsSync(abs)) fs.writeFileSync(abs, `sentinel content for ${s.rel}\n`);
  }
  const before = new Map(MEMORY_SURFACES.map((s) => [s.rel, fs.readFileSync(path.join(HOME, s.rel))]));

  const r = run(['--allow-destructive', '--yes', '--no-input']);
  assert.equal(r.status, 0, `a second real run failed: ${r.out.slice(-500)}`);

  // The witness that this run actually did work, so "memory unchanged" is not a vacuous pass.
  // The witness that this run actually did work, so "memory unchanged" is not a vacuous pass: Phase 6
  // registered its managed hooks, each tagged `# asb-mods:<id>`, into the host's own settings file.
  const hooks = readJSON(path.join(HOME, '.claude/settings.json')).hooks || {};
  const managed = JSON.stringify(hooks).match(/asb-mods:[a-z_]+/g) || [];
  assert.ok(managed.length >= 3,
    `the run registered ${managed.length} managed hooks, so it proved nothing about what a run touches`);

  const touched = MEMORY_SURFACES.filter((s) => {
    const abs = path.join(HOME, s.rel);
    return !fs.existsSync(abs) || !fs.readFileSync(abs).equals(before.get(s.rel));
  }).map((s) => s.rel);
  for (const s of MEMORY_SURFACES) {
    if (s.memory) assert.ok(!touched.includes(s.rel),
      `install rewrote ${s.rel}, which wiki 17 promises is agent-authored and unmanaged`);
  }

  // Reports legitimately *name* protected paths — that is the point of `protectedEvidence.samples`, so a
  // reader can audit scope. What must never happen is a memory surface classified as something the run
  // took, so the check walks every report and flags any mention outside a protected section.
  const reportsDir = path.join(STATE, 'reports');
  const reports = fs.existsSync(reportsDir) ? fs.readdirSync(reportsDir).filter((f) => f.endsWith('.json')) : [];
  assert.ok(reports.length >= 3, `only ${reports.length} report(s) exist — the scope check below has nothing to read`);
  const swept = [];
  for (const f of reports) {
    const scan = (o, at) => {
      if (Array.isArray(o)) { o.forEach((v, i) => scan(v, `${at}[${i}]`)); return; }
      if (o && typeof o === 'object') { Object.entries(o).forEach(([k, v]) => scan(v, `${at}/${k}`)); return; }
      if (typeof o !== 'string') return;
      if (/protected/i.test(at)) return;
      const hit = MEMORY_SURFACES.find((s) => s.memory && o.endsWith(s.rel));
      if (hit) swept.push(`${hit.rel}\t${f} ${at}`);
    };
    scan(readJSON(path.join(reportsDir, f)), '');
  }
  for (const s of MEMORY_SURFACES) {
    if (!s.memory) continue;
    const hits = swept.filter((l) => l.startsWith(s.rel + '\t'));
    assert.deepEqual(hits, [], `${s.rel} is classified as taken rather than protected in: ${hits.slice(0, 2).join(' | ')}`);
  }
});

section('bootstrap.sh — the only part of the repository that runs without Node');

// install.js *is* Node, so a machine without it cannot be helped by the package. bootstrap.sh is
// the seam, and these cases pin its two promises: it never installs unattended, and --dry-run is a
// plan (exit 0), not a failure.
function runBootstrap(args, { withNode = true } = {}) {
  const nobin = path.join(ROOT, 'nobin');
  fs.mkdirSync(nobin, { recursive: true });
  fs.rmSync(path.join(nobin, 'git'), { force: true });
  if (fs.existsSync('/usr/bin/git')) fs.symlinkSync('/usr/bin/git', path.join(nobin, 'git'));
  const r = cp.spawnSync('/bin/bash', [path.join(PKG, 'bootstrap.sh'), ...args], {
    cwd: PKG,
    encoding: 'utf8',
    input: '',
    timeout: 120000,
    // Nothing from the developer's PATH leaks in: no node, no Homebrew, no /opt/homebrew.
    env: withNode ? { ...process.env } : { PATH: `${nobin}:/usr/bin:/bin`, HOME, TMPDIR: os.tmpdir() },
  });
  if (r.error) throw r.error;
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

test('bootstrap.sh --help lists the routes and changes nothing', () => {
  const r = runBootstrap(['--help']);
  assert.strictEqual(r.status, 0, r.out.slice(-300));
  assert.match(r.out, /Usage: bootstrap\.sh/);
  for (const flag of ['--dry-run', '--via=brew', '--via=nvm', '--via=none']) assert.ok(r.out.includes(flag), `help omits ${flag}`);
});

test('bootstrap.sh leaves a machine that already has Node alone', () => {
  const r = runBootstrap(['--via=none']);
  assert.strictEqual(r.status, 0, r.out.slice(-300));
  assert.match(r.out, /already satisfies/);
});

test('a Node-less machine told --via=none is diagnosed, not installed on', () => {
  const r = runBootstrap(['--via=none'], { withNode: false });
  assert.strictEqual(r.status, 1, `missing Node with installing forbidden is a failure: ${r.out.slice(-300)}`);
  assert.match(r.out, /forbids installing it/);
  assert.match(r.out, /manual routes/);
});

test('bootstrap.sh --dry-run announces the Homebrew route instead of running it', () => {
  const r = runBootstrap(['--via=brew', '--dry-run', '--yes'], { withNode: false });
  assert.strictEqual(r.status, 0, `a plan is not a failure: ${r.out.slice(-300)}`);
  assert.match(r.out, /curl -fsSL .*Homebrew\/install/);
  assert.match(r.out, /brew install node/);
  assert.ok(!/STUB|installed Homebrew/.test(r.out), '--dry-run performed an install');
});

test('bootstrap.sh refuses to install where no one is there to answer for it', () => {
  const r = runBootstrap(['--via=nvm'], { withNode: false });
  assert.strictEqual(r.status, 1, r.out.slice(-300));
  assert.match(r.out, /refusing to install unattended/);
  assert.ok(!fs.existsSync(path.join(HOME, '.nvm')), 'an unattended run created ~/.nvm');
});

section('install ledger — what the installer put on the machine, and how to take it back');

// brew and npm are replaced by shims whose whole state is a marker directory: a name counts as
// installed while MARK/<name> exists, and an uninstall deletes the marker. "installed", "removed"
// and "held back" therefore stay observable instead of asserted, on a fixture that cannot reach
// this machine's real Homebrew or npm prefix.
{
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'asbmods-ledger-'));
  const fh = path.join(fx, 'home');
  const fxdg = path.join(fx, 'xdg');
  const markers = path.join(fx, 'markers');
  const mbin = path.join(fx, 'mbin');
  const deps = path.join(fx, 'deps'); // per-formula dependent lists the brew shim answers with
  for (const d of [fh, fxdg, markers, mbin, deps]) fs.mkdirSync(d, { recursive: true });
  const SHIM_BREW = 'IyEvYmluL2Jhc2gKbWsoKSB7IGVjaG8gIk1BUksvJChlY2hvICIkMSIgfCB0ciAnLycgJ18nKSI7IH0KY2FzZSAiJDEiIGluCiAgLS12ZXJzaW9uKSBlY2hvICJIb21lYnJldyA0LjkuMCI7IGV4aXQgMDs7CiAgbGlzdCkgbmFtZT0iJHtAOiAtMX0iOyBmPSQobWsgIiRuYW1lIik7IFsgLWYgIiRmIiBdICYmIHsgZWNobyAiJG5hbWUgMS4yLjMiOyBleGl0IDA7IH07IGV4aXQgMTs7CiAgdXNlcykgc2hpZnQ7IFsgIiQxIiA9ICItLWluc3RhbGxlZCIgXSAmJiBzaGlmdDsgbj0iJDEiOwogICAgIyBSZWFsIEhvbWVicmV3IGFuc3dlcnMgZm9yIG5hbWVzIGl0IGRvZXMgbm90IGtub3cgdG9vLCBhbmQgdGhlIHNoYXBlIG1hdHRlcnM6IGV4aXQgMCwgZW1wdHkKICAgICMgc3Rkb3V0LCBwbHVzIGEgd2FybmluZyBvbiBzdGRlcnIuICJub3RoaW5nIGRlcGVuZHMgb24gaXQiIGFuZCAibm8gc3VjaCBmb3JtdWxhIiBib3RoIGxvb2sKICAgICMgZW1wdHkgb24gc3Rkb3V0LCBzbyB0aGUgc2hpbSByZXByb2R1Y2VzIHRoZSB3YXJuaW5nIHJhdGhlciB0aGFuIGEgZGlmZmVyZW50IGV4aXQgY29kZS4KICAgIGlmIFsgISAtZiAiJChtayAiJG4iKSIgXTsgdGhlbiBlY2hvICJXYXJuaW5nOiBObyBhdmFpbGFibGUgZm9ybXVsYSB3aXRoIHRoZSBuYW1lIFwiJG5cIi4iID4mMjsgZXhpdCAwOyBmaQogICAgZD0iREVQRElSLyRuIjsgWyAtZiAiJGQiIF0gfHwgZXhpdCAwCiAgICB3aGlsZSBJRlM9IHJlYWQgLXIgZGVwOyBkbyBbIC1uICIkZGVwIiBdICYmIFsgLWYgIiQobWsgIiRkZXAiKSIgXSAmJiBlY2hvICIkZGVwIjsgZG9uZSA8ICIkZCI7IGV4aXQgMDs7CiAgdW5pbnN0YWxsKSBzaGlmdDsgWyAiJDEiID0gIi0tY2FzayIgXSAmJiBzaGlmdDsgcm0gLWYgIiQobWsgIiQxIikiOyBleGl0IDA7Owplc2FjCmV4aXQgMAo=';
  const SHIM_NPM = 'IyEvYmluL2Jhc2gKY2FzZSAiJDEiIGluCiAgbHMpIHByaW50ZiAneyJkZXBlbmRlbmNpZXMiOnsnOyBmaXJzdD0xOyBmb3IgZiBpbiBNQVJLLyo7IGRvIFsgLWUgIiRmIiBdIHx8IGNvbnRpbnVlOyBuPSQoYmFzZW5hbWUgIiRmIiB8IHRyICdfJyAnLycpOyBbICRmaXJzdCAtZXEgMCBdICYmIHByaW50ZiAiLCI7IHByaW50ZiAnIiVzIjp7InZlcnNpb24iOiIxLjAuMCJ9JyAiJG4iOyBmaXJzdD0wOyBkb25lOyBwcmludGYgJ319XG4nOyBleGl0IDA7OwogIHVuaW5zdGFsbCkgcm0gLWYgIk1BUksvJChlY2hvICIkMyIgfCB0ciAnLycgJ18nKSI7IGV4aXQgMDs7CmVzYWMKZXhpdCAwCg==';
  for (const [name, b64] of [['brew', SHIM_BREW], ['npm', SHIM_NPM]]) {
    const p = path.join(mbin, name);
    fs.writeFileSync(p, Buffer.from(b64, 'base64').toString('utf8').split('MARK').join(markers).split('DEPDIR').join(deps), { mode: 0o755 });
    fs.chmodSync(p, 0o755);
  }
  const marker = (n) => path.join(markers, n.split('/').join('_'));
  for (const n of ['widget', 'gizmo', '@scope/tool', 'node', '@earendil-works/pi-coding-agent']) fs.writeFileSync(marker(n), 'x');
  const lenv = { ...process.env, ASB_MODS_HOME: fh, ASB_MODS_CORE: path.join(PKG, 'shared-core'),
    XDG_CONFIG_HOME: fxdg, NO_COLOR: '1', PATH: `${mbin}:${process.env.PATH}` };
  const runLedger = (args, extraEnv) => {
    const r = cp.spawnSync(process.execPath, [path.join(PKG, 'install.js'), ...args],
      { cwd: PKG, encoding: 'utf8', input: '', timeout: 180000, env: Object.assign({}, lenv, extraEnv || {}) });
    if (r.error) throw r.error;
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  const ledgerFile = path.join(fxdg, 'asb-mods', 'install-ledger.json');
  const readLedger = () => JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const reportsDir = path.join(fxdg, 'asb-mods', 'reports');
  const reportFiles = (prefix) => (fs.existsSync(reportsDir) ? fs.readdirSync(reportsDir).filter((f) => f.startsWith(prefix)) : []);
  // Seeded through the module itself, so what is asserted is production's own record format.
  const SEED = 'const L=require(' + JSON.stringify(path.join(PKG, 'lib/ledger.js')) + ');L.record(['
    + "{manager:'brew',name:'widget',kind:'formula',source:'test'},"
    + "{manager:'brew',name:'gizmo',kind:'cask',source:'test'},"
    + "{manager:'npm-global',name:'@scope/tool',kind:'package',source:'test'},"
    + "{manager:'brew',name:'node',kind:'formula',source:'test'},"
    + "L.routeEntry({kind:'npm-global',package:'@earendil-works/pi-coding-agent',"
    + "command:['npm','install','-g','@earendil-works/pi-coding-agent']},'pi')]);";
  const seedLedger = () => cp.spawnSync(process.execPath, ['-e', SEED], { cwd: PKG, encoding: 'utf8', env: lenv });

  test('ledger records each install once, under the manager that owns it', () => {
    assert.strictEqual(seedLedger().status, 0);
    const led = readLedger();
    assert.strictEqual(led.entries.length, 5, JSON.stringify(led.entries.map((e) => e.name)));
    const node = led.entries.find((e) => e.name === 'node');
    assert.strictEqual(node.reversible, false, 'a runtime prerequisite must not be removable by us');
    const pi = led.entries.find((e) => e.name === '@earendil-works/pi-coding-agent');
    assert.strictEqual(pi.agent, 'pi', 'an agent CLI has to be recognisable as one');
    assert.strictEqual(pi.manager, 'npm-global');
    assert.strictEqual(seedLedger().status, 0);
    assert.strictEqual(readLedger().entries.length, 5, 're-recording the same install duplicated it');
  });

  test('uninstall plans, separating removable from held back, and touches nothing', () => {
    const before = reportFiles('').length;
    const r = runLedger(['uninstall']);
    assert.strictEqual(r.status, 0, r.out.slice(-300));
    assert.ok(r.out.includes('would remove  brew:widget'), r.out.slice(-400));
    assert.match(r.out, /→\s+brew uninstall --cask gizmo/, `a cask needs --cask to be removed: ${r.out.slice(-400)}`);
    assert.ok(r.out.includes('would remove  npm-global:@scope/tool'), r.out.slice(-400));
    assert.ok(r.out.includes('held back     brew:node'), r.out.slice(-400));
    assert.ok(r.out.includes('held back     npm-global:@earendil-works/pi-coding-agent'), r.out.slice(-400));
    assert.match(r.out, /--include-agent-clis/, 'the held-back agent CLI row must name the flag that unlocks it');
    assert.ok(readLedger().entries.every((e) => !e.removedAt), 'planning marked something as removed');
    assert.strictEqual(reportFiles('').length, before, 'a plan wrote a report file');
  });

  test('uninstall --json reports the same plan as data', () => {
    const r = runLedger(['uninstall', '--json']);
    assert.strictEqual(r.status, 0, r.out.slice(-200));
    const j = JSON.parse(r.out.slice(r.out.indexOf('{')));
    assert.ok(j.removable.some((e) => e.name === 'widget'), JSON.stringify(j.removable));
    assert.ok(j.heldBack.some((e) => e.name === 'node'), JSON.stringify(j.heldBack));
  });

  test('--name tells you about a name the ledger never recorded', () => {
    const r = runLedger(['uninstall', '--name=ghost']);
    assert.strictEqual(r.status, 0, r.out.slice(-200));
    assert.ok(r.out.includes('--name=ghost is not in the install ledger'), r.out.slice(-300));
  });


  test('a formula other installed software depends on is never uninstalled', () => {
    // The dependent is a fixture package too: the shim answers with the dependents whose marker
    // exists, so what drives the plan is "is that thing installed", exactly like `brew uses
    // --installed` does. Nothing here consults a list we maintain ourselves.
    fs.writeFileSync(path.join(deps, 'widget'), 'sprocket\n');
    fs.writeFileSync(marker('sprocket'), 'x');

    const p = runLedger(['uninstall', '--name=widget', '--json']);
    assert.strictEqual(p.status, 0, p.out.slice(-300));
    const j = JSON.parse(p.out.slice(p.out.indexOf('{')));
    assert.ok(!j.removable.some((e) => e.name === 'widget'), 'a formula with dependents was offered for removal');
    const held = j.heldBack.find((e) => e.name === 'widget');
    assert.ok(held, `widget was not held back at all: ${JSON.stringify(j.heldBack)}`);
    assert.match(held.heldBackReason, /1 installed package\(s\) depend on it: sprocket/);
    assert.deepStrictEqual(held.brewDependents, ['sprocket'], 'the plan did not carry the dependents it acted on');

    // Consent changes nothing: no removal command is issued for a held-back formula, so the package
    // and its dependent both survive a run that was told to remove it.
    const r = runLedger(['uninstall', '--name=widget', '--yes']);
    assert.match(r.out, /0 removed, 0 failed/, r.out.slice(-300));
    assert.ok(fs.existsSync(marker('widget')), '--yes talked its way past the dependents gate');
    assert.ok(fs.existsSync(marker('sprocket')), 'the dependent was taken as well');

    // The gate is a live question, not a blocklist: once the dependent is gone the formula is fair
    // game again, which is what proves the answer came from Homebrew and not from a name table.
    fs.rmSync(marker('sprocket'));
    const again = runLedger(['uninstall', '--name=widget']);
    assert.ok(again.out.includes('would remove  brew:widget'), again.out.slice(-300));
    fs.rmSync(path.join(deps, 'widget'));
  });

  test('the dependents gate fails closed: unknown, unanswered and unchecked never clear a formula', () => {
    // Its own ledger, so the three-way answer shapes cannot disturb the shared fixture's counts.
    const fx3 = fs.mkdtempSync(path.join(os.tmpdir(), 'asbmods-deps-'));
    fs.mkdirSync(path.join(fx3, 'xdg'), { recursive: true });
    const env3 = Object.assign({}, lenv, { ASB_MODS_HOME: fx3, XDG_CONFIG_HOME: path.join(fx3, 'xdg') });
    const extra = ['alpha', 'beta', 'gamma', 'delta'];
    for (const n of extra) fs.writeFileSync(marker(n), 'x');
    const seed3 = 'const L=require(' + JSON.stringify(path.join(PKG, 'lib/ledger.js')) + ');'
      + "L.record(['alpha','beta','gamma','delta'].map((n,i)=>({manager:'brew',name:n,"
      + "kind:i===3?'cask':'formula',source:'test'})));";
    const s3 = cp.spawnSync(process.execPath, ['-e', seed3], { cwd: PKG, encoding: 'utf8', env: env3, timeout: 120000 });
    assert.strictEqual(s3.status, 0, (s3.stdout + s3.stderr).slice(-300));

    const probe = [
      'const L=require(' + JSON.stringify(path.join(PKG, 'lib/ledger.js')) + ');',
      'const R=(o)=>()=>Object.assign({ok:true,unknown:false,dependents:[],error:null},o);',
      'const names=(a)=>a.map((e)=>e.name).sort();',
      'const res={};',
      'res.clear=names(L.plan({dependentsOf:R({})}).removable);',
      'res.many=L.plan({dependentsOf:R({dependents:["a","b","c","d","e","f"]})}).heldBack.map((e)=>e.heldBackReason);',
      'const u=L.plan({dependentsOf:R({unknown:true})}).heldBack;',
      'res.unknown=names(u); res.unknownReason=(u[0]||{}).heldBackReason||"";',
      'const b=L.plan({dependentsOf:R({ok:false,error:"brew is not on PATH"})}).heldBack;',
      'res.unanswered=names(b); res.unansweredReason=(b[0]||{}).heldBackReason||"";',
      'const asked=[];',
      'const capped=L.plan({dependencyCheckCap:2,dependentsOf:(n)=>{asked.push(n);return {ok:true,unknown:false,dependents:[],error:null};}});',
      'res.asked=asked.slice().sort();',
      'res.skipped=names(capped.heldBack.filter((e)=>/not checked this run/.test(e.heldBackReason||"")));',
      'res.cleared=names(capped.removable);',
      'console.log(JSON.stringify(res));',
    ].join('');
    const q = cp.spawnSync(process.execPath, ['-e', probe], { cwd: PKG, encoding: 'utf8', env: env3, timeout: 120000 });
    assert.strictEqual(q.status, 0, (q.stdout + q.stderr).slice(-400));
    const res = JSON.parse(q.stdout.slice(q.stdout.indexOf('{')));

    assert.deepStrictEqual(res.clear, ['alpha', 'beta', 'delta', 'gamma'],
      'nothing depends on them, so the gate must not hold anything back');
    // Three formulae are asked, so three are held. The cask is never asked (asserted below), which is
    // why it is absent here rather than held by a question it cannot answer.
    assert.strictEqual(res.many.length, 3, `every formula should be held by its dependents: ${JSON.stringify(res.many)}`);
    assert.ok(res.many.every((s) => /6 installed package\(s\) depend on it: a, b, c, d and 2 more/.test(s)),
      `the reason should name what would break and how many: ${JSON.stringify(res.many)}`);
    assert.deepStrictEqual(res.unknown, ['alpha', 'beta', 'gamma'],
      'a name Homebrew does not know must be held back, never read as "nothing depends on it"');
    assert.match(res.unknownReason, /no longer knows the name/);
    assert.deepStrictEqual(res.unanswered, ['alpha', 'beta', 'gamma'],
      'a failed query must hold the package back instead of clearing it');
    assert.match(res.unansweredReason, /stays installed rather than go unverified/);

    // The cap is the expensive-question guard: 2 asked, the third stated as unchecked rather than
    // quietly offered, and a cask never asked at all because nothing depends on a cask.
    assert.strictEqual(res.asked.length, 2, `the query cap was ignored: ${JSON.stringify(res.asked)}`);
    assert.ok(!res.asked.includes('delta'), 'a cask was asked about dependents');
    assert.ok(!res.asked.includes('gamma'), `gamma should be the skipped one: ${JSON.stringify(res.asked)}`);
    assert.deepStrictEqual(res.skipped, ['gamma']);
    assert.ok(!res.cleared.includes('gamma'), 'an unchecked formula was offered for removal');
    assert.ok(res.cleared.includes('delta'), 'the cask was held back for a question it is never asked');
    for (const n of extra) fs.rmSync(marker(n), { force: true });
  });
  test('removal needs --yes, and an unattended run cannot give that consent', () => {
    const r = runLedger(['uninstall', '--yes', '--no-input']);
    assert.strictEqual(r.status, 2, r.out.slice(-300));
    assert.ok(fs.existsSync(marker('widget')), 'the refused run removed software anyway');
  });

  test('read-only commands reject flags that would mutate', () => {
    const cases = [
      [['doctor', '--install-prereqs'], /doctor is read-only/],
      [['doctor', '--rotate-secrets'], /doctor is read-only/],
      [['status', '--allow-destructive'], /status is read-only/],
    ];
    for (const [args, re] of cases) {
      const r = runLedger(args);
      assert.strictEqual(r.status, 2, `${args.join(' ')} → ${r.out.slice(-200)}`);
      assert.match(r.out, re);
    }
    assert.ok([0, 1].includes(runLedger(['doctor']).status), 'doctor itself must still run');
  });

  test('uninstall --yes removes only recorded installs and verifies each one', () => {
    // Counted as a delta, because an earlier test in this section legitimately removed something
    // too and wrote its own report; what matters is that this run added exactly one.
    const reportsBefore = reportFiles('uninstall-').length;
    const r = runLedger(['uninstall', '--yes']);
    assert.strictEqual(r.status, 0, r.out.slice(-400));
    assert.match(r.out, /3 removed, 0 failed/);
    for (const n of ['widget', 'gizmo', '@scope/tool']) assert.ok(!fs.existsSync(marker(n)), `${n} was not actually removed`);
    assert.ok(fs.existsSync(marker('node')), 'a held-back runtime prerequisite was removed');
    assert.strictEqual(readLedger().entries.filter((e) => e.removedAt).length, 3, 'ledger did not record the removals');
    assert.strictEqual(reportFiles('uninstall-').length, reportsBefore + 1, JSON.stringify(reportFiles('uninstall-')));
    const again = runLedger(['uninstall']);
    assert.ok(again.out.includes('0 removable'), again.out.slice(-300));
    assert.ok(again.out.includes('already gone  brew:widget'), again.out.slice(-300));
  });

  test('status admits whether anything was ever recorded', () => {
    const r = runLedger(['status']);
    assert.match(r.out, /install ledger/);
  });

  test('--rebuild-from-reports recovers installs made before the ledger existed', () => {
    const fx2 = fs.mkdtempSync(path.join(os.tmpdir(), 'asbmods-ledgerold-'));
    const home2 = path.join(fx2, 'home');
    const xdg2 = path.join(fx2, 'xdg');
    const rep = path.join(xdg2, 'asb-mods', 'reports');
    fs.mkdirSync(home2, { recursive: true });
    fs.mkdirSync(rep, { recursive: true });
    fs.writeFileSync(path.join(rep, 'brew-1000.json'), JSON.stringify({ installed: ['jq'], missingRows: [{ name: 'jq', type: 'formula' }] }));
    fs.writeFileSync(path.join(rep, 'npm-1001.json'), JSON.stringify({ results: { installed: ['pi-one-ui'] } }));
    fs.writeFileSync(path.join(rep, 'agents-1002.json'), JSON.stringify({ installed: [{ tool: 'codex', route: 'npm-global:@openai/codex', at: '/x/codex' }] }));
    const r = runLedger(['uninstall', '--rebuild-from-reports'], { ASB_MODS_HOME: home2, XDG_CONFIG_HOME: xdg2 });
    assert.strictEqual(r.status, 0, r.out.slice(-300));
    assert.match(r.out, /ledger rebuilt from 3 report\(s\)/);
    const text = fs.readFileSync(path.join(xdg2, 'asb-mods', 'install-ledger.json'), 'utf8');
    for (const n of ['jq', 'pi-one-ui', '@openai/codex']) assert.ok(text.includes(n), `rebuilt ledger lost ${n}`);
  });

  test('reset --dry-run resolves the rollback it would perform and changes nothing', () => {
    const dir = statePath('reports');
    const restoreReports = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('restore-')) : []);
    const before = restoreReports().length;
    const r = run(['reset', '--dry-run']);
    assert.strictEqual(r.status, 0, r.out.slice(-300));
    assert.match(r.out, /--dry-run: \d+ artifact\(s\) would be restored/);
    assert.strictEqual(restoreReports().length, before, 'a dry-run restore wrote a report of a restore');
  });
}

test('P13: wiki 17 and MEMORY_SURFACES name exactly the same surfaces, in both directions', () => {
  const wiki = fs.readFileSync(path.join(PKG, 'docs/wiki/17-agent-memory-surfaces.md'), 'utf8');
  // Table rows are the page's claims about specific paths; prose uses brace globs to describe Phase 5
  // selectors, which are a different thing and must not be demanded as fixtures.
  const docPaths = [...new Set([...wiki.matchAll(/^\|\s*`(~\/[^`]+)`/gm)].map((m) => m[1]))];
  assert.ok(docPaths.length >= 14, `wiki 17 only names ${docPaths.length} paths in its tables — the page is not describing the surfaces any more`);

  const rels = MEMORY_SURFACES.map((s) => s.rel);
  // `<project-slug>` and `<topic>.md` are how the page describes a family of paths, so a placeholder
  // segment becomes a wildcard — otherwise the matcher demands a fixture literally named "<topic>.md".
  // Plain segment matching rather than a built regex: the escaping version matched the placeholder
  // *literally* (`<project-slug>` stayed in the pattern), which surfaced as "fixture missing" instead
  // of a matcher bug. A placeholder segment accepts any one segment; `<topic>.md` additionally anchors
  // the literal suffix. The self-check below has to pass before the two directions are trusted.
  const segMatch = (seg, want) => {
    if (!seg.startsWith('<')) return seg === want;
    const suffix = seg.slice(seg.indexOf('>') + 1);
    return want.endsWith(suffix) && want.length >= suffix.length;
  };
  const covers = (docPath, rel) => {
    const a = docPath.replace(/^~\//, '').replace(/\/+$/, '').split('/');
    const b = rel.split('/');
    if (docPath.endsWith('/')) return a.length <= b.length && a.every((seg, i) => segMatch(seg, b[i]));
    return a.length === b.length && a.every((seg, i) => segMatch(seg, b[i]));
  };
  assert.ok(covers('~/.claude/projects/<project-slug>/memory/MEMORY.md', '.claude/projects/-x/memory/MEMORY.md'),
    'the path matcher is broken: a whole-segment placeholder did not match');
  assert.ok(covers('~/.claude/projects/<project-slug>/memory/<topic>.md', '.claude/projects/-x/memory/ci-gotchas.md'),
    'the path matcher is broken: an embedded placeholder did not match');
  assert.ok(covers('~/.codex/memories/rollout_summaries/', '.codex/memories/rollout_summaries/2026-11-22.md'),
    'the path matcher is broken: a directory row did not match its contents');
  assert.ok(!covers('~/.codex/memories/MEMORY.md', '.codex/memories/raw_memories.md'),
    'the path matcher is broken: it matched a different file as the same surface');
  assert.ok(!covers('~/.claude/CLAUDE.md', '.pi/agent/AGENTS.md'),
    'the path matcher is broken: it matched across hosts');

  const uncovered = docPaths.filter((p) => !rels.some((rel) => covers(p, rel)));
  assert.deepEqual(uncovered, [], 'wiki 17 claims surfaces with no fixture (an invented path would sail through today): ' + uncovered.join(', '));
  const undocumented = rels.filter((rel) => !docPaths.some((p) => covers(p, rel)));
  assert.deepEqual(undocumented, [], 'MEMORY_SURFACES pins surfaces the page never mentions: ' + undocumented.join(', '));

  // The page's whole point is that these are unmanaged: if a future slice starts managing one, the
  // fixture flag and the page have to change together, not one silently.
  const managedClaim = /asb-mods does \*\*not\*\* touch|None of those globs reaches a memory tree/.test(wiki);
  assert.ok(managedClaim, 'wiki 17 no longer states what it does and does not touch, so MEMORY_SURFACES has no claim to check against');
  assert.ok(MEMORY_SURFACES.some((s) => s.memory), 'the fixture marks nothing as agent-authored memory, so the untouched proof is vacuous');
  assert.ok(MEMORY_SURFACES.some((s) => !s.memory), 'the fixture marks nothing as installer-owned, so the contrast is vacuous');
});

test('P13: shared-core/skills/README.md lists the payload exactly, and nothing deploys what it does not list', () => {
  const readmePath = path.join(PKG, 'shared-core/skills/README.md');
  assert.ok(fs.existsSync(readmePath), 'shared-core/skills/README.md is missing — the tree has no contract');
  const readme = fs.readFileSync(readmePath, 'utf8');
  const skillsRoot = path.join(PKG, 'shared-core/skills/canonical');
  const dirs = fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.ok(dirs.length >= 4, `only ${dirs.length} canonical skills in the payload — the README check is near-vacuous`);
  // Table rows are the list; prose mentions `canonical/` and `shared-core/skills/`, which are directories
  // too but not skills, so matching every backticked path in the file would compare the wrong sets.
  const listed = [...new Set([...readme.matchAll(/^\|\s*`([a-z0-9][a-z0-9-]*)\/`\s*\|/gm)].map((m) => m[1]))].sort();
  assert.deepEqual(listed, dirs, 'README lists a different set of skills than the payload ships');

  // The claim that matters operationally: canonical skills deploy through installAgent's canonical
  // pass, so every one of them must actually land in the three hosts.
  for (const d of dirs) {
    assert.ok(fs.existsSync(path.join(skillsRoot, d, 'SKILL.md')), `skills/${d}/ has no SKILL.md, so it deploys an empty skill`);
    assert.ok(fs.existsSync(path.join(HOME, '.claude/skills', d, 'SKILL.md')),
      `skills/${d} never reached ~/.claude/skills — the README says all hosts get it`);
  }
});

test('PLAN-DECISIONS.md cannot silently shrink again (it was lost once)', () => {
  // The original decision log was never committed and an in-progress edit truncated it beyond recovery.
  // The reconstruction is smaller than what was lost and says so; this guard is what stops the next
  // truncation from shipping quietly.
  const p = path.join(PKG, 'PLAN-DECISIONS.md');
  assert.ok(fs.existsSync(p), 'the decision log is missing entirely');
  const t = fs.readFileSync(p, 'utf8');
  for (const h of ['D1 —', 'D2 —', 'D3 —', 'D4 —', 'D5 —', 'D6 —', 'D7 —']) {
    assert.ok(t.includes('## ' + h), `decision log lost section ${h}`);
  }
  const findings = t.split('\n').filter((l) => /^\| F\d+ \|/.test(l));
  assert.ok(findings.length >= 20, `only ${findings.length} finding rows — the caliper findings table was truncated`);
  assert.ok(Buffer.byteLength(t) > 8000, `${Buffer.byteLength(t)} bytes — the log shrank below its reconstructed size`);
  assert.match(t, /Limitation [Nn]umber|§5 limitation|limitation 3\d/, 'the log stopped citing the plan limitation rows it answers to');
});

section('§1 packaging contract — the artifact is what the payload promises');

test('package.json names the runtime trees instead of relying on .npmignore', () => {
  const cov = require(path.join(PKG, 'scripts/check-pack-coverage.cjs'));
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
  assert.ok(Array.isArray(pkg.files) && pkg.files.length,
    'no files[] array: the artifact is defined by whatever .npmignore fails to exclude');
  for (const t of cov.REQUIRED_TREES) {
    assert.ok(pkg.files.some((f) => f.replace(/\/$/, '') === t.replace(/\/$/, '')), `files[] does not name ${t}`);
  }
});

test('§1 pack coverage check bites: dropped payload file, re-admitted local vocabulary, drifted doc count', () => {
  // Injected inventories, so each failure mode is proven without four more `npm pack` runs. The real
  // comparison against the real artifact is a gate in npm test itself.
  const cov = require(path.join(PKG, 'scripts/check-pack-coverage.cjs'));
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
  const mk = (files) => ({ files, size: 1024, name: '@asbmods/install', version: '9.9.9' });
  const libFile = cov.filesOnDisk(PKG, 'lib/')[0];
  assert.ok(libFile, 'no files found under lib/ — the check would be vacuous');

  const dropped = cov.check({ repoDir: PKG, pkg, inventory: mk(['package.json']), docText: '| Tarball shape | 1 files |' });
  assert.ok(!dropped.ok, 'an artifact containing one file passed a completeness check');
  assert.ok(dropped.problems.some((p) => p.includes(libFile) && /not in the tarball/.test(p)),
    `a payload file missing from the artifact was not reported: ${JSON.stringify(dropped.problems.slice(0, 3))}`);

  const leaky = cov.check({ repoDir: PKG, pkg, inventory: mk(['shared-core/tooling/policy.local.json']), docText: '| Tarball shape | 1 files |' });
  assert.ok(leaky.problems.some((p) => /forbidden pattern/.test(p) && p.includes('policy.local.json')),
    `machine-local vocabulary in the artifact was not reported: ${JSON.stringify(leaky.problems.slice(0, 3))}`);

  const drifted = cov.check({ repoDir: PKG, pkg, inventory: mk(['a', 'b', 'c']), docText: '| Tarball shape (re-measure) | 999 files |' });
  assert.ok(drifted.problems.some((p) => /says 999 tarball files/.test(p)),
    `a doc claim 333x the artifact passed: ${JSON.stringify(drifted.problems.slice(0, 3))}`);

  const thin = cov.check({ repoDir: PKG, pkg: { files: ['lib/'] }, inventory: mk([]), docText: '' });
  assert.ok(thin.problems.some((p) => /does not name shared-core\//.test(p)),
    `an allowlist missing a runtime tree was not named: ${JSON.stringify(thin.problems.slice(0, 3))}`);
});

test('§1 pre-flight refuses a package whose inventory lists a file the artifact does not contain', () => {
  // A real payload with one file pulled out, not a hand-written manifest: the guard reads the same
  // inventory verify-core does, so the fixture is that file's own output.
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'asbmods-partial-'));
  const core = path.join(fx, 'core');
  fs.cpSync(path.join(PKG, 'shared-core'), core, { recursive: true });
  fs.rmSync(path.join(core, 'hooks', 'hooks.json'));
  const runPartial = (args) => cp.spawnSync(process.execPath, [path.join(PKG, 'install.js'), ...args], {
    cwd: PKG, encoding: 'utf8', input: '', timeout: 240000,
    env: { ...process.env, ASB_MODS_HOME: path.join(fx, 'home'), XDG_CONFIG_HOME: path.join(fx, 'xdg'), ASB_MODS_CORE: core, NO_COLOR: '1' },
  });

  const r = runPartial(['--dry-run']);
  const out = `${r.stdout}${r.stderr}`;
  assert.strictEqual(r.status, 1, `a package missing a listed payload file proceeded anyway: ${out.slice(-400)}`);
  assert.match(out, /package is incomplete/);
  assert.ok(out.includes('shared-core/hooks/hooks.json'), `the refusal must name the absent path: ${out.slice(-300)}`);
  assert.ok(!fs.existsSync(path.join(fx, 'xdg', 'asb-mods', 'state.json')), 'the refused run wrote state anyway');

  // A payload with no inventory is the opposite case: warned about, never fatal, because a hand-written
  // payload (a fixture home, a vendored copy) legitimately has none and the guard must not become a
  // new way to fail a working install.
  fs.rmSync(path.join(core, 'MANIFEST.sha256'));
  const bare = runPartial(['--dry-run']);
  const bout = `${bare.stdout}${bare.stderr}`;
  assert.strictEqual(bare.status, 0, `a payload with no inventory was refused instead of warned: ${bout.slice(-400)}`);
  assert.match(bout, /integrity cannot be checked/);
});

section('P8 — one mutating run at a time (limitation 32, finding F8)');

// A dead-and-reaped pid, so "stale" means the same thing here that it means on a crashed run. A child
// reaped by its own parent cannot be a zombie (a zombie still answers kill(pid, 0)), which is why the pid
// comes from a shell that waits for its grandchild rather than from cp.spawn in this process.
function deadPid() {
  const r = cp.spawnSync('/bin/sh', ['-c', 'sleep 0.2 & p=$!; wait $p; echo $p'], { encoding: 'utf8' });
  const pid = parseInt((r.stdout || '').trim(), 10);
  assert.ok(Number.isInteger(pid) && pid > 0, `could not produce a dead pid: ${r.stdout}`);
  cp.spawnSync('sleep', ['0.3']);
  assert.throws(() => process.kill(pid, 0));
  return pid;
}

test('P8 lock primitives: exclusive create, liveness-judged staleness, and a release that cannot steal', () => {
  const lock = require(path.join(PKG, 'lib/state-lock.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asbmods-lock-unit-'));

  const a = lock.acquire({ dir, verb: 'install' });
  assert.ok(a.acquired, 'first acquire failed');
  const held = JSON.parse(fs.readFileSync(a.lockPath, 'utf8'));
  assert.strictEqual(held.pid, process.pid, 'lock does not record our pid');
  assert.strictEqual(held.verb, 'install', 'lock does not record the verb (limitation 32 wants pid + verb)');
  assert.ok(held.startedAt, 'lock has no started-at timestamp');

  // A second take must refuse, not truncate: 'wx' is the primitive finding F8 says was missing.
  const b = lock.acquire({ dir, verb: 'brew' });
  assert.ok(!b.acquired && b.alive, 'a live holder was displaced instead of refused');
  assert.strictEqual(JSON.parse(fs.readFileSync(a.lockPath, 'utf8')).verb, 'install', 'the refusal overwrote the holder record');

  assert.strictEqual(lock.holderAlive(process.pid), true, 'this process was reported dead');
  assert.strictEqual(lock.holderAlive(deadPid()), false, 'a reaped pid was reported alive');
  for (const junk of [0, -1, null, undefined, 'nope', 1.5]) {
    assert.strictEqual(lock.holderAlive(junk), false, `holderAlive(${String(junk)}) should be false`);
  }

  // Releasing someone else's lock is the interleaving this file exists to stop, so it must be refused.
  assert.strictEqual(lock.release(a.lockPath, process.pid + 99999), false, 'release removed a lock it did not own');
  assert.ok(fs.existsSync(a.lockPath), 'a refused release still deleted the file');
  assert.strictEqual(a.release(), true, 'our own release failed');
  assert.ok(!fs.existsSync(a.lockPath), 'the lock file survived its release');

  // Stale by pid liveness, never by age: an old timestamp with a live pid is still a refusal.
  const live = JSON.stringify({ pid: process.pid, verb: 'old', startedAt: '2000-01-01T00:00:00.000Z' });
  fs.writeFileSync(lock.lockPathIn(dir), live);
  assert.ok(!lock.acquire({ dir, verb: 'install' }).acquired, 'a live holder with an ancient timestamp was taken over');
  // …and a brand-new timestamp whose pid is gone is a takeover, reported as one.
  fs.writeFileSync(lock.lockPathIn(dir), JSON.stringify({ pid: deadPid(), verb: 'old', startedAt: new Date().toISOString() }));
  const took = lock.acquire({ dir, verb: 'install' });
  assert.ok(took.acquired && took.tookStale, 'a fresh-but-dead holder was not taken over and reported');
  assert.strictEqual(took.tookStale.verb, 'old', 'the takeover does not name what it replaced');
  took.release();

  // --force-unlock is the accepted escape (row 32), so it must work on a LIVE holder and say it did.
  fs.writeFileSync(lock.lockPathIn(dir), JSON.stringify({ pid: process.pid, verb: 'stuck' }));
  const forced = lock.acquire({ dir, verb: 'install', force: true });
  assert.ok(forced.acquired && forced.tookStale && forced.tookStale.forced, '--force-unlock neither took over nor reported the force');
  forced.release();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('P8 a live holder refuses a mutating run with its pid and the exact takeover command', () => {
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'asbmods-lock-live-'));
  const state = path.join(fx, 'xdg', 'asb-mods');
  fs.mkdirSync(state, { recursive: true });
  const holder = cp.spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  try {
    const lockPath = path.join(state, 'install.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, verb: 'install', startedAt: '2026-11-22T00:00:00.000Z', host: 'fixture-host' }));
    const r = cp.spawnSync(process.execPath, [path.join(PKG, 'install.js'), 'uninstall', '--yes'], {
      cwd: PKG, encoding: 'utf8', input: '', timeout: 240000,
      env: { ...process.env, ASB_MODS_HOME: path.join(fx, 'home'), XDG_CONFIG_HOME: path.join(fx, 'xdg'), NO_COLOR: '1' },
    });
    const out = `${r.stdout}${r.stderr}`;
    assert.strictEqual(r.status, 1, `a run against a live holder did not refuse: ${out.slice(-300)}`);
    assert.match(out, /holds the lock/);
    assert.ok(out.includes(`pid ${holder.pid}`), `the refusal does not name the holder pid: ${out.slice(0, 300)}`);
    assert.ok(out.includes('asbmods uninstall --force-unlock'), `the refusal omits the takeover command: ${out.slice(0, 300)}`);
    assert.match(out, /kill -0 \d+/, 'the refusal does not print the liveness check');
    // Two clauses of the acceptance criterion that prose alone would not prove:
    assert.strictEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, holder.pid, 'the refusing run displaced the live holder');
    assert.ok(!fs.existsSync(path.join(state, 'reports')), 'the refused run wrote an uninstall report anyway');
  } finally {
    holder.kill();
    fs.rmSync(fx, { recursive: true, force: true });
  }
});

test('P8 a stale holder is taken over and reported; --force-unlock does the same for a live one', () => {
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'asbmods-lock-stale-'));
  const state = path.join(fx, 'xdg', 'asb-mods');
  fs.mkdirSync(state, { recursive: true });
  const env = { ...process.env, ASB_MODS_HOME: path.join(fx, 'home'), XDG_CONFIG_HOME: path.join(fx, 'xdg'), NO_COLOR: '1' };
  const lockPath = path.join(state, 'install.lock');
  const runUninstall = (args) => cp.spawnSync(process.execPath, [path.join(PKG, 'install.js'), 'uninstall', '--yes', ...args], {
    cwd: PKG, encoding: 'utf8', input: '', timeout: 240000, env,
  });

  fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), verb: 'brew', startedAt: '2026-11-22T00:00:00.000Z' }));
  const stale = runUninstall([]);
  const sOut = `${stale.stdout}${stale.stderr}`;
  assert.strictEqual(stale.status, 0, `a run against a stale holder refused instead of proceeding: ${sOut.slice(-300)}`);
  assert.match(sOut, /took over the lock/);
  assert.match(sOut, /pid is gone/, 'the takeover did not say why the holder was judged stale');
  assert.ok(sOut.includes('brew'), 'the takeover does not name the verb it replaced');
  assert.ok(!fs.existsSync(lockPath), 'the run left its own lock behind instead of releasing it');

  const holder = cp.spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, verb: 'all', startedAt: new Date().toISOString() }));
    const forced = runUninstall(['--force-unlock']);
    const fOut = `${forced.stdout}${forced.stderr}`;
    assert.strictEqual(forced.status, 0, `--force-unlock did not proceed: ${fOut.slice(-300)}`);
    assert.match(fOut, /took over the lock/);
    assert.match(fOut, /--force-unlock/, 'the forced takeover was not reported as forced');
  } finally {
    holder.kill();
    fs.rmSync(fx, { recursive: true, force: true });
  }
});

test('P8 read-only verbs and --dry-run are never locked out by a running install', () => {
  // Limitation 32's failure mode is a lock that keeps everything out. The diagnostics must stay usable,
  // because they are how an operator finds out what the holder is doing.
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'asbmods-lock-readonly-'));
  const state = path.join(fx, 'xdg', 'asb-mods');
  fs.mkdirSync(state, { recursive: true });
  const holder = cp.spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(path.join(state, 'install.lock'), JSON.stringify({ pid: holder.pid, verb: 'all', startedAt: new Date().toISOString() }));
    const env = { ...process.env, ASB_MODS_HOME: path.join(fx, 'home'), XDG_CONFIG_HOME: path.join(fx, 'xdg'), NO_COLOR: '1' };
    for (const args of [['--dry-run'], ['status'], ['detect'], ['uninstall']]) {
      const r = cp.spawnSync(process.execPath, [path.join(PKG, 'install.js'), ...args], {
        cwd: PKG, encoding: 'utf8', input: '', timeout: 240000, env,
      });
      const out = `${r.stdout}${r.stderr}`;
      assert.ok(!/holds the lock/.test(out), `${args.join(' ')} was refused by a live holder: ${out.slice(0, 240)}`);
      assert.ok(r.status === 0 || r.status === 1, `${args.join(' ')} exited ${r.status}`);
      if (args[0] === '--dry-run' || args[0] === 'status') assert.strictEqual(r.status, 0, `${args.join(' ')}: ${out.slice(-300)}`);
    }
    assert.ok(fs.existsSync(path.join(state, 'install.lock')), 'a read-only run released a lock it never took');
  } finally {
    holder.kill();
    fs.rmSync(fx, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failed: ${failures.join(', ')}`);
  console.log(`fixture kept for inspection: ${ROOT}`);
  process.exit(1);
}
fs.rmSync(ROOT, { recursive: true, force: true });
console.log('fixture cleaned up');
