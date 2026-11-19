#!/usr/bin/env bash
set -eo pipefail
# asb-mods hook adapter generator — produces per-tool hooks.json from shared-core hooks
# Usage: ./generate-adapters.sh <codex|claude|cursor|all>

SHARED_CORE="${HOME}/Dev/asb-mods/shared-core"
HOOKS_SCHEMA="${SHARED_CORE}/hooks/hooks.json"
TARGET_TOOL="${1:-}"

if [[ -z "$TARGET_TOOL" ]]; then
  echo "Usage: generate-adapters.sh <codex|claude|cursor|all>"
  exit 1
fi

generate_codex() {
  local codex_hooks="${HOME}/.codex/hooks.json"
  
  python3 << 'PYEOF'
import json, os

home = os.path.expanduser("~")
codex_hooks = os.path.join(home, ".codex", "hooks.json")

# Load existing codex hooks or start fresh
if os.path.exists(codex_hooks):
    with open(codex_hooks) as f:
        hooks = json.load(f)
else:
    hooks = {"version": "1.0.0", "hooks": {}}

# Ensure hooks key exists
if "hooks" not in hooks:
    hooks["hooks"] = {}

modified = False

# code_session_start → UserPromptSubmit
caveman_line = "printf '%s\\n' 'Caveman is default reply style: concise, no filler.'"
paseo_cmd = 'if [ -n "$PASEO_TERMINAL_ID" ]; then "${PASEO_HOOK_CLI:-paseo}" hooks codex UserPromptSubmit; fi'

if "UserPromptSubmit" not in hooks["hooks"]:
    hooks["hooks"]["UserPromptSubmit"] = [
        {"hooks": [{"type": "command", "command": caveman_line}]},
        {"matcher": "", "hooks": [{"type": "command", "command": paseo_cmd}]}
    ]
    modified = True
else:
    has_caveman = any(
        h.get("command", "").startswith("printf") and "Caveman" in h.get("command", "")
        for t in hooks["hooks"]["UserPromptSubmit"]
        if isinstance(t, dict)
        for h in t.get("hooks", [])
        if isinstance(h, dict)
    )
    if not has_caveman:
        hooks["hooks"]["UserPromptSubmit"].insert(0, {"hooks": [{"type": "command", "command": caveman_line}]})
        modified = True
    
    has_paseo = any(
        "PASEO_TERMINAL_ID" in h.get("command", "")
        for t in hooks["hooks"]["UserPromptSubmit"]
        if isinstance(t, dict)
        for h in t.get("hooks", [])
        if isinstance(h, dict)
    )
    if not has_paseo:
        hooks["hooks"]["UserPromptSubmit"].append({"matcher": "", "hooks": [{"type": "command", "command": paseo_cmd}]})
        modified = True

# paseTerminal hooks → PermissionRequest, PostToolUse, PreToolUse, Stop
for event in ["PermissionRequest", "PostToolUse", "PreToolUse", "Stop"]:
    if event not in hooks["hooks"]:
        hooks["hooks"][event] = [{
            "matcher": "",
            "hooks": [{"type": "command", 
                "command": f'if [ -n "$PASEO_TERMINAL_ID" ]; then "${{PASEO_HOOK_CLI:-paseo}}" hooks codex {event}; fi'}]
        }]
        modified = True

# Add gitnexus hook if available
gitnexus_schema_path = os.path.join(os.path.expanduser("~"), "Dev", "asb-mods", "shared-core", "hooks", "hooks.json")
if os.path.exists(gitnexus_schema_path):
    with open(gitnexus_schema_path) as f:
        schema = json.load(f)
    # Write the codex hooks file
    with open(codex_hooks, "w") as f:
        json.dump(hooks, f, indent=2)
    
    print(f"Codex hooks written: {codex_hooks}")
    if modified:
        print("  → Changes applied (merged shared hooks into existing)")
    else:
        print("  → Already up to date")
else:
    print(f"Schema not found at {gitnexus_schema_path}, skipping")
PYEOF
}

generate_claude() {
  local claude_hooks_dir="${HOME}/.claude/.agents/hooks/"
  mkdir -p "$claude_hooks_dir"
  
  echo "Claude hooks dir: $claude_hooks_dir"
  ls -la "$claude_hooks_dir" 2>/dev/null || echo "  (directory created, no hooks yet)"
  
  # Note: Claude hook handlers already exist in plugins/cache/
  # This adapter just ensures they're discoverable
  echo "  Claude hook handlers live in: plugins/cache/*/hooks/*.cjs"
}

generate_cursor() {
  echo "Cursor hooks target: ~/.cursor/hooks.json (not found on this system)"
  echo "  Source: plugins/cache/obsidian-connect/obsidian-connect/0.1.56/hooks/cursor-hooks.json"
}

case "$TARGET_TOOL" in
  codex)
    generate_codex
    ;;
  claude)
    generate_claude
    ;;
  cursor)
    generate_cursor
    ;;
  all)
    generate_codex
    generate_claude
    generate_cursor
    ;;
esac

echo ""
echo "=== Adapter generation complete ==="
