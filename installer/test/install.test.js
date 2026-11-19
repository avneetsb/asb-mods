const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const ASB_CORE = path.join(HOME, 'Dev', 'asb-mods', 'shared-core');
const INS_DIR = path.join(HOME, 'Dev', 'asb-mods', 'installer');
let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); console.log('  PASS: ' + name); passed++; }
  catch(e) { console.log('  FAIL: ' + name + ' - ' + e.message); failed++; }
}

console.log('\n[asbmod-install tests]\n');

// Core files
test('shared-core exists', () => assert(fs.existsSync(ASB_CORE)));
test('hooks/hooks.json', () => assert(fs.existsSync(path.join(ASB_CORE, 'hooks', 'hooks.json'))));
test('hooks/generate-adapters.sh executable', () => {
  const p = path.join(ASB_CORE, 'hooks', 'generate-adapters.sh');
  const s = fs.statSync(p);
  assert(s.isFile() && (s.mode & 0o111), 'not executable');
});
test('brew/install.sh exists', () => assert(fs.existsSync(path.join(ASB_CORE, 'brew', 'install.sh'))));
test('env/shell-env.sh exists', () => assert(fs.existsSync(path.join(ASB_CORE, 'env', 'shell-env.sh'))));
test('cutover/archive.sh exists', () => assert(fs.existsSync(path.join(ASB_CORE, 'cutover', 'archive.sh'))));
test('DEPENDENCY-MAP.json valid', () => {
  const d = JSON.parse(fs.readFileSync(path.join(HOME, 'Dev', 'asb-mods', 'DEPENDENCY-MAP.json'), 'utf8'));
  assert.equal(d.version, '1.0.0');
});

// Installer package
test('package.json exists', () => assert(fs.existsSync(path.join(INS_DIR, 'package.json'))));
test('bin/install.js exists and executable', () => {
  const p = path.join(INS_DIR, 'bin', 'install.js');
  assert(fs.existsSync(p));
  const s = fs.statSync(p);
  assert(s.isFile() && (s.mode & 0o111), 'not executable');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
