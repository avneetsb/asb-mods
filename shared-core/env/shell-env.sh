# asb-mods shared environment — single source of truth for AI tooling env.
# Deployed to ~/.config/asb-mods/env/shell-env.sh and sourced from ~/.zshenv,
# ~/.zshrc and ~/.bashrc by @asbmods/install. Replaces per-tool env duplication.
#
# Rules for a SOURCED file (the previous revision broke all three and aborted on a
# clean machine, which is why this comment is here):
#   * no `set -e` / `set -u` / `set -o pipefail` here — this file runs inside the
#     user's login shell, so those options would leak into it and abort the rc on the
#     first unset variable (e.g. a machine that has never had SSL_CERT_FILE exported);
#   * read possibly-unset variables as ${VAR:-};
#   * use if/fi, never `[ ... ] && cmd`, so a false test returns 0 under a caller's errexit;
#   * stay silent unless ASB_ENV_VERBOSE=1;
#   * never `exit` or `return` a failure.

# --- CA bundle (Netskope / Homebrew OpenSSL conflict) -------------------------------
# Priority: an inherited SSL_CERT_FILE, then this machine's bundle, then system default.
_asb_ca="${SSL_CERT_FILE:-}"
if [ -z "$_asb_ca" ] && [ -f "$HOME/.config/ssl/ca-bundle.pem" ]; then
  _asb_ca="$HOME/.config/ssl/ca-bundle.pem"
fi
if [ -n "$_asb_ca" ] && [ -f "$_asb_ca" ]; then
  export SSL_CERT_FILE="$_asb_ca"
  export REQUESTS_CA_BUNDLE="$_asb_ca"
  export CURL_CA_BUNDLE="$_asb_ca"
fi
unset _asb_ca

# --- Secrets (collected interactively by the installer, mode 600) --------------------
ASB_SHARED_ENV_DIR="${ASB_SHARED_ENV_DIR:-$HOME/.config/asb-mods/env}"
_asb_secrets="$ASB_SHARED_ENV_DIR/secrets.env"
if [ -f "$_asb_secrets" ]; then
  set -a
  # shellcheck disable=SC1090  # installer-generated file, path is ours
  . "$_asb_secrets"
  set +a
fi
unset _asb_secrets

# --- Toolchain PATH ------------------------------------------------------------------
if [ -d "/opt/homebrew/bin" ]; then export PATH="/opt/homebrew/bin:$PATH"; fi
if [ -d "/usr/local/bin" ]; then export PATH="/usr/local/bin:$PATH"; fi
if [ -d "$HOME/Library/pnpm" ]; then export PATH="$HOME/Library/pnpm:$PATH"; fi
if [ -d "$HOME/.local/bin" ]; then export PATH="$HOME/.local/bin:$PATH"; fi

# --- Pi Coding Agent (model pin: first value wins, so a live override is kept) -------
export PI_DEFAULT_PROVIDER="${PI_DEFAULT_PROVIDER:-omlx}"
export PI_DEFAULT_MODEL="${PI_DEFAULT_MODEL:-Qwen3.8-Flash-Next-oQ4e-mtp}"
export LOCALLLM_OMLX_BASE_URL="${LOCALLLM_OMLX_BASE_URL:-http://127.0.0.1:1234/v1}"
export PI_PERMISSION_MODE="${PI_PERMISSION_MODE:-yolo}"

# --- Mnemosyne LLM --------------------------------------------------------------------
export MNEMOSYNE_LLM_BASE_URL="${MNEMOSYNE_LLM_BASE_URL:-http://127.0.0.1:1234/v1}"
export MNEMOSYNE_LLM_MODEL="${MNEMOSYNE_LLM_MODEL:-Qwen3.8-Flash-Next-oQ4e-mtp}"
export MNEMOSYNE_LLM_EXTRA_BODY="${MNEMOSYNE_LLM_EXTRA_BODY:-{\"enable_thinking\": true}}"
export MNEMOSYNE_MCP_BANK="${MNEMOSYNE_MCP_BANK:-default}"

# --- Memory stacks --------------------------------------------------------------------
export ENGRAM_DATA_DIR="${ENGRAM_DATA_DIR:-$HOME/.engram}"
export RTK_DB_PATH="${RTK_DB_PATH:-$HOME/.local/share/rtk}"

# GITNEXUS_MAX_FILE_SIZE stays UNSET on purpose (an empty string is not the same as
# unset to the CLI, which reads unset as "use its own 512 KB default").
# PASEO_TERMINAL_ID is set by the paseo server, never here.

if [ "${ASB_ENV_VERBOSE:-0}" = "1" ]; then echo "[asb-mods] environment loaded"; fi
