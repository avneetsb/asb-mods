#!/usr/bin/env bash
set -euo pipefail
# asb-mods hook adapter generator — produces per-tool hooks from shared-core schema
# Usage: ./generate-adapters.sh <codex|claude|cursor|all>

SHARED_CORE="${HOME}/Dev/asb-mods/shared-core"
HOOKS_SCHEMA="${SHARED_CORE}/hooks/hooks.json"

if [[ ! -f "$HOOKS_SCHEMA" ]]; then
  echo "ERROR: Schema not found at $HOOKS_SCHEMA"
  exit 1
fi

generate_codex() {
  local codex_hooks="${HOME}/.codex/hooks.json"
  python3 << 'PYEOF'
import json, os, glob

home = os.path.expanduser("~")
codex_hooks_path = os.path.join(home, ".codex", "hooks.json")
schema_path = os.path.join(home, "Dev", "asb-mods", "shared-core", "hooks", "hooks.json")

# Load existing hooks or start fresh
hooks = {}
if os.path.exists(codex_hooks_path):
    with open(codex_hooks_path) as f:
        hooks = json.load(f)
    if not isinstance(hooks, dict):
        hooks = {"version": "1.0.0", "hooks": {}}
else:
    hooks = {"version": "1.0.0", "hooks": {}}

if "hooks" not in hooks:
    hooks["hooks"] = {}

modified = False

# Merge shared-core schema into Codex hooks
try:
    with open(schema_path) as f:
        schema = json.load(f)
    
    for event_name, event_schema in schema.get("events", {}).items():
        # Skip events already present (preserve custom ones)
        if event_name in hooks["hooks"]:
            continue
        
        for hook_entry in event_schema.get("hooks", []):
            cmd = hook_entry.get("command", "")
            hooks["hooks"][event_name] = [{
                "matcher": "",
                "hooks": [{"type": "command", "command": cmd}]
            }]
            modified = True
            print(f"  Added {event_name}: {cmd[:60]}...")
except Exception as e:
    print(f"Schema load warning: {e}")

# Add known shared hooks that should always be present
caveman_prompt = "printf '%s\\n' 'Caveman is default reply style: concise, no filler.'"
paseo_cmd_base = 'if [ -n "$PASEO_TERMINAL_ID" ]; then "${PASEO_HOOK_CLI:-paseo}" hooks codex '
gitnexus_cjs = os.path.join(home, ".claude", "hooks", "gitnexus", "gitnexus-hook.cjs")

# Ensure UserPromptSubmit has caveman prompt
if "UserPromptSubmit" in hooks["hooks"]:
    user_hooks = hooks["hooks"]["UserPromptSubmit"]
    has_caveman = any(
        "Caveman" in str(t.get("command", "")) 
        for t in user_hooks if isinstance(t, dict)
    )
    if not has_caveman:
        user_hooks.insert(0, {"hooks": [{"type": "command", "command": caveman_prompt}]})
        modified = True
        print("  Ensured caveman prompt on UserPromptSubmit")
else:
    hooks["hooks"]["UserPromptSubmit"] = [
        {"hooks": [{"type": "command", "command": caveman_prompt}]},
    ]
    modified = True

# Write back
with open(codex_hooks_path, "w") as f:
    json.dump(hooks, f, indent=2)

print(f"\nCodex hooks written: {codex_hooks_path}")
print(f"Status: {'Modified ✓' if modified else 'Already up to date'}")
PYEOF
}

