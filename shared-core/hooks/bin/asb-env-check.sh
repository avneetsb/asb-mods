#!/usr/bin/env bash
# asb-mods session-start preflight. Deployed by lib/deploy.js to
#   ~/.config/asb-mods/hooks/asb-env-check.sh
# Registered by lib/hooks.js for pi, Claude Code and Codex.
#
# Contract: prints one line per problem, never blocks the agent, exits 0 always.
# No absolute machine paths and no network access — everything it checks is
# installed by this package or already on PATH.
set -uo pipefail

STATE_DIR="${ASB_MODS_STATE_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/asb-mods}"
SECRETS="$STATE_DIR/env/secrets.env"
SHELL_ENV="$STATE_DIR/env/shell-env.sh"

problem() { printf 'asb-mods: %s\n' "$1"; }

[ -f "$SECRETS" ] || problem "secrets not collected yet — run: asbmods secrets"
[ -f "$SHELL_ENV" ] || problem "shell-env not deployed — run: asbmods env"

if [ -f "$SECRETS" ]; then
  perms=$(stat -f '%Lp' "$SECRETS" 2>/dev/null || stat -c '%a' "$SECRETS" 2>/dev/null || echo '')
  [ -z "$perms" ] || [ "$perms" = "600" ] || problem "secrets.env mode is $perms, expected 600 — chmod 600 \"$SECRETS\""
fi

if command -v brew >/dev/null 2>&1; then
  missing_file="$STATE_DIR/reports/brew-missing.txt"
  if [ -f "$missing_file" ] && [ -s "$missing_file" ]; then
    problem "Homebrew inventory: $(wc -l < "$missing_file" | tr -d ' ') package(s) still missing — see $missing_file"
  fi
fi

exit 0
