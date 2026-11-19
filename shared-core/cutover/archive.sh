#!/usr/bin/env bash
# asb-mods cutover archive — non-destructive backup of existing tool state
# Usage: cutover/archive.sh [--all | --pi | --claude | --codex | --cursor]
#
# Creates timestamped backups in ~/.config/asb-mods/backups/<YYYY-MM-DD_HHMMSS>/
# Preserves everything: hooks.json, SKILL.md, settings fragments, AGENTS.md

set -euo pipefail

BACKUP_ROOT="$HOME/.config/asb-mods/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
TARGET="${1:-all}"

mkdir -p "$BACKUP_ROOT/$TIMESTAMP"

archive_tool() {
    local tool_name="$1"
    local src_path="$2"
    local dest_dir="$BACKUP_ROOT/$TIMESTAMP/$tool_name"
    
    if [ -e "$src_path" ] || [ -d "$src_path" ]; then
        mkdir -p "$dest_dir"
        cp -rL "$src_path"/* "$dest_dir/" 2>/dev/null || cp -rL "$src_path" "$dest_dir/." 2>/dev/null || true
        local size=$(du -sh "$dest_dir" | cut -f1)
        echo "  ✓ $tool_name → $size"
    else
        echo "  - $tool_name (not found at $src_path)"
    fi
}

echo "[asb-mods-cutover] Archiving $TARGET for $(date)..."
echo "  Backup location: $BACKUP_ROOT/$TIMESTAMP/"
echo ""

case "$TARGET" in
    all|pi)
        archive_tool "pi" "$HOME/.pi/agent"
        ;;
    all|claude)
        archive_tool "claude" "$HOME/.claude"
        ;;
    all|codex)
        archive_tool "codex" "$HOME/.codex"
        ;;
    all|cursor)
        archive_tool "cursor" "$HOME/.cursor"
        ;;
esac

# Also tag the backup with git if running from a repo
git_repo=""
for candidate in "$HOME/Dev/asb-mods" "$HOME" ~; do
    if [ -d "$candidate/.git" ]; then
        git_repo="$candidate"
        break
    fi
done

if [ -n "$git_repo" ]; then
    cd "$git_repo"
    git tag "asb-backup-$TIMESTAMP" HEAD 2>/dev/null || true
    echo ""
    echo "  Git tag created: asb-backup-$TIMESTAMP"
fi

echo ""
echo "[asb-mods-cutover] Archive complete: $BACKUP_ROOT/$TIMESTAMP/"