generate_claude() {
  local claude_hooks_dir="${HOME}/.claude/.agents/hooks/"
  mkdir -p "$claude_hooks_dir"
  
  python3 << 'PYEOF'
import json, os, glob

home = os.path.expanduser("~")
hooks_dir = os.path.join(home, ".claude", ".agents", "hooks")
plugins_dir = os.path.join(home, ".claude", "plugins")
cache_dir = os.path.join(plugins_dir, "cache")
schema_path = os.path.join(home, "Dev", "asb-mods", "shared-core", "hooks", "hooks.json")

# Find all hook handlers from plugins/cache/*/hooks/*.cjs
hook_handlers = {}
if os.path.isdir(cache_dir):
    for plugin_root in sorted(glob.glob(os.path.join(cache_dir, "*", "*"))):
        hooks_subdir = os.path.join(plugin_root, "hooks")
        if os.path.isdir(hooks_subdir):
            plugin_name = os.path.basename(os.path.dirname(plugin_root))
            for hook_file in glob.glob(os.path.join(hooks_subdir, "*.cjs")):
                handler_name = os.path.basename(hook_file).replace(".cjs", "")
                hook_handlers[handler_name] = {
                    "plugin": plugin_name,
                    "path": hook_file,
                    "file": os.path.basename(hook_file)
                }

# Also check ~/.claude/hooks/ for custom handlers
custom_hooks_dir = os.path.join(home, ".claude", "hooks")
if os.path.isdir(custom_hooks_dir):
    for hook_file in glob.glob(os.path.join(custom_hooks_dir, "*", "*.cjs")):
        sub_dir = os.path.basename(os.path.dirname(hook_file))
        handler_name = f"{sub_dir}-{os.path.basename(hook_file)}".replace(".cjs", "")
        hook_handlers[handler_name] = {
            "plugin": sub_dir,
            "path": hook_file,
            "file": os.path.basename(hook_file)
        }

# Generate discovery index from shared-core schema
# Each shared hook event maps to expected Claude hook files
if os.path.exists(schema_path):
    with open(schema_path) as f:
        schema = json.load(f)

    manifest = {"_generated_by": "asb-mods-generate-adapters.sh", "_schema_version": "1.0.0", "plugins": {}, "handlers": {}}

    for event_name, event_schema in schema.get("events", {}).items():
        plugin_key = event_name.lower().replace("-", "_")
        manifest["plugins"][plugin_key] = {
            "event": event_name,
            "hooks_defined": len(event_schema.get("hooks", [])),
            "requires": event_schema.get("requires", []),
            "fallback_action": event_schema.get("fallback_action", "none")
        }

    # Map actual handler files to their source plugins
    for handler_name, handler_info in hook_handlers.items():
        manifest["handlers"][handler_name] = {
            "source_plugin": handler_info["plugin"],
            "full_path": handler_info["path"],
            "status": "discovered"
        }

    # Write discovery index
    index_path = os.path.join(hooks_dir, "manifest.json")
    with open(index_path, "w") as f:
        json.dump(manifest, f, indent=2)
    
    print(f"Claude hook discovery index: {index_path}")
    print(f"  Found {len(hook_handlers)} handler(s) from plugins")
    print(f"  Mapped {len(manifest.get('plugins', {}))} shared-core events")
    print(f"  Status: {'Modified ✓' if len(hook_handlers) > 0 else 'No custom hooks found (cached plugins only)'}")
else:
    print("Schema not found; no index generated")
PYEOF
}

generate_cursor() {
  local cursor_dir="${HOME}/.cursor"
  
  python3 << 'PYEOF'
import json, os, glob

home = os.path.expanduser("~")
cursor_dir = os.path.join(home, ".cursor")
schema_path = os.path.join(home, "Dev", "asb-mods", "shared-core", "hooks", "hooks.json")

# Check what cursor tools are available
result = {"tool": "cursor", "base_dir": cursor_dir}

# MCP config
mcp_path = os.path.join(cursor_dir, "mcp.json")
if os.path.exists(mcp_path):
    with open(mcp_path) as f:
        result["mcp_servers"] = list(json.load(f).get("mcpServers", {}).keys())

# CLI config
cli_path = os.path.join(cursor_dir, "cli-config.json")
if os.path.exists(cli_path):
    with open(cli_path) as f:
        cli = json.load(f)
        result["permissions_allow"] = cli.get("permissions", {}).get("allow", [])
        result["editor"] = {k: v for k, v in cli.get("editor", {}).items()}

# Skills directory
skills_dir = os.path.join(cursor_dir, "skills-cursor")
if os.path.isdir(skills_dir):
    skills = [d for d in os.listdir(skills_dir) if os.path.isdir(os.path.join(skills_dir, d))]
    result["skills_count"] = len(skills)
    result["skills_list"] = skills

# Plugins directory
plugins_dir = os.path.join(cursor_dir, "plugins")
if os.path.isdir(plugins_dir):
    plugins = [d for d in os.listdir(plugins_dir) if os.path.isdir(os.path.join(plugins_dir, d))]
    result["plugins"] = plugins

# Write discovery report
out_path = os.path.join(home, "Dev", "asb-mods", "shared-core", "agents", "tool-specific", "cursor", "adapter-report.json")
os.makedirs(os.path.dirname(out_path), exist_ok=True)
with open(out_path, "w") as f:
    json.dump(result, f, indent=2)

print(f"Cursor adapter report: {out_path}")
print(f"  MCP servers: {result.get('mcp_servers', 'none')}")
print(f"  Permissions allow: {result.get('permissions_allow', 'none')}")
print(f"  Skills: {result.get('skills_count', 0)}")
print(f"  Status: Discovered ✓")
PYEOF
}

case "$1" in
  codex)   generate_codex ;;
  claude)  generate_claude ;;
  cursor)  generate_cursor ;;
  all)
    generate_codex
    generate_claude
    generate_cursor
    ;;
  *)
    echo "Usage: $0 <codex|claude|cursor|all>"
    exit 1
    ;;
esac
