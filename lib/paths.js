'use strict';
// Path resolution for the packaged installer.
//
// Rules (auditor objection: "install.js hardcodes ~/Dev/asb-mods/shared-core, which
// breaks npx usage"):
//   * shared-core is resolved RELATIVE to this file, so it works from a git clone,
//     `npm i -g`, `npm link`, or an npx temp dir alike.
//   * ASB_MODS_CORE overrides the source-of-truth directory.
//   * ASB_MODS_HOME overrides the target home directory — used by the functional
//     test suite to run the full destructive flow against a throwaway fixture home.
const path = require('path');
const os = require('os');

const HOME = process.env.ASB_MODS_HOME || os.homedir();
const PKG_ROOT = path.resolve(__dirname, '..');                 // <pkg>/lib -> <pkg>
const CORE = process.env.ASB_MODS_CORE || path.join(PKG_ROOT, 'shared-core');

const XDG_CONFIG = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');

module.exports = {
  HOME,
  PKG_ROOT,
  CORE,
  STATE_DIR: path.join(XDG_CONFIG, 'asb-mods'),
  BACKUP_DIR: path.join(XDG_CONFIG, 'asb-mods', 'backups'),
  REPORT_DIR: path.join(XDG_CONFIG, 'asb-mods', 'reports'),
  ENV_DIR: path.join(XDG_CONFIG, 'asb-mods', 'env'),
  STATE_FILE: path.join(XDG_CONFIG, 'asb-mods', 'state.json'),
  MANIFEST_FILE: path.join(XDG_CONFIG, 'asb-mods', 'installed-manifest.json'),

  agents: {
    pi: { dir: path.join(HOME, '.pi'), agentDir: path.join(HOME, '.pi', 'agent') },
    claude: { dir: path.join(HOME, '.claude') },
    codex: { dir: path.join(HOME, '.codex') },
  },
  dotfiles: ['.zshrc', '.bashrc', '.zshenv'].map((f) => path.join(HOME, f)),
};
