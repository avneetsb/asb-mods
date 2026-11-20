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
  const bad = ['/Users/', 'artifactory', 'internal.example', '', 'NPM_INTERNAL_TOKEN', 'gateway-internal'];
  const hits = [];
  for (const f of packagedFiles()) {
    const t = fs.readFileSync(f, 'utf8');
    for (const tok of bad) if (t.includes(tok)) hits.push(`${path.relative(REPO, f)}: ${tok}`);
  }
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
test('no Cursor references remain in packaged data or code', () => {
  const hits = [];
  for (const f of packagedFiles()) {
    const t = fs.readFileSync(f, 'utf8');
    if (path.relative(REPO, f).startsWith(path.join('shared-core', 'tooling') + path.sep)) continue; // restored artifacts may legitimately name their host agents
    if (/\bcursor\b/i.test(t) && !/retired|historical|removed|dropped/i.test(t)) hits.push(path.relative(REPO, f));
  }
  assert.deepStrictEqual(hits, [], `Cursor still referenced in: ${hits.join(', ')}`);
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
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failed: ${failures.join(', ')}`);
  console.log(`fixture kept for inspection: ${ROOT}`);
  process.exit(1);
}
fs.rmSync(ROOT, { recursive: true, force: true });
console.log('fixture cleaned up');
