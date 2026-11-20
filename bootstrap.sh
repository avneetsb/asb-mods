#!/usr/bin/env bash
# bootstrap.sh — get a machine to the point where `asbmods` can run.
#
# Why this file exists at all: install.js *is* Node. On a machine with no Node the installer
# cannot start, so nothing inside the package can fix that. This script is deliberately the only
# part of the repository that runs without Node, and it stops as soon as Node works — everything
# after that belongs to the asbmods phases (doctor, archive, install, hooks...).
#
# It never touches agent configuration, secrets, or shell rc files. It installs a toolchain and
# nothing else, announces every command before running it, and refuses to guess when it cannot
# get what it needs (no sudo, no terminal).

set -euo pipefail

NODE_MIN=18
ASB_REF="${ASB_MODS_REF:-v0.3.0}"
DRY=0
ASSUME_YES=0
VIA="auto"          # auto | brew | nvm | none
BREW_URL="https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"
NVM_URL="https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh"

usage() {
  cat <<'EOF'
bootstrap.sh — install a Node toolchain so @asbmods/install can run

Usage: bootstrap.sh [flags]

Flags
  --dry-run        Show what would run; change nothing
  --yes            Skip the confirmation prompt (still announces every command)
  --via=brew       Force the Homebrew route (macOS; needs admin for Homebrew itself)
  --via=nvm        Force the nvm route (no admin rights; works on macOS and Linux)
  --via=none       Diagnose only, never install (same as `asbmods doctor`, before Node exists)
  --help, -h       This text

After a successful bootstrap, run:
  npx github:avneetsb/asb-mods#<release-tag> --dry-run    # tags: github.com/avneetsb/asb-mods/tags
EOF
}

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  [ok] %s\n' "$*"; }
warn() { printf '  [warn] %s\n' "$*"; }

run() {
  say "will run:  $*"
  if [ "$DRY" = "1" ]; then say "(--dry-run: not executed)"; return 0; fi
  "$@"
}

have() { command -v "$1" >/dev/null 2>&1; }

node_major() { have node && node -p 'parseInt(process.versions.node, 10)' 2>/dev/null || echo 0; }

node_ok() { [ "$(node_major)" -ge "$NODE_MIN" ]; }

report() {
  say "platform:  $(uname -s) $(uname -m)"
  if node_ok; then ok   "node:      $(node -v) (needs >= ${NODE_MIN})"
  else             warn "node:      $(have node && node -v || echo 'absent') (needs >= ${NODE_MIN})"; fi
  if have npm;   then ok   "npm:       $(npm -v)"; else warn "npm:       absent (ships with Node)"; fi
  if have git;   then ok   "git:       $(git --version | head -1)"; else warn "git:       absent (archive tagging and rollback need it)"; fi
  if have brew;  then ok   "Homebrew:  $(brew --version | head -1)"; else warn "Homebrew:  absent"; fi
}

confirm() {
  [ "$ASSUME_YES" = "1" ] && return 0
  [ "$DRY" = "1" ] && return 0
  if [ ! -t 0 ]; then warn "no terminal to answer on; refusing to install unattended (pass --yes to accept)"; return 1; fi
  printf '  Continue? [y/N]: '
  read -r answer
  case "$answer" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

via_brew() {
  if ! have brew; then
    say "installing Homebrew (its installer will ask for your admin password)"
    # Single quotes around $( … ): an announcement must describe the command, never run it. In a
    # double-quoted string this same line performed the curl and printed Homebrew's whole installer.
    say 'will run:  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL '"${BREW_URL}"')"'
    if [ "$DRY" = "1" ]; then say "(--dry-run: not executed)"; else
      NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL "${BREW_URL}")"
    fi
    # set -e would abort on a plain `[ -x … ] && eval …` when the branch misses (Intel vs Apple
    # Silicon prefixes), so both checks are explicit ifs.
    if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
    if [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
    if ! have brew; then
      if [ "$DRY" = "1" ]; then say "(--dry-run: continuing the plan as if Homebrew landed on PATH)"
      else warn "Homebrew still not on PATH — re-run this script in a new shell"; return 1; fi
    fi
  fi
  run brew install node
  have git || run brew install git
  return 0
}

via_nvm() {
  say "installing nvm, then Node LTS (no admin rights needed)"
  if [ ! -d "${NVM_DIR:-$HOME/.nvm}" ] || ! [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    say "will run:  curl -fsSL ${NVM_URL} | bash"
    if [ "$DRY" = "1" ]; then say "(--dry-run: not executed)"; else
      curl -fsSL "$NVM_URL" | bash
    fi
  fi
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    run nvm install --lts
    run nvm use --lts
  elif [ "$DRY" != "1" ]; then
    warn "nvm did not land in $NVM_DIR — open a new shell and re-run"; return 1
  fi
  return 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --via=brew) VIA="brew" ;;
    --via=nvm) VIA="nvm" ;;
    --via=none) VIA="none" ;;
    --help|-h) usage; exit 0 ;;
    *) say "unknown flag: $1"; usage; exit 2 ;;
  esac
  shift
done

say "asb-mods bootstrap — current state"
report

if node_ok; then
  ok "Node $(node -v) already satisfies the requirement — nothing to do"
  say "next: npx github:avneetsb/asb-mods#${ASB_REF} --dry-run   (or run ./install.js in a clone)"
  exit 0
fi

if [ "$VIA" = "none" ]; then
  warn "Node >= ${NODE_MIN} is missing and --via=none forbids installing it"
  say "manual routes: Homebrew (brew install node), nvm (nvm install --lts), or https://nodejs.org"
  exit 1
fi

if [ "$VIA" = "auto" ]; then
  if have brew; then VIA="brew"
  elif [ "$(uname -s)" = "Darwin" ]; then VIA="brew"
  else VIA="nvm"; fi
  say "route chosen: ${VIA} (override with --via=brew or --via=nvm)"
fi

if ! confirm; then warn "declined — nothing installed"; exit 1; fi

case "$VIA" in
  brew) via_brew ;;
  nvm)  via_nvm ;;
  *) say "unknown route: $VIA"; exit 2 ;;
esac

# A plan is not a failure: --dry-run exits 0 once it has shown the route, even on a machine where
# Node is still missing, so CI can lint the bootstrap path without a second Node install.
if [ "$DRY" = "1" ]; then ok "--dry-run: route shown above, nothing installed"; exit 0; fi

if node_ok && have npm; then
  ok "toolchain ready: node $(node -v), npm $(npm -v)"
  say "next steps:"
  say "  npx github:avneetsb/asb-mods#${ASB_REF} --dry-run     # plan against this machine"
  say "  asbmods doctor                                    # then: prerequisites, all green"
  exit 0
fi

warn "bootstrap finished but Node is still unusable (major $(node_major) < ${NODE_MIN})"
say "open a new shell so PATH/nvm are loaded, then re-run this script to check"
exit 1
