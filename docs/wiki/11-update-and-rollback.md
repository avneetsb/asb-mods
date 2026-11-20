# 11 — Updating and rolling back

[← 10 Hooks reference](10-hooks-reference.md) · [Home](Home.md) · Next: [12 — Troubleshooting and known gaps](12-troubleshooting.md)

There are four independent things that can need rolling back, and they have four different mechanisms.
Know which layer you are in before you reach for a command:

| Layer | What changed | Undo with |
| --- | --- | --- |
| 1 removals | Phase 3 deleted agent artifacts | `asbmods reset` (replays a removal report) |
| 2 config files | Phase 4/7 merged into `settings.json`, hooks, rc files | the snapshot in `file-backups/` (manual copy back) |
| 3 whole trees | the pre-change archive of `~/.pi`, `~/.claude`, `~/.codex`, dotfiles | `backups/<stamp>/` plus the `asb-backup-<stamp>` git tag |
| 4 package version | which payload the installer ships | `git checkout <tag>` or `npx …#<tag>`, then redeploy |

## Updating a checkout install (the normal case)

```bash
cd ~/Dev/asb-mods
git status --porcelain                 # must be empty; local edits would be silently redeployed
git fetch --tags origin
git log --oneline HEAD..origin/main    # read what you are about to deploy
git pull --ff-only
npm test                               # 32 tests; do not skip this on a machine you use daily
asbmods --dry-run                      # what would change now
asbmods install                        # redeploy payload: no removal, no prompts
asbmods hooks                          # re-register hooks (idempotent: up-to-date = no change)
asbmods env                            # only if shared-core/env/shell-env.sh changed
asbmods status                         # verification, read-only
```

`asbmods install` never deletes: it is deploy + hooks + env, so an update is safe on a working
machine. Removal is only ever what you explicitly authorise with `--allow-destructive`.

## Updating an npx install

Nothing is cached between runs, so the version is whatever the ref points at:

```bash
npx github:avneetsb/asb-mods#v0.1.0 --dry-run    # pinned: what this release would do
npx github:avneetsb/asb-mods#main   --dry-run    # moving: current main
npx github:avneetsb/asb-mods#v0.1.0 install      # deploy the pinned payload
```

Pin a tag on any machine you care about. `#main` is fine for a throwaway VM and wrong for your laptop,
because it silently changes underneath you.

## Rolling back layer by layer

### Layer 1 — undo a removal

```bash
ls -1 ~/.config/asb-mods/reports | grep removal   # which reports exist
asbmods reset                                     # newest removal report
asbmods reset --report=removal-2026-11-20T02-41-33-507Z.json
```

`reset` reads each entry's recorded path, resolves it inside the newest archive (`<agent>/<rel>`,
the same path with the agent segment collapsed, then the entry's own `archivedTo`), and copies it
back. It writes `reports/restore-<stamp>.json` and refuses a report produced by a dry run (that report
describes nothing that happened). It applies immediately — there is no `--dry-run` for reset, so
rehearse it against a fixture home first if you are unsure.

### Layer 2 — undo a config merge

```bash
ls -1t ~/.config/asb-mods/file-backups | head        # newest first
diff ~/Dev/asb-mods/shared-core/agents/tool-specific/pi/settings-fragment.json \
     ~/.pi/agent/settings.json | head -40            # what the merge actually added
cp ~/.config/asb-mods/file-backups/<basename>.<hash12>.<iso-ts> ~/.pi/agent/settings.json
```

Every write from `writePreserving` and `backupString` lands there, named by content hash plus
timestamp, so you can pick the pre-change version by inspecting it rather than trusting the filename.
To remove *specific* merged keys instead of reverting the file, use `installed-manifest.json`: it
records each change (`added` / `appended` / `replaced` / `created` / `set`) with its path.

### Layer 3 — restore whole agent trees

```bash
ls -1 ~/.config/asb-mods/backups                     # stamp-named snapshots
git tag -l 'asb-backup-*' --sort=-creatordate | head # the matching repo tags
cat ~/.config/asb-mods/last-archive.json               # what that archive contains + completeness
cp -R ~/.config/asb-mods/backups/<stamp>/pi/. ~/.pi/   # rsync -a is the gentler choice
```

The archive is verified at creation (`countFiles` before and after, `complete`/`incomplete` recorded),
so `last-archive.json` tells you whether a snapshot is trustworthy before you spend time on it.
The git tag points at the commit whose payload was live at archive time — pair the two when you need
"the machine state *and* the package version" from that moment.

### Layer 4 — roll back the package version

```bash
git tag -l --sort=-creatordate          # what exists: v0.1.0 today
git checkout v0.1.0 && asbmods install  # deploy the older payload over the newer one
```

`v0.1.0` is an annotated tag whose peeled commit is `22ba077`, the current `main`. Deploying an older
payload is expected to be safe because Phase 4 merges rather than replaces — but hooks and tooling
classes added after that tag will linger until you either roll forward or run a removal you authorised.

**Order matters when several layers moved:** restore removals (1) → restore config files (2) →
redeploy the payload you want (4). Redeploying first re-adds things a reset is about to overwrite,
which makes the diff impossible to read.

## What update does **not** touch

| Thing | Why not | How to change it deliberately |
| --- | --- | --- |
| `~/.config/asb-mods/env/secrets.env` | values are yours, never shipped | `asbmods secrets --rotate-secrets` |
| Homebrew installs | Phase 5 plans by default; uninstalling is a separate decision | `brew remove <formula>` yourself |
| npm globals | Phase 4b reports; it never uninstalls | `npm rm -g <pkg>` |
| `~/.codex/config.toml` | explicitly preserved (`action: 'preserved'`) | edit it yourself |
| `state.json` history | append-only audit trail (last 40 runs) | leave it; it is what `status` compares against |

## Rehearsing before you touch a real machine

```bash
# full destructive run against a throwaway home — same code paths, no risk
rm -rf /tmp/asb-fix && mkdir -p /tmp/asb-fix/home /tmp/asb-fix/xdg
ASB_MODS_HOME=/tmp/asb-fix/home XDG_CONFIG_HOME=/tmp/asb-fix/xdg \
  asbmods all --allow-destructive --yes --no-input
ASB_MODS_HOME=/tmp/asb-fix/home XDG_CONFIG_HOME=/tmp/asb-fix/xdg asbmods status
ls -R /tmp/asb-fix/xdg/asb-mods            # archives + reports you can inspect
```

That is exactly how the destructive phases are tested, which is why shipping them is defensible: they
run against a fixture home on every `npm test`.

## Pruning safely

Archives are plain copies — they accumulate. Keep, per rule of thumb: the newest one, and any archive
referenced by a removal report you might still replay (`reports/removal-*.json` records its stamp).

```bash
python3 - <<'PY'
import json, glob, os
keep = set()
for r in sorted(glob.glob(os.path.expanduser('~/.config/asb-mods/reports/removal-*.json')))[-3:]:
    d = json.load(open(r))
    keep.add(d.get('stamp') or d.get('archiveStamp') or '')
print('referenced by recent removal reports:', sorted(x for x in keep if x))
PY
```

Delete the rest with `rm -rf ~/.config/asb-mods/backups/<stamp>`; keep the matching git tag if you want
the version pointer, tags cost nothing.
