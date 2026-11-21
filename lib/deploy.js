'use strict';
// Phase 4: install the consolidated shared-core into each agent.
//
// Everything is written from packaged data (shared-core/**) and recorded in an
// installed-manifest so `status` can verify drift and `rollback` can undo precisely.
// Settings files are MERGED, never replaced: unknown user keys are preserved, and the
// pre-merge content is captured in the manifest so a single file can be restored.

const path = require('path');
const P = require('./paths');
const X = require('./fsx');
const fs = require('fs');
const T = require('./tooling');

// Package root, so bundle paths from the manifest resolve inside the installed package and
// never depend on a checkout location.
const ROOT = path.join(__dirname, '..');

const AGENT_SKILL_DIRS = {
  pi: () => path.join(P.HOME, '.agents', 'skills'),
  claude: () => path.join(P.agents.claude.dir, 'skills'),
  codex: () => path.join(P.agents.codex.dir, 'skills'),
};

const AGENT_PROMPT_DIRS = {
  pi: () => path.join(P.agents.pi.agentDir, 'prompts'),
  claude: () => path.join(P.agents.claude.dir, 'commands'),
  codex: () => path.join(P.agents.codex.dir, 'prompts'),
};

// Tokens allowed in packaged config (shared-core/**). Resolved per run so nothing
// shipped in the package can name one machine's home directory.
const VARS = {
  ...X.vars(P),
};
// Deep merge where `incoming` wins on scalars/arrays-of-objects-by-key, but any key the
// package does not mention is left exactly as the user had it.
function mergeInto(target, incoming, opts = {}) {
  const changes = [];
  const arraysAsSets = opts.arraysAsSets || ['packages', 'extensions'];
  const walk = (t, s, trail) => {
    for (const [k, v] of Object.entries(s)) {
      const here = trail.concat(k);
      if (Array.isArray(v)) {
        if (!Array.isArray(t[k])) { t[k] = [...v]; changes.push({ path: here.join('.'), change: 'added' }); continue; }
        if (arraysAsSets.includes(k)) {
          const seen = new Set(t[k].map((x) => JSON.stringify(x)));
          let added = 0;
          for (const item of v) {
            const key = JSON.stringify(item);
            if (!seen.has(key)) { t[k].push(item); seen.add(key); added += 1; }
          }
          if (added) changes.push({ path: here.join('.'), change: 'appended', count: added });
        } else {
          const before = JSON.stringify(t[k]);
          t[k] = v;
          if (before !== JSON.stringify(v)) changes.push({ path: here.join('.'), change: 'replaced' });
        }
        continue;
      }
      if (v && typeof v === 'object') {
        if (!t[k] || typeof t[k] !== 'object' || Array.isArray(t[k])) {
          t[k] = {};
          changes.push({ path: here.join('.'), change: 'created' });
        }
        walk(t[k], v, here);
        continue;
      }
      if (t[k] !== v) { t[k] = v; changes.push({ path: here.join('.'), change: 'set' }); }
    }
  };
  walk(target, incoming, []);
  return changes;
}

function canonicalSkills() {
  const root = path.join(P.CORE, 'skills', 'canonical');
  if (!X.isDir(root)) return [];
  return X.listDirs(root).filter((d) => X.isFile(path.join(root, d, 'SKILL.md')));
}

function deploySkills(log) {
  const skills = canonicalSkills();
  const actions = [];
  for (const [agent, dirFn] of Object.entries(AGENT_SKILL_DIRS)) {
    const dest = dirFn();
    X.mkdirp(dest);
    for (const s of skills) {
      const src = path.join(P.CORE, 'skills', 'canonical', s, 'SKILL.md');
      const dst = path.join(dest, s, 'SKILL.md');
      const existed = X.isFile(dst);
      const same = existed && X.readFileSyncSafe(dst) === X.readFileSyncSafe(src);
      if (same) { actions.push({ agent, kind: 'skill', path: dst, action: 'unchanged' }); continue; }
      X.copy(src, dst);
      actions.push({ agent, kind: 'skill', path: dst, action: existed ? 'updated' : 'created' });
    }
    if (log) log('ok', `${agent}: ${skills.length} canonical skill(s) -> ${dest}`);
  }
  return actions;
}

