#!/usr/bin/env bash
# asb-mods stop-hook: secrets hygiene guard. Deployed by lib/deploy.js to
#   ~/.config/asb-mods/hooks/asb-secrets-check.sh
# Registered by lib/hooks.js for pi, Claude Code and Codex.
#
#Contract: warns about world-readable or missing secret storage. Never prints a
# value, never blocks the agent, always exits 0.
set -uo pipefail

STATE_DIR="${ASB_MODS_STATE_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/asb-mods}"
SECRETS="$STATE_DIR/env/secrets.env"

problem() { printf 'asb-mods: %s\n' "$1"; }

if [ -f "$SECRETS" ]; then
  perms=$(stat -f '%Lp' "$SECRETS" 2>/dev/null || stat -c '%a' "$SECRETS" 2>/dev/null || echo '')
  if [ -n "$perms" ] && [ "$perms" != "600" ]; then
    problem "secrets.env mode is $perms, expected 600 — chmod 600 \"$SECRETS\""
  fi
  # A secret file must never be tracked by git.
  if command -v git >/dev/null 2>&1; then
    if git -C "$(dirname "$SECRETS")" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      problem "secrets.env sits inside a git work tree — move it out of any tracked tree"
    fi
  fi
fi

# Legacy sprawl: prompt for consolidation instead of silently leaving copies behind.
for legacy in "$HOME/.secrets.env" "$HOME/.config/asb-mods/secrets.env"; do
  [ -f "$legacy" ] && problem "legacy secret file at $legacy — consolidate with: asbmods secrets"
done

exit 0
