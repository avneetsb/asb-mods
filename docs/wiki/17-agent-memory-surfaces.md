# 17 — Agent memory surfaces (pi, Claude Code, Codex CLI)

[Home](Home.md)

Every agent runtime keeps its own notes about you and your machines, and they share nothing: not a
directory, not a format, not a lock. This page names each surface with a path that exists on this
machine, what writes it, and — the honest part — what asb-mods does **not** touch. The scope is three
hosts by design (plan §0); no other runtime's memory is read, written or named here.

Two things on this page are machine-checked, so they cannot rot quietly while the code that would read
them stays absent. Every path named below appears in `MEMORY_SURFACES` in `test/install.test.js` — a doc
that invents a new surface fails the suite — and `lib/docsync.js` covers the page like every other
claim in this wiki.

## The three kinds of surface

| Kind | What it holds | Who writes it | Coordinated across hosts? |
| --- | --- | --- | --- |
| Instruction files | Standing instructions per project/host (`AGENTS.md`, `CLAUDE.md`) | You, or Phase 4's merge from `shared-core/agents/*/settings-fragment.json` | Content can be shared; the files are separate |
| Agent-authored memory | Notes the runtime wrote about your work | The runtime itself | No — and that is the correct design, see "one writer" below |
| Tool stores | Durable memory a *component* owns (engram, Mnemosyne) | That component, over its own API or store | Yes — one HTTP server on loopback, which is how three hosts share one brain |

## pi

| Path | State here | What it is |
| --- | --- | --- |
| `~/.pi/agent/AGENTS.md` | present | Global instructions, read at every session start. Phase 4 owns its managed block. |
| `~/.pi/agent/settings.json` | present | Provider/model, packages, extensions. Phase 4 merges, `asbmods reset` restores. |
| `~/.pi/agent/session-learnings/journal.jsonl` | present | The session-learnings distiller's journal — its own record of what a session concluded. |
| `~/.pi/agent/sessions/` | present | Transcripts. Input to session learning, not a memory store to edit. |
| `~/.pi/agent/prompt-history.jsonl` | present | Your prompt history. Not memory; no agent reads it for context. |

pi has **no** `~/.pi/agent/memories/` directory and this page will not pretend otherwise: durable
memory on pi is delegated to components (engram via its MCP/HTTP tools, Mnemosyne via MCP), not held in
a runtime-owned folder. That delegation is why pi is the easiest host to give a shared brain to.

## Claude Code

| Path | State here | What it is |
| --- | --- | --- |
| `~/.claude/CLAUDE.md` | present | Global instructions for every project. |
| `~/.claude/projects/<project-slug>/memory/MEMORY.md` | present (4 projects on this machine) | Per-project index the runtime maintains for itself. |
| `~/.claude/projects/<project-slug>/memory/<topic>.md` | present | Per-project topic notes written by the runtime, one file per subject. |
| `~/.claude/settings.json` | present | Host config, not memory: Phase 4 merges its fragment in, and the hook relaunch line lives here. |

Claude's memory is scoped per working directory and keyed by a path-derived slug, so two clones of one
repository get two memories. asb-mods merges `~/.claude/settings.json` from its own fragment and leaves
`~/.claude/CLAUDE.md` alone — no code path in the installer writes it, which is a gap rather than a
policy decision (finding F11 files it under surfaces nothing manages). Nothing under
`~/.claude/projects/` is read, merged or removed by any verb.

## Codex CLI — four surfaces, not one

| Path | State here | What it is |
| --- | --- | --- |
| `~/.codex/AGENTS.md` | present | Host instructions. Phase 4 appends its managed block here, so this one file in the table is installer-owned — the fixture marks it as such rather than claiming it is untouched. |
| `~/.codex/memories/MEMORY.md` | present | The memory index Codex reads. |
| `~/.codex/memories/memory_summary.md` | present | Compressed summary the runtime feeds itself. |
| `~/.codex/memories/raw_memories.md` | present | The unconsolidated log before summarisation. |
| `~/.codex/memories/rollout_summaries/` | present | Per-rollout summaries. |
| `~/.codex/rules/default.rules` | present | Standing tool rules, separate from memory and from `config.toml`. |
| `~/.codex/config.toml` | present | Host config, not memory: model, auth and notify hooks. `lib/detect.js` reads it and no code path rewrites it. |
| `~/.codex/AGENTS.override.md` | **absent here — optional** | If present it silently outranks `AGENTS.md`. Nothing writes it, and `lib/detect.js` `PROTECT_NAMES` lists it, so a `--confirm` run cannot archive it either: `asbmods detect` counts it as protected (`protectedEvidence.samples`), never as removable. |

