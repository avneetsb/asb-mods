# Agent Prompt Sync Guide

## Consolidated PROMPTS Directory Structure

```
asb-mods/shared-core/
├── prompts/
│   ├── master/                     # Canonical prompts (single source of truth)
│   │   ├── agentic-pi.md           # PI agent system prompt (agentic mode)
│   │   ├── coding-agent.md         # Coding agent system prompt
│   │   ├── research-assistant.md   # Research/analysis assistant
│   │   └── code-reviewer.md        # Code review specialist
│   ├── adapters/                   # Per-tool adaptations
│   │   ├── claude-adapt.sh         # Converts master → Claude Code format
│   │   ├── codex-adapt.sh          # Converts master → Codex format  
│   │   └── cursor-adapt.sh         # Converts master → Cursor format
│   └── README.md                   # How prompts sync works
```

## Sync Rules

1. **Master prompts live ONLY in shared-core/prompts/master/**
2. **Per-tool overrides go in tool-specific directories** (not duplicated)
3. **Skills are stored as .md files** (not JSON), one per capability
4. **AGENTS.md / CLAUDE.md are MERGED POINTS** — they pull from master + apply tool-specific overrides

## Current Status

| Prompt Type | Master | Claude | Codex | Pi | Status |
|---|---|---|---|---|---|
| System prompts | ✓ | - | - | ✓ | Pi uses extensions (not system prompts) |
| Skills (.md) | ~40 copies → dedup needed | ponytail, gitnexus | caveman variants | caveman, gitnexus, paseo | Phase 2 |
| Hooks | ✓ | ✓ | ✓ | ✓ | Phase 1 complete |

## Migration Path

1. Copy master prompts to each tool's location (non-destructive)
2. Create `adapters/` scripts that regenerate tool configs from master
3. Add git hooks to sync changed prompts across tools
