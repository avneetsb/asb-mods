#!/usr/bin/env bash
# asb-mods Homebrew installer - self-contained package management
set -euo pipefail
cd "$(dirname "$0")"

CORE_PACKAGES="bun checkov curl eslint gh git git-lfs golangci-lint gopls helm jq kapitsa node pi-coding-agent python@3.11 python@3.12 python@3.15 ripgrep rtk chatgpt claude claude-code notion"
TOOLING_PACKAGES="basedpyright beads biome black clang-format"

install_brew() {
    local target="${1:-all}"
    local pkg_list
    case "$target" in
        core|all) pkg_list="$CORE_PACKAGES" ;;
        tooling) pkg_list="$TOOLING_PACKAGES" ;;
        *) echo "Usage: $0 [core|tooling|all]"; exit 1 ;;
    esac
    echo "[asb-mods-brew] Installing $target packages..."
    if ! command -v brew &>/dev/null; then
        echo "[asb-mods-brew] ERROR: Homebrew not found."; exit 1
    fi
    for pkg in $pkg_list; do
        if brew list --versions "$pkg" &>/dev/null; then
            version=$(brew list --versions "$pkg" | awk '{print $2}')
            echo "  ✓ $pkg (v$version)"
        else
            echo "  Installing $pkg..."
            brew install "$pkg"
        fi
    done
    echo "[asb-mods-brew] Complete."
}

validate_brew() {
    echo "[asb-mods-brew] Validating..."
    local missing=0
    for pkg in $CORE_PACKAGES $TOOLING_PACKAGES; do
        if ! brew list --versions "$pkg" &>/dev/null; then
            echo "  MISSING: $pkg"; missing=$((missing + 1))
        fi
    done
    if [ "$missing" -eq 0 ]; then
        echo "  All packages present."
    else
        echo "  $missing missing. Run: $0 all"
    fi
}

case "${1:-install}" in
    install) install_brew "${2:-all}" ;;
    validate) validate_brew ;;
    list) cat formulae.csv ;;
    *) echo "Usage: $0 [install|validate|list]"; exit 1 ;;
esac
