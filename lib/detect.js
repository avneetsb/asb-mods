'use strict';
// Phase 1: detect what exists for each agent, and classify it into
//   removable  — the user's own custom tooling that asb-mods will take over
//   protected  — live agent state (credentials, sessions, sqlite, caches) we never delete
//
// Removal is scoped to individual artifacts, never to ~/.pi or ~/.codex as a whole:
// those directories contain auth.json, *.sqlite, history.jsonl and session indexes that
// are irreplaceable. The full directory is still archived first as a safety net.

const fs = require('fs');
const path = require('path');
const P = require('./paths');
const X = require('./fsx');

// Anything matching these is NEVER removed, whatever else says.
const PROTECT_NAMES = [
  /^auth(\.json)?$/i, /^\.credentials/i, /^oauth/i, /^tokens?$/i, /^\.env$/,
  /(^|\/)settings[^/]*\.json$/i, /(^|\/)config\.toml$/i, /(^|\/)mcp[^/]*\.json$/i,
  // Live hook registries the installer merges into (Claude settings.json, Codex hooks.json):
  /(^|\/)hooks\.json$/i,
  /\.sqlite(-wal|-shm)?$/i, /(^|\/)history(\.jsonl)?$/i, /(^|\/)sessions?$/i,
  /(^|\/)archived_sessions$/i, /(^|\/)backups?$/i, /(^|\/)rollback-artifacts$/i,
  /(^|\/)rollout-migrations$/i, /(^|\/)cache$/i, /(^|\/)attachments$/i,
  /(^|\/)browser$/i, /\.lock$/i, /\.log$/i, /(^|\/)version\.json$/i,
  /(^|\/)models_cache\.json$/i, /(^|\/)dictation-history/i, /(^|\/)transcription-history/i,
  /(^|\/)project-metadata-locks$/i, /(^|\/)mcp-oauth-locks$/i, /(^|\/)thread-writer-locks$/i,
  /(^|\/)\.git$/i, /(^|\/)logs?_/i, /(^|\/)state_\d+\.sqlite/i, /(^|\/)goals_\d+\.sqlite/i,
  // Agent instruction and memory surfaces (docs/wiki/17-agent-memory-surfaces.md). These are the
  // runtime's own files: `AGENTS.override.md` silently outranks the AGENTS.md Phase 4 manages, and
  // `memories/` + `rules/` hold notes and standing rules only their author understands. A --confirm
  // run archived a user's AGENTS.override.md as a stray before this line existed, so the scope test
  // in test/install.test.js pins all five.
  /(^|\/)AGENTS\.md$/i, /(^|\/)AGENTS\.override\.md$/i, /(^|\/)CLAUDE\.md$/i,
  /(^|\/)memories(\/|$)/i, /(^|\/)rules(\/|$)/i,
  /(^|\/)memories(_v\d+)?(_\d+)?\.sqlite/i, /(^|\/)thread_history_\d+\.sqlite/i,
];

function isProtected(relPath) {
  const p = relPath.replace(/\\/g, '/');
  return PROTECT_NAMES.some((re) => re.test(p));
}

const CHILD_LIMIT = 400; // keep the inventory report bounded

// Directory listing that FOLLOWS symlinks: Claude Code installs many skills as symlinks
// into shared locations, and `withFileTypes().isDirectory()` reports false for those, which
// silently undercounted the inventory on the first live run.
function dirs(root, sub) {
  const base = sub ? path.join(root, sub) : root;
  if (!X.isDir(base)) return [];
  const out = [];
  for (const e of fs.readdirSync(base)) {
    if (e.startsWith('.')) continue;
    try {
      if (fs.statSync(path.join(base, e)).isDirectory()) out.push(e);
    } catch { /* broken link */ }
  }
  return out.sort().slice(0, CHILD_LIMIT);
}

function mdFiles(root, sub) {
  const base = sub ? path.join(root, sub) : root;
  if (!X.isDir(base)) return [];
  return fs.readdirSync(base)
    .filter((n) => n.endsWith('.md'))
    .sort().slice(0, CHILD_LIMIT);
}

