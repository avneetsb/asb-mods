'use strict';
// The tooling manifest: the contract between what detection DELETES and what the package
// SHIPS. Every artifact class the destructive phase can remove must be restorable from
// shared-core/tooling/, otherwise `npx @asbmods/install` cannot reproduce an environment on a
// fresh machine — which is the entire point of the package. tools/vendor.js regenerates this
// manifest from a machine that has the tooling; lib/deploy.js deploys it; test/install.test.js
// fails if a removable class has no bundle.
//
// layout:
//   'dir'     bundle dir's contents are copied into the destination directory
//   'flatten' every file directly inside the bundle dir is copied into the destination
//             (loose pi extensions and scripts arrays are single files, not directories)

const path = require('path');
const X = require('./fsx');

const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'shared-core', 'tooling', 'manifest.json');

// Class -> where it lives on a source machine (relative to $HOME), which shape the archived
// unit has, and where the bundle is stored inside the package. dest may use {{HOME}}.
const CLASSES = {
  piExtensions: {
    label: 'pi loose extensions',
    srcDir: '.pi/agent/extensions',
    unit: 'file',
    exts: ['.ts', '.js'],
    bundleRoot: 'shared-core/tooling/pi/extensions',
    layout: 'flatten',
    dest: '{{HOME}}/.pi/agent/extensions',
  },
  piPackages: {
    label: 'local pi packages',
    srcDir: '.agents/packages',
    unit: 'dir',
    bundleRoot: 'shared-core/tooling/pi/packages',
    layout: 'dir',
    dest: '{{HOME}}/.agents/packages/{{NAME}}',
  },
  claudeAgents: {
    label: 'Claude Code subagents',
    srcDir: '.claude/agents',
    unit: 'file',
    exts: ['.md'],
    bundleRoot: 'shared-core/tooling/claude/agents',
    layout: 'flatten',
    dest: '{{HOME}}/.claude/agents',
  },
  agentsPackages: {
    label: '~/.agents packages (alias of piPackages)',
    srcDir: '.agents/packages',
    unit: 'dir',
    bundleRoot: 'shared-core/tooling/pi/packages',
    layout: 'dir',
    dest: '{{HOME}}/.agents/packages/{{NAME}}',
  },
  agentScripts: {
    label: '~/.agents scripts',
    srcDir: '.agents/scripts',
    unit: 'mixed',
    bundleRoot: 'shared-core/tooling/agents/scripts',
    layout: 'flatten',
    dest: '{{HOME}}/.agents/scripts',
  },
  agentSkills: {
    label: 'personal-authored agent skills',
    srcDir: '.agents/skills',
    unit: 'dir',
    bundleRoot: 'shared-core/tooling/agents/skills',
    layout: 'dir',
    destDir: '{{HOME}}/.agents/skills/{{NAME}}',
    personalList: 'personalSkills',
  },
  claudeSkills: {
    label: 'personal-authored Claude skills',
    srcDir: '.claude/skills',
    unit: 'dir',
    bundleRoot: 'shared-core/tooling/claude/skills',
    layout: 'dir',
    destDir: '{{HOME}}/.claude/skills/{{NAME}}',
    personalList: 'personalSkills',
  },
  codexSkills: {
    label: 'personal-authored Codex skills',
    srcDir: '.codex/skills',
    unit: 'dir',
    bundleRoot: 'shared-core/tooling/codex/skills',
    layout: 'dir',
    destDir: '{{HOME}}/.codex/skills/{{NAME}}',
    personalList: 'personalSkills',
  },
  codexLooseFiles: {
    label: 'Codex loose files',
    srcDir: '.codex',
    unit: 'file',
    exts: ['.md', '.sh'],
    bundleRoot: 'shared-core/tooling/codex/loose',
    layout: 'flatten',
    dest: '{{HOME}}/.codex',
    personalList: 'personalCodexFiles',
  },
  claudePlugins: {
    label: 'Claude plugin state',
    srcDir: '.claude/plugins',
    unit: 'dir',
    bundleRoot: 'shared-core/tooling/claude/plugins',
    layout: 'dir',
    destDir: '{{HOME}}/.claude/plugins/{{NAME}}',
  },
  claudeHooks: {
    label: 'Claude hook directories',
    srcDir: '.claude/hooks',
    unit: 'dir',
    bundleRoot: 'shared-core/tooling/claude/hooks',
    layout: 'dir',
    destDir: '{{HOME}}/.claude/hooks/{{NAME}}',
  },
};

/** Manifest location (also what `asbmods status` reports against). */
function manifestPath() { return MANIFEST_PATH; }

/** Read packaged manifest, or null when nothing has been vendored yet. */
function readManifest() {
  const m = X.readJSON(MANIFEST_PATH, null);
  return m && Array.isArray(m.bundles) ? m : null;
}

/**
 * Bundle entries for one detected class. `dirs` comes from detection (agent-relative paths);
 * a missing name is reported rather than silently dropped.
 */
function bundlesFor(manifest, cls, dirs) {
  const c = CLASSES[cls];
  if (!c || !manifest) return { entries: [], missing: Array.isArray(dirs) ? dirs.slice() : [] };
  const prefix = c.srcDir + '/';
  const wanted = [];
  for (const agentRel of dirs || []) {
    let rel = agentRel.replace(/^\.\//, '');
    if (rel.startsWith(c.srcDir + '/')) rel = rel.slice(prefix.length);
    if (rel.startsWith('~/')) rel = rel.slice(2);
    if (rel.startsWith(c.srcDir + '/')) rel = rel.slice(prefix.length);
    if (!rel || rel === c.srcDir) continue;
    wanted.push(rel.split('/')[0]);
  }
  const byName = new Map(manifest.bundles.filter((b) => b.cls === cls).map((b) => [b.name, b]));
  const entries = [];
  const missing = [];
  for (const name of new Set(wanted)) {
    const b = byName.get(name);
    if (b) entries.push({ ...b, cls, dest: c.dest.replace('{{NAME}}', name), layout: c.layout });
    else missing.push(name);
  }
  return { entries, missing };
}

/** Set of classes that currently have at least one packaged bundle. */
function packagedClasses(manifest) {
  return new Set(((manifest && manifest.bundles) || []).map((b) => b.cls));
}

module.exports = { CLASSES, manifestPath, readManifest, bundlesFor, packagedClasses };