The four surfaces that matter operationally are the memories tree, `AGENTS.md`, `rules/`, and the
optional override. Treating Codex as "`config.toml` plus one memory file" misses two of them, which is
how a previous plan got it wrong.

## One writer per store — why nothing here is merged

The design rule is one writer per store. Two agents appending to one file do not merge and do not lock:
they interleave partial writes and the last flush wins, so a host can quietly lose another host's
recollection. Since 0.3.2 the installer serialises **its own** runs: `lib/state-lock.js` takes an
exclusive-create lock at `<state-dir>/install.lock` carrying pid + verb + started-at, judges staleness by
pid liveness rather than by age, and exempts read-only verbs and `--dry-run` completely — so two asb-mods
runs can no longer interleave, and the one that loses exits 1 naming the holder and printing the takeover
command. That closes finding F8 for this package, and nothing more: the rule above is still not a guarantee
against the agents themselves, which write into these stores through their own tools without asking us. The
caliper-harness study (`.harness/findings.json` F8) showed the version that does hold: one long-running
loopback HTTP server owns the store and answers every host over `127.0.0.1`, with direct file writes
reserved for migration and repair under a held lock.

That privacy is deliberate, and what *is* shared across the three hosts needs naming precisely — an earlier
revision of this page claimed `shared-core/npm/manifest.json` "installs the memory components (engram,
Mnemosyne)", which the manifest itself contradicts: it installs 14 packages into the one npm prefix all
three hosts call, and they are pi-side extensions plus a statusline utility. What this package actually
ships for engram and Mnemosyne is their **pi side** — `engram-project-pin.ts`,
`engram-review-on-compaction.ts`, `memory-recall-gate`, `memory-usage-gate` — plus the scripts that prove
cross-session recall works. The servers are installed and run by whoever operates them, so in 0.3.x a
recollection is shared between hosts only when both hosts are configured to reach the same running server;
`shared-core/mcp/servers.json`, specified in plan §2 and **not shipped at 0.3.0**, is what will point one
server definition at all three. Either way this package does not implement memory storage, and the run lock
covers **our** writes only: two agents writing the same store through their own tools is still limitation
37's open half, which §2's single-writer server answers. See [page 18](18-per-agent-outcome.md) for what
that means per host out of the box.

## What asb-mods does and does not do

Phase 5 archives entries from `~/.pi/agent/{extensions,skills,prompts}`, `~/.claude/{commands,agents,skills,plugins}`
and `~/.codex/{prompts,skills}`. None of those globs reaches a memory tree, and the suite proves it:
`MEMORY_SURFACES` in `test/install.test.js` lays down every **agent-authored** path above inside the
sandbox home, hashes it, runs a real install, and requires each hash to be unchanged. Entries the
The entries the installer *does* write — the managed blocks Phase 4 merges into
`~/.pi/agent/settings.json`, `~/.claude/settings.json` and the two `AGENTS.md` files, plus the hook
scripts it drops under `~/.claude/hooks/` — are flagged in the fixture and asserted separately, because
claiming those byte-identical would be a lie about Phase 4. `~/.claude/CLAUDE.md` is *not* in that group:
no code path in the installer writes it, so its bytes must survive like any memory file.
is *not* in that group, because no code path in the installer writes it.

The whole suite runs against a home it creates in its own temporary directory, which is why no test can
reach your real memory: `HOME` and `XDG_CONFIG_HOME` are pointed at the fixture before anything runs.

Related pages: [protection model](08-protection-model.md), [secrets and env](09-secrets-and-env.md),
[shared-core reference](06-shared-core-reference.md), [update and rollback](11-update-and-rollback.md).
