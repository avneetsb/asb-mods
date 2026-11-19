# asb-mods — Consolidated Personal Tooling

Single shared-core for all AI agent tooling across **pi**, **Claude Code**, **Codex**, and **Cursor**.

## Quick Start

```bash
# Install & deploy everything
npx @asbmods/install

# Or individual phases
npx @asbmods/install env    # Shell environment propagation
npx @asbmods/install brew   # Verify Homebrew packages  
npx @asbmods/install hooks  # Register per-tool adapters
npx @asbmods/install status # Check what's deployed
npx @asbmods/install reset  # Rollback from last backup
```

## Structure

```
asb-mods/
├── shared-core/           # Single source of truth
│   ├── agents/            # Per-tool settings fragments
│   │   ├── pi/settings-fragment.json
│   │   ├── claude/settings-fragment.json
│   │   └── codex/settings-fragment.json
│   ├── brew/              # Homebrew inventory + install script
│   │   ├── formulae.csv   # 273 formulae inventory
│   │   ├── install.sh     # Install/validate brew packages
│   │   └── deps.json      # Dependency map
│   ├── config/            # Schema validation
│   │   └── settings-schema.json
│   ├── cutover/           # Non-destructive archive/rollback
│   │   ├── archive.sh     # Backup current state with git tags
│   │   └── rollback.sh    # Restore from backup
│   ├── env/               # Shell propagation
│   │   ├── shell-env.sh   # Centralized environment (secrets, paths)
│   │   └── secrets.env.template
│   ├── hooks/             # Per-tool adapter generation
│   │   ├── generate-adapters.sh
│   │   └── hooks.json
│   ├── skills/            # Consolidated skills + publish script
│   │   └── publish/publish.sh
│   ├── prompts/           # Synced prompt files
│   └── npm/               # NPM global inventory
├── installer/             # npx entry point
│   ├── package.json
│   ├── bin/install.js     # Main installer CLI
│   └── test/install.test.js
└── DEPENDENCY-MAP.json    # Cross-tool dependency resolution
```

## What It Manages

### 1. Shared Codebase
- `settings-schema.json` — validates all tools' settings configs
- `agents/tool-specific/` — per-tool JSON fragments applied during install
- `prompts-sync-guide.md` — prompt file synchronization guide

### 2. Homebrew Packages
- `formulae.csv` — full inventory of 273 installed formulae
- `install.sh` — idempotent install/validation of required packages
- Tracks: `pi-coding-agent`, `rtk`, `graphify`, `mnemosyne-memory`, `gitnexus`, `node`, etc.

### 3. Secrets & Environment
- `env/shell-env.sh` — single source for PATH, API keys, certs
- Propagates automatically to `.zshrc` and `.bashrc`
- `secrets.local.env` — user-only (mode 600) secrets override

### 4. Per-Tool Hooks
- `hooks/generate-adapters.sh` — generates per-tool hook files from shared schema
- `hooks/hooks.json` — unified hook definitions

### 5. Skills Consolidation
- `skills/publish/publish.sh` — pushes canonical SKILL.md to all tool locations
- Prevents 40+ duplicate SKILL.md files across agents

## Safety Guarantees

### Non-Destructive By Design
1. **Archive-first** — every install creates timestamped backups in `~/.config/asb-mods/backups/`
2. **Git-tagged** — each backup has a `asb-backup-YYYYMMDD_HHMMSS` git tag
3. **Disable-not-delete** — existing configs are archived, not overwritten blindly
4. **One-click rollback** — `asbmod-install reset` restores from latest backup

### Verification
```bash
npx @asbmods/install status   # See what's deployed
node installer/test/install.test.js  # Run test suite
```

## Development

```bash
cd installer
npm test        # Run test suite
npm link         # Local development
```

## Migration Path

1. Run `asbmod-install status` to see current state
2. Review `shared-core/agents/tool-specific/*/` for your tool
3. Run `asbmod-install` to deploy
4. Each tool gets thin adapters referencing shared-core
5. Existing configs backed up before any changes
