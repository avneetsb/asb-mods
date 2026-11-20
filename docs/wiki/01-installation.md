# 01 — Installation

[← Home](Home.md) · Next: [02 — Architecture](02-architecture.md)

Requirements: **Node 18+**. Homebrew optional (without it the brew phase reports the gap instead of
pretending to install). Nothing else — the package has **no runtime dependencies** and nothing to
build, so a checkout *is* the installer.

> `@asbmods/install` is **not published to the public npm registry** yet, so
> `npx @asbmods/install` (bare name) does not work. `npm view @asbmods/install` returns 404.
> The supported routes are a checkout, a git URL, or a global install from either.
> [Publishing is documented here →](15-release-and-publishing.md)

## Route 1 — from a checkout (recommended)

You keep the `asb-backup-*` tags locally, which is what makes [content rollback](11-update-and-rollback.md) addressable.

```bash
git clone git@github.com:avneetsb/asb-mods.git          # SSH, personal key → avneetsb
# or: git clone https://github.com:avneetsb/asb-mods.git  # no key needed; the repo is public
cd asb-mods

node install.js --dry-run        # run it straight from the clone: no npm install needed
```

Put the `asbmods` command on your PATH, one of two ways:

```bash
npm install -g .    # snapshot the checkout into the npm global prefix
                    # → $(npm prefix -g)/bin/asbmods  (~/.local/bin/asbmods,
                    #    which shared-core/env/shell-env.sh already puts on PATH)

npm link            # …or a symlink back to this checkout, so edits to the
                    #    working tree take effect without reinstalling
```

Do **not** do both: they write the same bin, so the last one wins. Check what is live:

```bash
command -v asbmods
readlink -f "$(command -v asbmods)"
```

## Route 2 — from GitHub, no checkout

```bash
npx github:avneetsb/asb-mods --dry-run
npx github:avneetsb/asb-mods                        # detect → archive → install → env/secrets → hooks
npx "git+https://github.com/avneetsb/asb-mods.git" --dry-run   # HTTPS variant, no SSH key
npx github:avneetsb/asb-mods#<commit-sha> --dry-run            # pin a specific commit
npx github:avneetsb/asb-mods#v0.2.0 --dry-run                  # pin a tag
```

`github:` resolves to `git+ssh` and therefore uses your SSH key; the `git+https` form needs none.
Removal never happens implicitly — add `--allow-destructive` for that.

Paths resolve relative to the installed package (`lib/paths.js` → `PKG_ROOT`), so a clone,
`npm i -g`, `npm link` and an npx temp directory behave identically. There is no hardcoded checkout
location, and that is asserted by the suite.

## Which SSH key

The remote is `git@github.com:avneetsb/asb-mods.git` — a **personal** GitHub account. Commits must
be authored with the email linked to that login (`avneetbindra180691@gmail.com`), not an employer
address; the repo sets it locally:

```bash
git -C asb-mods config user.email     # must be the personal address
git -C asb-mods remote -v             # origin → git@github.com:avneetsb/asb-mods.git
```

If pushes come back as the wrong identity, fix `user.email`/`user.name` in this repo's local config
before you commit, and check `ssh -T git@github.com` for the account the key maps to.

## Route 0 — the machine has nothing yet (`bootstrap.sh`)

`install.js` *is* Node: on a machine without it, the package cannot start, so it cannot fix that
either. `bootstrap.sh` is deliberately the only file in the repository that runs without Node, and it
stops the moment Node works — everything after that belongs to `asbmods`.

| Command | What it does |
| --- | --- |
| `./bootstrap.sh --dry-run` | Shows the route it would take, changes nothing, exits `0`. A plan is not a failure |
| `./bootstrap.sh` | Auto route: Homebrew on macOS, nvm elsewhere. Every command is announced before it runs |
| `./bootstrap.sh --via=brew` | Force Homebrew: installs Homebrew if absent, then `node`, then `git` if absent |
| `./bootstrap.sh --via=nvm --yes` | Force nvm + Node LTS. No admin rights; works on macOS and Linux |
| `./bootstrap.sh --via=none` | Diagnose only: platform, node, npm, git, Homebrew. Installs nothing, exits `1` if Node is missing |

Two refusals are the point of the script rather than shortcomings. Homebrew's own installer needs
your admin password **and** a terminal; with no TTY the script says
`refusing to install unattended (pass --yes to accept)` and stops, instead of dying inside `sudo`
halfway through a toolchain. And bootstrap never touches agent configuration, shell rc files or
secrets — that is what the [phases](03-phases.md) are for, once Node exists.

From a machine with no clone yet:

```bash
curl -fsSL https://raw.githubusercontent.com/avneetsb/asb-mods/HEAD/bootstrap.sh | bash -s -- --dry-run
```

Once Node works, `asbmods doctor` reports the remaining prerequisites and prints the fix command
beside each gap; `--install-prereqs` and `--install-agents` are the opt-in installers for them
([CLI reference](04-cli-reference.md#flags)).

## First run, in order

```bash
asbmods --dry-run                # phase plan: read "removable: N" and "protected: M"
asbmods status                   # detection detail + what is already deployed and verified
asbmods --allow-destructive      # archive → remove → install → env/secrets → hooks
                                 # (add --yes for non-interactive; removal refuses without the flag)
exec zsh                         # …or open a new shell: env + secrets arrive from shell-env.sh
asbmods status                   # verify: hook registrations, deployed prompts, skill counts
```

Restart pi / Claude Code / Codex after the hooks phase — each tool reads its config at start-up.

Before running anything destructive, read [the protection model](08-protection-model.md) and check
that the detection numbers look like your machine. `--dry-run` provably mutates nothing: the suite
asserts it creates no archive and no manifest.

## Choosing an install method (affects every later update)

| Installed as | Behaviour | To update |
| --- | --- | --- |
| `node install.js` in the clone | Runs HEAD of your checkout | `git pull` |
| `npm link` | Symlink into the clone; edits to the working tree are live | `git pull` |
| `npm install -g .` | Snapshot copy in the npm global prefix | `git pull` **then** `npm install -g .` again |
| `npx github:avneetsb/asb-mods` | Fetched on demand into an npx cache | nothing — npx re-fetches; pin with `#<sha>` or `#v0.2.0` for reproducibility |

Full update procedure, migrations and the three rollback levels:
[11 — Updating and rollback](11-update-and-rollback.md).

## Non-interactive / CI use

```bash
asbmods --dry-run --json --no-input          # machine-readable plan, never prompts
ASB_MODS_ASSUME_YES=1 asbmods install --yes  # no confirmations (still non-destructive)
ASB_MODS_HOME=$PWD/fixture node install.js all --allow-destructive --yes   # throwaway home
```

`--no-input` keeps existing values untouched rather than blanking them; `ASB_MODS_HOME` and
`ASB_MODS_CORE` are how the functional suite runs the whole destructive flow against a fixture home.
[Flag semantics →](04-cli-reference.md)