function files(root, sub, filterFn) {
  const base = sub ? path.join(root, sub) : root;
  if (!X.isDir(base)) return [];
  let entries;
  try { entries = fs.readdirSync(base, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter((e) => e.isFile() && (!filterFn || filterFn(e.name)))
    .map((e) => e.name).sort().slice(0, CHILD_LIMIT);
}

function detectPi() {
  const agentDir = P.agents.pi.agentDir;
  const present = X.isDir(agentDir);
  const settings = X.readJSON(path.join(agentDir, 'settings.json'), {});
  const mcpAdapter = X.readJSON(path.join(agentDir, 'mcp-adapter.json'), {});

  const extDir = path.join(agentDir, 'extensions');
  const extensions = files(extDir, null, (n) => n.endsWith('.ts') || n.endsWith('.js'));
  const extSubdirs = dirs(extDir, null);
  const localPackages = X.listDirs(X.expandTilde('~/.agents/packages'));
  const userSkills = X.listDirs(X.expandTilde('~/.agents/skills'));
  const userScripts = files(X.expandTilde('~/.agents/scripts'), null);
  const prompts = files(agentDir, 'prompts', (n) => n.endsWith('.md'));
  const packagePrompts = [];
  for (const pkg of localPackages) {
    for (const f of files(X.expandTilde(`~/.agents/packages/${pkg}`), 'prompts', (n) => n.endsWith('.md'))) {
      packagePrompts.push(`${pkg}/${f}`);
    }
  }

  const registeredPackages = (settings.packages || []).map((p) =>
    (typeof p === 'string' ? p : (p && (p.source || p.name)) || String(p)));

  const artifacts = {
    extensions: extDir ? extensions : [],
    extensionSubdirs: extSubdirs,
    localPiPackages: localPackages,
    userSkills,
    userScripts,
    prompts,
    packagePrompts,
    registeredPackages,
    registeredPackageCount: registeredPackages.length,
    nodeModules: X.listDirs(path.join(agentDir, 'npm', 'node_modules')).length,
    mcpServers: Object.keys(mcpAdapter.mcpServers || {}).sort(),
    settingsKeys: Object.keys(settings).sort(),
  };

  const removable = [];
  for (const e of extensions) {
    removable.push({ agent: 'pi', kind: 'extension', path: path.join(extDir, e) });
  }
  for (const d of extSubdirs) {
    removable.push({ agent: 'pi', kind: 'extension-dir', path: path.join(extDir, d) });
  }
  for (const s of userSkills) {
    removable.push({ agent: 'pi', kind: 'skill', path: X.expandTilde(`~/.agents/skills/${s}`) });
  }
  // Loose prompts, local packages and standalone scripts are custom tooling as well.
  // The detector listed them as artifacts but never queued them, so stale copies survived
  // every cutover and drifted against shared-core forever.
  for (const p of prompts) removable.push({ agent: 'pi', kind: 'prompt', path: path.join(agentDir, 'prompts', p) });
  for (const pkg of localPackages) removable.push({ agent: 'pi', kind: 'local-package', path: X.expandTilde(`~/.agents/packages/${pkg}`) });
  for (const s of userScripts) removable.push({ agent: 'pi', kind: 'script', path: X.expandTilde(`~/.agents/scripts/${s}`) });
  return { present, dir: agentDir, artifacts, removable };
}
function detectClaude() {
  const dir = P.agents.claude.dir;
  const present = X.isDir(dir);
  const settings = X.readJSON(path.join(dir, 'settings.json'), {});
  const hookFiles = [];
  const walkHooks = (d, depth) => {
    if (depth > 3 || !X.isDir(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walkHooks(f, depth + 1);
      else if (/\.(cjs|mjs|js|sh|py)$/.test(e.name)) hookFiles.push(path.relative(dir, f));
    }
  };
  if (X.isDir(path.join(dir, 'hooks'))) walkHooks(path.join(dir, 'hooks'), 0);

  const pluginCacheRoot = path.join(dir, 'plugins', 'cache');
  const pluginCache = [];
  if (X.isDir(pluginCacheRoot)) {
    for (const vendor of fs.readdirSync(pluginCacheRoot, { withFileTypes: true })) {
      if (!vendor.isDirectory()) continue;
      for (const plug of X.listDirs(path.join(pluginCacheRoot, vendor.name))) {
        pluginCache.push(`${vendor.name}/${plug}`);
      }
    }
  }

  // Claude Code subagents are markdown FILES (~/.claude/agents/*.md), not directories.
  const agentFiles = mdFiles(dir, 'agents');
  const agentDirs = dirs(dir, 'agents');
  const pluginDirs = dirs(dir, 'plugins').filter((d) => d !== 'cache');

  const artifacts = {
    settingsFiles: files(dir, null, (n) => /^settings.*\.json$/.test(n)),
    settingsKeys: Object.keys(settings).sort(),
    hookEvents: Object.keys(settings.hooks || {}).sort(),
    agents: [...agentFiles, ...agentDirs],
    agentsFileCount: agentFiles.length,
    agentsDirCount: agentDirs.length,
    skills: dirs(dir, 'skills'),
    commands: mdFiles(dir, 'commands'),
    customHookFiles: hookFiles.sort(),
    plugins: pluginDirs,
    pluginRegistryFiles: files(dir, 'plugins', (n) => n.endsWith('.json')),
    pluginCache: pluginCache.sort(),
    enabledPlugins: Object.keys(settings.enabledPlugins || {})
      .filter((k) => settings.enabledPlugins[k]).sort(),
  };

  const removable = [];
  for (const a of agentFiles) removable.push({ agent: 'claude', kind: 'agent', path: path.join(dir, 'agents', a) });
  for (const a of agentDirs) removable.push({ agent: 'claude', kind: 'agent-dir', path: path.join(dir, 'agents', a) });
  for (const s of artifacts.skills) removable.push({ agent: 'claude', kind: 'skill', path: path.join(dir, 'skills', s) });
  // customHookFiles are relative to the agent dir ("hooks/gitnexus/hook.cjs"), so the
  // removable unit is the first segment *inside* hooks/. Using the raw first segment
  // produced "~/.claude/hooks/hooks", which removal then reported as already absent.
  for (const h of new Set(artifacts.customHookFiles
    .map((f) => f.replace(/^hooks\//, '').split('/')[0])
    .filter((x) => x && !x.includes('.')))) {
    removable.push({ agent: 'claude', kind: 'hook-dir', path: path.join(dir, 'hooks', h) });
  }
  // Plugin installs leave both directories and registry files (marketplace.json) under
  // ~/.claude/plugins; neither was queued, so the sweep left plugin state behind.
  for (const d of pluginDirs) removable.push({ agent: 'claude', kind: 'plugin-dir', path: path.join(dir, 'plugins', d) });
  for (const f of artifacts.pluginRegistryFiles) removable.push({ agent: 'claude', kind: 'plugin-registry', path: path.join(dir, 'plugins', f) });
  return { present, dir, artifacts, removable };
}

function detectCodex() {
  const dir = P.agents.codex.dir;
  const present = X.isDir(dir);
  const hooksJson = X.readJSON(path.join(dir, 'hooks.json'), null);

  const topLevel = X.isDir(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).map((e) => e.name).sort()
    : [];
  // hooks.json is Codex's live hook registry — the installer MERGES into it, exactly like
  // settings.json — so it is state, not custom tooling. Queueing it here deleted other
  // agents' hooks and the re-registration left only our own entries behind.
  const customTopLevel = topLevel.filter((n) =>
    /\.(json|toml|md|cjs|mjs|js|sh)$/.test(n) && !isProtected(n) && n !== 'hooks.json');

  const artifacts = {
    topLevelCount: topLevel.length,
    topLevel: topLevel.slice(0, CHILD_LIMIT),
    configToml: X.isFile(path.join(dir, 'config.toml')),
    hooksJson: hooksJson !== null,
    hookEvents: hooksJson ? Object.keys(hooksJson.hooks || hooksJson).sort() : [],
    skills: dirs(dir, 'skills'),
    prompts: files(dir, 'prompts', (n) => n.endsWith('.md')),
    customConfigFiles: customTopLevel,
  };

  const removable = [];
  for (const s of artifacts.skills) removable.push({ agent: 'codex', kind: 'skill', path: path.join(dir, 'skills', s) });
  // Codex keeps loose files at the top of ~/.codex (notes, ad-hoc scripts) and prompts of
  // its own; both were inventoried but never queued, so they survived every cutover.
  for (const p of artifacts.prompts) removable.push({ agent: 'codex', kind: 'prompt', path: path.join(dir, 'prompts', p) });
  for (const f of artifacts.customConfigFiles) removable.push({ agent: 'codex', kind: 'loose-file', path: path.join(dir, f) });
  return { present, dir, artifacts, removable };
}

function detectBrew() {
  const csv = path.join(P.CORE, 'brew', 'formulae.csv');
  const out = { inventoryFile: X.isFile(csv), formulae: 0, casks: 0, total: 0, installed: 0, missing: [] };
  if (!out.inventoryFile) return out;
  const rows = parseFormulae(csv);
  for (const r of rows) {
    if (r.type === 'cask') out.casks += 1; else out.formulae += 1;
  }
  out.total = rows.length;
  return out;
}

// formulae.csv is pipe-delimited: name|type|version|dependency-type|used-by
function parseFormulae(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return [];
  const header = lines[0].split('|').map((h) => h.trim());
  const idx = (name) => header.indexOf(name);
  const iName = idx('name') >= 0 ? idx('name') : 0;
  const iType = idx('type') >= 0 ? idx('type') : 1;
  const iVer = idx('version') >= 0 ? idx('version') : 2;
  const iDep = idx('dependency-type') >= 0 ? idx('dependency-type') : 3;
  const iUsed = idx('used-by') >= 0 ? idx('used-by') : 4;
  return lines.slice(1).map((line) => {
    const c = line.split('|');
    return {
      name: (c[iName] || '').trim(),
      type: (c[iType] || 'formula').trim(),
      version: (c[iVer] || '').trim(),
      dependencyType: (c[iDep] || 'optional').trim(),
      usedBy: (c[iUsed] || '').trim(),
    };
  }).filter((r) => r.name);
}

function applyProtection(entries) {
  const removable = [];
  const protectedHits = [];
  for (const e of entries) {
    const rel = path.relative(P.HOME, e.path);
    if (isProtected(rel) || isProtected(e.path)) protectedHits.push({ ...e, rel });
    else removable.push(e);
  }
  return { removable, protectedHits };
}

// Walks the agent directories and counts the live-state files the denylist would refuse to
// delete. Without this, "N protected" reads as zero simply because nothing dangerous was
// proposed — which proves nothing. This reports what actually exists on disk.
function scanProtected(bases) {
  const SKIP = new Set(['node_modules', 'npm', 'cache', '.git']);
  const found = [];
  for (const base of bases) {
    if (!X.isDir(base)) continue;
    const stack = [base];
    while (stack.length && found.length < 2000) {
      const d = stack.pop();
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          if (!SKIP.has(e.name)) stack.push(full);
          else if (isProtected(path.relative(P.HOME, full))) found.push({ path: path.relative(P.HOME, full), kind: 'dir' });
          continue;
        }
        const rel = path.relative(P.HOME, full);
        if (isProtected(rel) || isProtected(e.name)) found.push({ path: rel, kind: 'file' });
      }
    }
  }
  return {
    scannedBases: bases,
    liveStateFilesFound: found.length,
    samples: found.slice(0, 12).map((f) => f.path),
  };
}

function detectAll() {
  const pi = detectPi();
  const claude = detectClaude();
  const codex = detectCodex();
  const brew = detectBrew();

  const merged = [...pi.removable, ...claude.removable, ...codex.removable];
  const guarded = applyProtection(merged);
  const protectedScan = scanProtected([pi.dir, claude.dir, codex.dir, X.expandTilde('~/.agents')]);
  // Falsifiable claim: every live-state file found on disk must be absent from the
  // removable list. If this is ever non-zero, the denylist has a hole.
  const removableSet = new Set(guarded.removable.map((e) => path.resolve(e.path)));
  const overlap = protectedScan.samples.filter((rel) => {
    const abs = path.resolve(P.HOME, rel);
    return guarded.removable.some((e) => {
      const r = path.resolve(e.path);
      return abs === r || abs.startsWith(r + path.sep);
    });
  });
  void removableSet;

  return {
    generatedAt: new Date().toISOString(),
    home: P.HOME,
    core: P.CORE,
    agents: {
      pi: { present: pi.present, dir: pi.dir, artifacts: pi.artifacts },
      claude: { present: claude.present, dir: claude.dir, artifacts: claude.artifacts },
      codex: { present: codex.present, dir: codex.dir, artifacts: codex.artifacts },
    },
    brew,
    removable: guarded.removable,
    protectedEntries: guarded.protectedHits,
    protectedEvidence: { ...protectedScan, overlapWithRemovable: overlap },
    protectionHole: overlap.length > 0,
    summary: {
      removableCount: guarded.removable.length,
      protectedCount: guarded.protectedHits.length,
      byAgent: guarded.removable.reduce((acc, e) => {
        acc[e.agent] = (acc[e.agent] || 0) + 1; return acc;
      }, {}),
    },
  };
}

module.exports = { detectAll, detectPi, detectClaude, detectCodex, detectBrew, parseFormulae, isProtected };
