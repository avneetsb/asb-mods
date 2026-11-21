# 15 — Release and publishing

[← 14 Contributing](14-contributing.md) · [Home](Home.md)

## Current release state (verify before citing)

| Fact | Value | How to re-check |
| --- | --- | --- |
| Version in `package.json` | `0.3.1` | `node -p "require('./package.json').version"` |
| Git tag | `v0.3.1` (**annotated**; object `aec2b57`, peeled commit `c630010`), `v0.3.0` (object `61eb530`, peel `fe03c92`), `v0.2.0` (object `5fb2d0d`, peel `4dba1c8`), `v0.1.0` (object `83819aa`, peel `22ba077`) | `git tag -l --format='%(refname:short) obj=%(objectname:short) commit=%(*objectname:short)'` |
| Release commit | `c630010` — exactly where `v0.3.1` peels, so on that commit `git describe --tags` prints `v0.3.1`. `main` may sit ahead of the tag with docs-only commits | `git rev-parse --short HEAD`, `git describe --tags`, `git rev-list v0.3.0..main --count` |
| Public npm registry | **not published** — `E404` for `@asbmods/install`. The publish side has exactly one blocker: the `@asbmods` scope is not owned/authorised from this machine (`npm publish --dry-run` → `ENEEDAUTH`) | `npm view @asbmods/install version`; `npm publish --dry-run --access public` |
| Worked install route today | `npx github:avneetsb/asb-mods#v0.3.1` or a clone | README install section |
| Tarball shape (re-measure after any payload change) | **240 files** — machine-checked: `npm test` fails if this number disagrees with what `npm pack` produces. ≈495–497 kB packed, ≈1,742 kB unpacked. Gzip output drifts a few kB between runs (three consecutive packs here: 506,912 / 507,246 / 508,928 B), so packed bytes, `shasum` and `integrity` are **not** an artifact identity — hash the file you actually upload, at release time. Filename `asbmods-install-<version>.tgz` | `node scripts/check-pack-coverage.cjs --json` (count + packed bytes); `npm pack --json` for one run's shasum/integrity |
| Commit signing | none (`user.signingkey` unset) | `git log -1 --show-signature` |
| CI / npm provenance | none — no workflow files, so no attestations | `ls .github/workflows 2>/dev/null` |

Because the registry returns 404, `npx @asbmods/install` **fails**. The README says so where users
will hit it; if you publish, update that paragraph too.

## Package manifest, and why `.npmignore` matters here

```json
{ "name": "@asbmods/install", "version": "0.3.1", "main": "./install.js",
  "bin": { "asbmods": "./install.js" },
  "files": ["install.js", "bootstrap.sh", "lib/", "shared-core/", "scripts/", "docs/",
            "DEPENDENCY-MAP.json", "README.md", "PLAN-DECISIONS.md"],
  "scripts": {
    "test": "node scripts/check-payload-tokens.cjs && node tools/make-manifest.js --check
             && node scripts/check-pack-coverage.cjs && node test/install.test.js" },
  "license": "MIT", "engines": { "node": ">=18.0.0" },
  "repository": { "type": "git", "url": "git+https://github.com/avneetsb/asb-mods.git" },
  "publishConfig": { "access": "public", "registry": "https://registry.npmjs.org" } }
```

There is a `files` **allowlist** now — `install.js`, `bootstrap.sh`, `lib/`, `shared-core/`, `scripts/`,
`docs/`, `DEPENDENCY-MAP.json`, `README.md`, `PLAN-DECISIONS.md` — because while it was absent the artifact
was defined purely by whatever `.npmignore` failed to exclude, and nothing stated which trees are
load-bearing (`scripts/` shipped because nothing excluded it, not because anything decided to). An
allowlist also changes one rule in a way that bites: it takes precedence over the root `.npmignore` for
anything inside a listed directory, which is how `shared-core/tooling/policy.local.json` got back into the
tarball until the nested `shared-core/tooling/.npmignore` was added — measured both ways, see below.
`.npmignore` still governs everything else, and when it is absent npm silently falls back to `.gitignore`
(the `npm warn gitignore-fallback`
warning) and couples the published artifact to VCS state — which is why this repository keeps an
explicit `.npmignore` that mirrors `.gitignore`:

```text
node_modules/  .unipi/  .engram/  *.log  *.tar.gz  backups/  .DS_Store
asb-mods-*.tar.gz  *.tgz  .org-index/  plan/  shared-core/tooling/policy.local.json
```

That last line is the security-relevant one: the vocabulary screen ships (`policy.json`,
`tools/vendor.js`, `lib/tooling.js`) while the term list does not.

One more rule that is easy to get backwards, and was measured rather than remembered: a `files` allowlist
in `package.json` takes precedence over the root `.npmignore` for anything inside a listed directory, so
naming `shared-core/` there **re-admits** `shared-core/tooling/policy.local.json`. The nested
`shared-core/tooling/.npmignore` is what actually keeps it out — nested ignore files are still consulted
inside an allowlisted directory. Measured both ways: with that file absent, `npm pack` put the local
vocabulary back in the artifact. Do not rely on the root line once `files` exists, and do not delete the
nested file; `scripts/check-pack-coverage.cjs` fails the suite if `policy.local.json` reappears.

`shared-core/npm/registry.conf` is the payload's statement that the package ships **no** private-registry
config: it names the public registry and nothing else, and it exists as a file so that claim can be read
and asserted instead of being a comment nobody checks. No npm call reads it — npm global installs resolve
through whatever the machine's own npm configuration says, which is why it sits in `lib/payload.js`'s
`UNREAD` list rather than pretending to be wired. Publish authentication lives in your own `~/.npmrc`,
never in the repository.

The filename matters: it used to be `shared-core/npm/.npmrc`, and `npm pack` silently refused to carry a
file by that name whatever `files` said, so the payload promised something no artifact contained. It is
`registry.conf` now, and `scripts/check-pack-coverage.cjs` compares the payload inventory against the
actual tarball, so a name npm will not ship fails the suite.

## Release procedure (tag a commit as a release)

```bash
cd ~/Dev/asb-mods
git status --porcelain                     # must be empty
npm test                                   # all green (the count is asserted nowhere on purpose)
node tools/vendor.js --dry-run             # payload unchanged or intentionally changed
git diff --cached; git diff                # nothing naming internal systems or home paths

# 1. bump the version (this is the only place the version lives)
npm version 0.2.1 --no-git-tag-version     # edits package.json only; keeps control of the commit
git add package.json shared-core/tooling/manifest.json 2>/dev/null
git commit -m "chore(release): 0.2.1"

# 2. annotate, then push branch and tag explicitly
git tag -a v0.2.1 -m "asb-mods 0.2.1 — <what changed>"
git push origin main && git push origin v0.2.1

# 3. verify the tag actually landed on the remote
git ls-remote --tags origin
```

Rules:

- **annotated tags only** (`-a`) — lightweight tags lose the message and make `%(objectname)` audits
  ambiguous;
- the tag must peel to the commit you intend as the release (`git cat-file -t v0.2.1` → `tag`);
- never move a published tag; cut the next patch version instead;
- `npm version` without its default tagging (`--no-git-tag-version`) keeps the commit and tag as two
  deliberate steps, so you can inspect the diff between them.

## Publishing to npm (first time)

Nothing in the repo automates this, and `scripts` has no `prepublishOnly` hook — the checklist above is
manual by design. If you publish:

```bash
npm login --scope=@asbmods                  # the scope must be yours (npm org or your username)
npm publish --dry-run --access public       # read the file list; 233 files is the 0.3.1 baseline
npm view @asbmods/install version           # sanity: still 404 here

# 2FA accounts need an OTP or an automation bypass token:
npm publish --access public --otp=123456
```

