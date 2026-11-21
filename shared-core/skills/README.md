# `shared-core/skills/` — the four canonical skills

The four directories under `canonical/` here are deployed verbatim to all three hosts:
`~/.claude/skills/<name>/`, `~/.codex/skills/<name>/` and `~/.agents/skills/<name>/` (pi's own skills
directory). Deployment is Phase 4's canonical pass — no templating, no placeholder expansion, and the
same bytes on every host. This README sits beside them and ships with them, but nothing deploys it: it
is the contract the tree keeps, which is exactly why `lib/payload.js` lists it as read-by-nothing.

| Skill | What it gives all three hosts |
| --- | --- |
| `caveman/` | Terse answer style with the technical content kept: commands, paths, warnings, numbers and verdict reasoning stay complete; only prose is compressed. Carries the reference files the style depends on. |
| `gitnexus/` | Codebase orientation and impact analysis through the GitNexus index — how to ask it for flow, architecture or blast-radius answers instead of grepping. |
| `paseo/` | Driving Paseo hosts, projects, workspaces, agents, schedules and heartbeats from any host that has the CLI. |
| `ponytail/` | Smallest change that fully solves the task, plus its audit / review / debt / gain modes. |

## Why these four

They are the capabilities that must behave identically whichever host you happen to be talking to. A
style, a code-intelligence front door, an environment driver and a restraint discipline are all things
you want *not* to restate per host. Each one is a vendored copy of an upstream skill, pinned by
`shared-core/MANIFEST.sha256` like the rest of the payload, so an upstream change arrives as a review
diff here rather than as a surprise in three places at once.

## Contract, and what enforces it

- The directory list above is the payload tree, checked both ways by `test/install.test.js`: a fifth
  skill added here without a row, or a row with no directory, fails the suite.
- Every skill directory needs a `SKILL.md`; an empty skill fails the same test.
- The suite also asserts each one actually lands in `~/.claude/skills/` during a real run, so "deployed
  to all three hosts" is demonstrated rather than asserted.
- The token lint **does** read these files, because they are payload text like everything else in
  `shared-core/`. They pass because they contain no placeholder tokens at all — and nothing expands them, so a
  vendored skill's shell snippets and front-matter arrive on all three hosts byte-identical.

## Adding a skill

1. Vendor the upstream copy under `canonical/<name>/SKILL.md`, plus any reference files it needs.
2. Add its row above — the test will tell you if you forget.
3. Regenerate the payload inventory: `npm run manifest`. Nothing else is required; Phase 4's canonical
   pass picks the new directory up on the next run, and `asbmods verify-core` will notice if a deployed
   copy drifts from the payload.

Related: [shared-core reference](../../docs/wiki/06-shared-core-reference.md),
[phases](../../docs/wiki/03-phases.md), [personal tooling vendoring](../../docs/wiki/07-personal-tooling-vendoring.md).
