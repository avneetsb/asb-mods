#!/usr/bin/env bash
# asb-mods skill publisher — pushes canonical SKILL.md to per-tool locations
# Usage: skills/publish/publish.sh <skill-name> [--dry-run]
#
# Sources: shared-core/skills/canonical/<name>/SKILL.md
# Destinations: ~/.agents/skills/<name>/, ~/.claude/plugins/*/skills/<name>/.agents/, etc.

set -euo pipefail

SKILL_NAME="${1:-}"
DRY_RUN="${2:-}"

if [ -z "$SKILL_NAME" ]; then
    echo "Usage: $0 <skill-name> [--dry-run]"
    echo "Available: caveman ponytail gitnexus paseo investigate-first lean-build"
    exit 1
fi

CANONICAL="$HOME/Dev/asb-mods/shared-core/skills/canonical/$SKILL_NAME/SKILL.md"

if [ ! -f "$CANONICAL" ]; then
    echo "Error: canonical SKILL.md not found at $CANONICAL"
    exit 1
fi

destinations=(
    "$HOME/.agents/skills/$SKILL_NAME/SKILL.md"
    "$HOME/.codex/skills/$SKILL_NAME/SKILL.md"
    "$HOME/.claude/.agents/skills/$SKILL_NAME/SKILL.md"
)

echo "[asb-mods-skill] Publishing $SKILL_NAME..."
echo "  Source: $CANONICAL ($(wc -c < "$CANONICAL") bytes)"

for dest in "${destinations[@]}"; do
    dest_dir=$(dirname "$dest")
    
    if [ "$DRY_RUN" = "--dry-run" ]; then
        if [ -f "$dest" ]; then
            echo "  [dry] Would update: $dest"
        else
            echo "  [dry] Would create: $dest"
        fi
        continue
    fi
    
    mkdir -p "$dest_dir"
    cp "$CANONICAL" "$dest"
    echo "  ✓ $dest"
done

echo ""
echo "[asb-mods-skill] Publish complete."