function deployPrompts(log) {
  const root = path.join(P.CORE, 'prompts', 'master');
  if (!X.isDir(root)) return [{ kind: 'prompt', action: 'skipped', reason: 'shared-core/prompts/master missing' }];
  const names = X.filesIn(root).filter((n) => n.endsWith('.md')).sort();
  const actions = [];
  for (const [agent, dirFn] of Object.entries(AGENT_PROMPT_DIRS)) {
    const dest = dirFn();
    X.mkdirp(dest);
    for (const n of names) {
      const dst = path.join(dest, n);
      X.copy(path.join(root, n), dst);
      actions.push({ agent, kind: 'prompt', path: dst, action: 'created' });
    }
    if (log && names.length) log('ok', `${agent}: ${names.length} prompt(s) -> ${dest}`);
  }
  return actions;
}

function deploySettings(log) {
  const actions = [];
  const frag = (agent) => path.join(P.CORE, 'agents', 'tool-specific', agent, 'settings-fragment.json');

  // pi: ~/.pi/agent/settings.json
  {
    const target = path.join(P.agents.pi.agentDir, 'settings.json');
    const current = X.readJSON(target, null);
    if (current && X.isFile(frag('pi'))) {
      const before = JSON.stringify(current);
      const incoming = X.readJSON(frag('pi'), {});
      const stripped = X.resolvePlaceholders(stripNonSettingsKeys(incoming), VARS);
      const changes = mergeInto(current, stripped, { arraysAsSets: ['packages', 'extensions'] });
      if (before !== JSON.stringify(current)) {
        X.backupString(target, before);
        X.writeJSON(target, current);
      }
      actions.push({ agent: 'pi', kind: 'settings', path: target, changes: changes.length, changed: before !== JSON.stringify(current) });
      if (log) log('ok', `pi settings merged (${changes.length} change(s))`);
    } else if (log) log('warn', 'pi settings.json not found — skipped');
  }

  // claude: ~/.claude/settings.json
  {
    const target = path.join(P.agents.claude.dir, 'settings.json');
    const current = X.readJSON(target, null);
    if (current && X.isFile(frag('claude'))) {
      const before = JSON.stringify(current);
      const incoming = X.resolvePlaceholders(stripNonSettingsKeys(X.readJSON(frag('claude'), {})), VARS);
      const changes = mergeInto(current, incoming, { arraysAsSets: ['permissions.allow', 'permissions.deny'].slice(0, 0) });
      if (before !== JSON.stringify(current)) {
        X.backupString(target, before);
        X.writeJSON(target, current);
      }
      actions.push({ agent: 'claude', kind: 'settings', path: target, changes: changes.length, changed: before !== JSON.stringify(current) });
      if (log) log('ok', `claude settings merged (${changes.length} change(s))`);
    } else if (log) log('warn', 'claude settings.json not found — skipped');
  }

  // codex: config.toml is TOML and holds live model/auth state — we never rewrite it.
  actions.push({
    agent: 'codex', kind: 'config.toml',
    path: path.join(P.agents.codex.dir, 'config.toml'),
    action: 'preserved', reason: 'TOML config holds live model/auth state; asb-mods writes hooks.json instead',
  });
  return actions;
}