Before the real publish, confirm all of these:

1. `npm pack` contents contain **no** `policy.local.json`, no `backups/`, no reports, no tarballs;
2. the unpacked copy works: `npm pack && cd /tmp/t && npm i <tarball> && npx asbmods --dry-run`;
3. the two `npx` routes in the README still describe reality (`@asbmods/install` once published);
4. `engines.node` matches what the code requires (`>=18`), and no dependency crept into `dependencies`;
5. the `@asbmods` scope is yours and this machine is authenticated — without it npm stops at
   `ENEEDAUTH` before the dry-run even lists files, which is the only thing still between this repo
   and `npx @asbmods/install`;
6. `repository` and `publishConfig` are in `package.json`, so npm can link the published package back
   to these tags and the public registry is the target rather than an internal mirror.

After publishing, `npx @asbmods/install` starts working and the repo's tags become the changelog.
Publishing does not remove the need for tags: pin by tag in docs and issue answers.

## Provenance and signing (what is true today)

- **Commits are not signed.** GitHub's `Verified` badge will never appear on these commits. To change
  that: add a key, set `user.signingkey` and `gpg.format` (`ssh` or `openpgp`), then sign new commits
  with `-S`. Old history is unaffected.
- **No npm provenance.** Attestations require a GitHub Actions publish step with OIDC; there are no
  workflow files in this repository. Users therefore trust the tarball by content, and `npm audit`
  has nothing to attest against.
- Practical substitute: pin by tag (`npx github:avneetsb/asb-mods#v0.3.1`), and compare
  `npm pack --dry-run` file counts between releases to spot payload surprises.

## Rolling back a release

Tags are never rewritten, so rollback is a redeploy:

```bash
git checkout v0.1.0 && asbmods install          # older payload, additive merge
npx github:avneetsb/asb-mods#v0.1.0 install     # same, without a checkout
```

For a published version: within npm's unpublish window you may `npm unpublish @asbmods/install@0.2.1`;
after that, `npm deprecate @asbmods/install@0.2.1 "use 0.2.2 — <reason>"` is the correct instrument.
Deprecation does not break pinned installs, which is what you want on other people's machines.

Then handle the machine state per [page 11](11-update-and-rollback.md): restore removals first, then
config files, then redeploy — and remember hooks/tooling classes added after the rolled-back tag linger
until a removal you authorised.

## Documentation release duties

This wiki is **in-repo** (`docs/wiki/`, linked from `README.md` line 9). It is not GitHub's wiki
feature — no separate `asb-mods.wiki.git` clone, and pages are reviewed like code.

When you release, update in the same commit:

| If you changed… | Also edit |
| --- | --- |
| flags or commands | `04-cli-reference.md` (both tables) and `HELP` text in `install.js` |
| a phase's behaviour | `03-phases.md` and the affected page in `05`–`10` |
| payload shape | `06-shared-core-reference.md` (counts and key lists are stated literally) |
| vendoring rules | `07-personal-tooling-vendoring.md` totals + failure-mode table |
| protection patterns | `08-protection-model.md` — the count and the groups are stated literally |
| anything a user can trip over | `12-troubleshooting.md` (symptom table, and *Known gaps* if it stays unfixed) |

Literal counts in these pages (protection patterns, bundles, payload files, tarball files, test cases)
are deliberate: they turn silent payload drift into a documentation diff you have to notice. The ones that
can be measured mechanically are no longer left to noticing — `npm test` compares the tarball file count in
the row above against `npm pack`, compares every payload directory against the wiki that documents it, and
compares the payload inventory's hashes against the tree; what is left genuinely needs a human, and each
row says which command re-measures it. A stale number here is now a failing suite rather than a rumour:
the tarball row said 233 files while `npm pack` produced 241, and nothing caught it until that comparison
existed.
