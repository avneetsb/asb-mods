# 08 — Protection model

[← 07 Vendoring](07-personal-tooling-vendoring.md) · [Home](Home.md) · Next: [09 — Secrets and environment](09-secrets-and-env.md)

Phase 3 deletes. The protection model is what it is not allowed to delete, and it is the only thing
standing between a cutover run and an unrecoverable credential or config loss. It is deliberately a
**pattern denylist evaluated at delete time**, not an allow-list of "things we own": the installer
cannot know what a given machine holds, but it knows the shapes of things that must never be removed.

## How a path is judged

```text
detect.js  PROTECT_NAMES (34 regexes — 33 with /i)   ──► isProtected(relPath)
applyProtection(candidates)  → drops protected paths from the removal list
remove.js  re-calls isProtected(rel) + isProtected(absolute) per entry before rmrf()
detect.js  scanProtected()  → walks live trees, records protected findings (capped at 2000)
```

Three properties worth internalising:

1. **Two forms are tested.** Every candidate is checked as a home-relative path *and* as an absolute
   path, so a pattern anchored with `^` still matches when the caller passes an absolute string.
2. **Checked twice.** Filtering happens in detection, and Phase 3 re-checks each entry immediately
   before deleting — a stale or hand-edited inventory cannot smuggle a protected path past the guard.
3. **Fail closed.** `isProtected` returns true on any match; a path is removable only when it matches
   none of the 34. `applyProtection` reports what it dropped and `status` surfaces protected findings.

## The 34 patterns, by intent

### Credentials

```text
^auth(\.json)?$    ^\.credentials    ^oauth    ^tokens?$    ^\.env$
```

Loss means signing in to every provider again, and `.env` may hold anything. Never archived-and-deleted.

### Live agent config

```text
(^|\/)settings[^/]*\.json$    (^|\/)config\.toml$    (^|\/)mcp[^/]*\.json$    (^|\/)hooks\.json$
```

Phase 4 *merges into* `settings.json` and explicitly refuses `config.toml`
(`action: 'preserved'`). Deleting either would destroy user config the package never authored.

### Databases

```text
\.sqlite(-wal|-shm)?$                (^|\/)state_\d+\.sqlite
(^|\/)goals_\d+\.sqlite              (^|\/)memories(_v\d+)?(_\d+)?\.sqlite
(^|\/)thread_history_\d+\.sqlite
```

Agent and memory stores. A write-ahead-log sidecar deleted without its main database corrupts it, so
the `-wal` / `-shm` suffixes are matched by the first pattern.

### Session history

```text
(^|\/)history(\.jsonl)?$    (^|\/)sessions?$    (^|\/)archived_sessions$
(^|\/)dictation-history     (^|\/)transcription-history
```

Conversation history is the user's own record; no reinstall regenerates it.

### Backups and rollback

```text
(^|\/)backups?$    (^|\/)rollback-artifacts$    (^|\/)rollout-migrations$
```

If removal deleted the backup directory, the undo path would be gone with it.

### Caches and payloads

```text
(^|\/)cache$    (^|\/)attachments$    (^|\/)browser$
(^|\/)models_cache\.json              (^|\/)version\.json
```

Rebuildable but expensive: `browser/` holds profile data, `models_cache.json` holds downloaded model
metadata.

### Locks and logs

```text
\.lock$                    \.log$                     (^|\/)logs?_
(^|\/)project-metadata-locks$                          (^|\/)mcp-oauth-locks$
(^|\/)thread-writer-locks$
```

Deleting a live lock can corrupt a running agent's writer — and an agent may well be running while you
install.

### Version control

```text
(^|\/)\.git$
```

Never part of a tooling cutover, under any scope.
Dump the authoritative list yourself (the source is the only truth):

```bash
node -e "const s=require('fs').readFileSync('lib/detect.js','utf8');\
console.log(s.slice(s.indexOf('PROTECT_NAMES'), s.indexOf('];', s.indexOf('PROTECT_NAMES'))))"
```

## Where protection shows up

| Surface | What you see |
| --- | --- |
| `asbmods --dry-run` / Phase 1 | protected findings reported, not queued; `scanProtected` output capped at 2000 entries |
| Phase 3 summary | `refused[]` / `refusedCount` — entries the guard rejected at delete time |
| `asbmods status` | protected findings among the checks, so drift is visible after a run |
| `tools/vendor.js` / `manifest.json` | `totals.skippedProtected: 2` — vendoring also refuses to bundle protected paths |
| archive (Phase 2) | the five archive targets are whole agent trees, so protected content is *copied* for safety; it is simply never deleted afterwards |

## Listing limits

`CHILD_LIMIT = 400` bounds each directory listing during detection (a runaway `node_modules` cannot
make detection unbounded); `scanProtected` caps its walk at 2000 findings. If a home genuinely holds
more, detection still completes — it reports up to the cap rather than hanging.

## What protection does **not** do

| Misconception | Reality |
| --- | --- |
| "It protects files outside the target home" | It does not. Removal is additionally gated by `insideHome(p)`: a path outside `HOME` (or `ASB_MODS_HOME`) is refused regardless of pattern |
| "It stops Phase 4 overwriting my settings" | Phase 4 never overwrites: `mergeInto` merges (arrays as sets for `packages`/`extensions`) and `writePreserving` backs up before mutation. Protection is about *deletion* |
| "It is a sandbox" | It is a denylist plus a home-boundary check. Hand-editing `state.json` to name an arbitrary path is out of the threat model — the two guards above are what stop realistic mistakes |
| "Add-on directories I created are safe" | They are removable unless they match a pattern. A custom `~/Dev/my-tool/` is outside the agent trees and never queued; a custom directory *inside* `~/.claude/skills/` **is** queued. Phase 2 archives first — check the archive before a cutover |

## Extending it

Adding a pattern is a one-line change to `PROTECT_NAMES` in `lib/detect.js`, and it takes effect for
detection, vendoring and removal at once (all three call `isProtected`). Rules:

- anchor with `(^|\/)` for path segments, `^` for top-level names, `$` when a prefix match would be
  too broad (`^tokens?$` not `^token`);
- escape literal dots — `\.lock$`, not `.lock$`;
- keep `/i`. 33 of the 34 carry it; ``^\.env$`` is the single exception, which as a side effect means
  `.ENV` or `.Env` would not be protected by that pattern today — a candidate for tidying;
- add or adjust a fixture in `test/install.test.js` proving the pattern blocks removal, because the
  suite is what stops a later edit from accidentally widening a pattern into "protect everything".