// A fragment may carry documentation keys (purpose/_note) or nested maps that are not
// valid settings — drop those so we never write junk into a live agent config.
function stripNonSettingsKeys(obj) {
  const drop = /^(_|purpose$|installInstructions$|notes$|_description$)/;
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (drop.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function deployAgnostic(log) {
  const src = path.join(P.CORE, 'agents', 'agnostic');
  const actions = [];
  if (!X.isDir(src)) return actions;
  for (const n of require('fs').readdirSync(src)) {
    if (!n.endsWith('.json')) continue;
    const dst = path.join(P.STATE_DIR, 'agnostic', n);
    X.copy(path.join(src, n), dst);
    actions.push({ kind: 'agnostic', path: dst, action: 'created' });
  }
  if (log) log('ok', 'agent-agnostic defaults staged in state dir');
  return actions;
}

// Ship the packaged hook scripts into the state dir, because hooks.json registers
// commands that point at {{STATE_DIR}}/hooks/*.sh. Without this step the registered
// hooks would be dangling — the exact dead-link class the auditor flagged.
function deployHookBin(log) {
  const src = path.join(P.CORE, 'hooks', 'bin');
  if (!X.isDir(src)) return [{ kind: 'hook-bin', action: 'skipped', reason: 'shared-core/hooks/bin missing' }];
  const dest = path.join(P.STATE_DIR, 'hooks');
  X.mkdirp(dest);
  const actions = [];
  for (const name of X.filesIn(src).filter((n) => n.endsWith('.sh'))) {
    const dst = path.join(dest, name);
    X.copy(path.join(src, name), dst);
    require('fs').chmodSync(dst, 0o755);
    actions.push({ kind: 'hook-bin', path: dst, action: 'created' });
  }
  if (log && actions.length) log('ok', `hook scripts deployed: ${actions.length} -> ${dest}`);
  return actions;
}

// --- packaged personal tooling (shared-core/tooling) -------------------------------------------
// The parity contract: anything the destructive phase is allowed to remove has to come back from
// here, or a fresh machine cannot be reproduced from the package. tools/vendor.js writes the
// manifest; deployTooling is what makes it real on disk, and it is data-driven so adding a
// bundle needs no code change.


/** Deploy every vendored tooling bundle listed in the packaged manifest. */
function deployTooling(log) {
  const actions = [];
  const skipped = [];
  const manifest = T.readManifest();
  if (!manifest || !manifest.bundles.length) {
    if (log) log('warn', `no tooling manifest at ${T.manifestPath()} — run \`node tools/vendor.js\` before packaging; nothing to restore`);
    return { actions, bundles: 0, files: 0, skipped: [], error: 'no tooling manifest' };
  }
  const vars = X.vars(P);
  let fileCount = 0;

  for (const b of manifest.bundles) {
    const bundle = path.join(ROOT, b.bundle);
    const dest = X.resolvePlaceholders(b.dest, vars);
    if (!X.exists(bundle)) { skipped.push({ name: b.name, reason: 'bundle missing from package' }); continue; }

    if (b.layout === 'flatten') {
      // one bundle dir holding single files -> copied flat into a shared destination dir
      X.mkdirp(dest);
      let n = 0;
      for (const f of fs.readdirSync(bundle).sort()) {
        const src = path.join(bundle, f);
        let st; try { st = fs.statSync(src); } catch { continue; }
        if (!st.isFile()) continue;
        const dst = path.join(dest, f);
        const existed = X.isFile(dst);
        if (existed && fs.readFileSync(dst).equals(fs.readFileSync(src))) continue;
        fs.copyFileSync(src, dst);
        try { fs.chmodSync(dst, st.mode & 0o777); } catch { /* platform without chmod */ }
        n += 1;
        actions.push({ kind: 'tooling', name: b.name, path: dst, action: existed ? 'updated' : 'created' });
      }
      fileCount += n;
      if (n && log) log('ok', `${b.cls} ${b.name}: ${n} file(s) -> ${dest}`);
      continue;
    }

    // layout 'dir': the bundle directory becomes the destination directory
    const existed = X.isDir(dest);
    X.mkdirp(dest);
    let n = 0;
    for (const f of fs.readdirSync(bundle)) {
      const src = path.join(bundle, f);
      const dst = path.join(dest, f);
      let st; try { st = fs.statSync(src); } catch { continue; }
      if (st.isDirectory()) { X.mkdirp(dst); fs.cpSync(src, dst, { recursive: true }); } else {
        fs.copyFileSync(src, dst);
        try { fs.chmodSync(dst, st.mode & 0o777); } catch { /* platform without chmod */ }
      }
      n += 1;
    }
    fileCount += n;
    actions.push({ kind: 'tooling-package', name: b.name, path: dest, action: existed ? 'refreshed' : 'created', files: n });
    if (log) log('ok', `${b.cls} ${b.name}: ${n} file(s) -> ${dest}`);
  }

  const summary = { bundles: manifest.bundles.length, files: fileCount, actions, skipped };
  try {
    X.writeJSON(path.join(P.REPORT_DIR, `tooling-${Date.now()}.json`),
      { at: new Date().toISOString(), manifest: T.manifestPath(), bundles: summary.bundles, files: fileCount, skipped });
  } catch { /* reports are best effort */ }
  if (log) log('ok', `tooling restored: ${summary.bundles} bundle(s), ${fileCount} file(s)${skipped.length ? `, ${skipped.length} skipped` : ''}`);
  return summary;
}

/** Path of the packaged tooling manifest (reported by `status`). */
function toolingManifestPath() { return T.manifestPath(); }
function deploy(_opts, log) {
  const actions = [
    ...deploySkills(log),
    ...deployPrompts(log),
    ...deployHookBin(log),
    ...deploySettings(log),
    ...deployAgnostic(log),
    ...deployTooling(log).actions,
  ];
  return actions;
}

module.exports = { deploy, deploySkills, deployPrompts, deployHookBin, deploySettings, deployAgnostic, deployTooling, toolingManifestPath, mergeInto, canonicalSkills, AGENT_SKILL_DIRS, AGENT_PROMPT_DIRS, VARS };
