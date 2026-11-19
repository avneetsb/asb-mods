#!/usr/bin/env bash
# asb-mods cutover rollback — restore from latest backup
# Usage: cutover/rollback.sh [--all | --pi | --claude | --codex | --cursor]
#
# Restores files from the most recent backup directory
# WARNING: Overwrites current tool state with backup

set -euo pipefail

BACKUP_ROOT="$HOME/.config/asb-mods/backups"
TARGET="${1:-all}"

# Find latest backup
latest=$(ls -d "$BACKUP_ROOT"/*/ 2>/dev/null | sort -r | head -1)

if [ -z "$latest" ]; then
    echo "Error: No backups found in $BACKUP_ROOT"
    exit 1
fi

echo "[asb-mods-cutover] Rolling back from: $latest"
echo "WARNING: This will overwrite current tool configuration."
read -p "Continue? [y/N]: " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "Aborted."
    exit 1
fi

restore_tool() {
    local tool_name="$1"
    local src_dir="$latest/$tool_name"
    local dest_path="$2"
    
    if [ -d "$src_dir" ]; then
        mkdir -p "$(dirname "$dest_path")"
        rsync -av "$src_dir/" "$dest_path/"
        echo "  ✓ $tool_name restored"
    else
        echo "  - $tool_name (no backup found)"
    fi
}

case "$TARGET" in
    all|pi)
        restore_tool "pi" "$HOME/.pi/agent"
        ;;
    all|claude)
        restore_tool "claude" "$HOME/.claude"
        ;;
    all|codex)
        restore_tool "codex" "$HOME/.codex"
        ;;
    all|cursor)
        restore_tool "cursor" "$HOME/.cursor"
        ;;
esac

echo ""
echo "[asb-mods-cutover] Rollback complete."
