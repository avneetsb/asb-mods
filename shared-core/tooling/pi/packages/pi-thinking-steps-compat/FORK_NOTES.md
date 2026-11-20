# pi-thinking-steps-compat — fork notes

Local compatibility fork of **[`pi-thinking-steps`](https://github.com/crustyhacker/pi-thinking-steps) 1.0.17** (MIT, `LICENSE` retained verbatim).
This fork is **user-owned** and lives at `~/.agents/packages/pi-thinking-steps-compat`; the upstream npm copy is not patched in place (pi modification policy: web-installed components are read-only).

Installed as a local pi package:

```bash
pi install ~/.agents/packages/pi-thinking-steps-compat   # declares it in ~/.pi/agent/settings.json
```

## Why the fork exists (the bug)

Pi 1.5.0 changed the signature of an internal helper that this extension reaches into:

```ts
// @earendil-works/pi-coding-agent/dist/modes/interactive/components/markdown-transform.d.ts (1.5.0)
export declare function createMarkdownTransform(
  messageType: MarkdownTransformContext["messageType"],
  isStreaming: () => boolean,          // <-- was a boolean in Pi 0.99.x / 1.0.x
  transformers: readonly MarkdownTransformer[],
  messageId?: string,                  // <-- new
  timestamp?: string                   // <-- new
): (markdown: string, availableWidth: number) => string;
```

pi-thinking-steps 1.0.17 (`internal-patch.ts:304`) still passed `this.isStreaming` (a boolean), and the
helper evaluates `isStreaming()` while building the transform context — outside its per-transformer
`try`. So **every assistant text block** in the TUI threw, on the render timer:

```
TypeError: isStreaming is not a function
    at Object.transform (.../dist/modes/interactive/components/markdown-transform.js:3:106)
    at Markdown.render (.../dist/bundle/chunks/chunk-4EYXVSA5.js:101:1202)
    at AssistantMessageComponent.render (.../dist/bundle/chunks/chunk-44DLKSKE.js:918:4649)
```

The patch installs unconditionally on every TUI `session_start` (`index.ts:397-414`), so there was no
config, flag, or command that avoided it. Upstream's own real-host smoke test (`scripts/test-host.mjs`)
only ever renders **thinking** content, which never reaches the text branch — that is how the drift
shipped. Its CHANGELOG says CI validated Pi `0.99.2`/`1.0.0` only, and its devDependencies pinned
`@earendil-works/*` at exactly `0.99.2`, so no type-check ever saw the 1.5.0 signature.

## What this fork changes

1. **`internal-patch.ts` — the fix.** `createMarkdownTransform` is called with a getter and forwards the
   new context fields, exactly like the host's own call sites
   (`components/assistant-message.js:110,142`):

   ```ts
   transform: createMarkdownTransform("assistant", () => this.isStreaming, this.markdownTransformers, this.messageId, this.timestamp)
   ```

   The stale local parameter declaration (`isStreaming: boolean`) is gone; the factory is typed from the
   host's public `MarkdownTransformContext` / `MarkdownTransformer` types instead.

2. **`internal-patch.ts` — capability probe instead of a version guess.** `assertGetterStyleMarkdownTransform()`
   calls the live factory with an instrumented getter before patching anything. If a future host stops
   calling the getter, or an older host wants a boolean, install *fails loudly* and the existing
   fallback path keeps the stock renderer (a boolean host would otherwise accept our getter as a truthy
   value and report "streaming" forever — a silent-wrong result, not a crash).

3. **`scripts/test-host-markdown.mjs` — new regression harness (not upstream).** Loads this extension
   through the *real* host extension loader against the installed bundled Pi, registers a markdown
   transformer via the public `registerMarkdownTransformer` API, then renders an assistant **text**
   block and asserts: the transformer runs, `context.isStreaming` is a **boolean** for every call, a
   reused component observes streaming → settled (the getter semantics), and `messageId`/`timestamp`
   are forwarded. Reproduced check: pointed at the *unpatched* upstream entry it fails with byte-exactly
   the stack above (`PI_TEST_EXTENSION_ENTRY=~/.pi/agent/npm/node_modules/pi-thinking-steps/index.ts`).

4. **`scripts/link-host-types.mjs` — new dev tooling (not upstream).** Symlinks the *running* Pi host's
   `pi-coding-agent` / `pi-tui` / `pi-ai` / `pi-agent-core` into `./node_modules` so `npm run build`
   type-checks against the host that will actually load this fork. Runtime never needs it (pi loads
   extensions through jiti aliases that already point at the host graph). Re-run after every pi upgrade.

5. **Manifest**: `name` is `pi-thinking-steps-compat`, `version` is `1.0.17-compat.1`, `forkOf` records
   the upstream name/version/repo, and the pinned `devDependencies` on `@earendil-works/*` were
   **dropped** — that pin is what hid the drift. `/thinking-steps diagnostics` reports
   `1.0.17-compat.1`, so you can tell which copy is loaded.

6. **`test/export.test.ts`**: `EntryRenderOptions` extends `KeybindingHints` in Pi 1.5.0 (`keyText`,
   `keyHint` became required), so the entry-renderer test now passes stubs. Production code never read
   those fields, which is why only the test needed it.

7. **`test/thinking-steps.test.ts`**: upstream's "published package contracts" test asserts the npm
   publishing contract (exact `0.99.2` host dev pins, README release-badge strings for this package's
   own version). That contract is wrong for a local fork, so the assertion block was rewritten to the
   fork's contract: manifest shape, every `files` entry present on disk, host deps stay `"*"` with **no
   pinned host devDependencies**, `link:host-types`/`test:host-markdown` scripts present, `FORK_NOTES.md`
   documents the getter fix, plus upstream's own structural checks (`types.ts` / `persistence.ts` import
   shape) unchanged. All other upstream tests are untouched and pass.

## Verifying (all green as of this fork, host Pi 1.5.0)

```bash
cd ~/.agents/packages/pi-thinking-steps-compat
node scripts/link-host-types.mjs          # -> "Linked against host 1.5.0"
~/.local/bin/tsc --noEmit                 # -> clean
TSX=file://$HOME/.pi/agent/npm/node_modules/tsx/dist/loader.mjs
HOST=$(node scripts/link-host-types.mjs --print | cut -d' ' -f1)
for t in thinking-steps summarizer-challenger export review-autosave inspection; do
  node --import $TSX test/$t.test.ts      # 160 upstream unit tests
done
PI_TEST_HOST_PACKAGE=$HOST node scripts/test-host.mjs            # upstream real-host loader smoke
PI_TEST_HOST_PACKAGE=$HOST node scripts/test-host-markdown.mjs   # fork text-path regression
```

`npm run test:package` (`scripts/test-package.mjs`, upstream) is **not** a gate for this fork: it
`npm pack`s the directory, then runs `npm install --include=dev` inside the extracted tarball — an
npm-publishing gate that needs published `@earendil-works/*` tarballs and registry access. A local fork
is installed by path and gets its host modules from pi's jiti aliases, so `test:host` +
`test:host-markdown` replace it as the install-level check. It is left in the tree untouched.

## Upgrading pi / retiring the fork

- After a pi upgrade: re-run `link-host-types` + `tsc` + the two host harnesses. The capability probe
  means a further internal change degrades to the stock renderer with a warning instead of crashing.
- **Retire this fork when upstream publishes a fix.** The change upstream needs is one call site
  (`this.isStreaming` → `() => this.isStreaming`, plus `messageId`/`timestamp` forwarding and the
  parameter type) — filed-worthy at `github.com/crustyhacker/pi-thinking-steps/issues`. Then:

  ```bash
  pi remove ~/.agents/packages/pi-thinking-steps-compat
  pi install npm:pi-thinking-steps
  ```

  and re-run this fork's two host harnesses against the npm copy before deleting the fork directory
  (`scripts/test-host-markdown.mjs` is written to be portable — point `PI_TEST_EXTENSION_ENTRY` at it).

## Unchanged

Everything else is byte-identical to upstream 1.0.17: parsing, modes, review/verbatim/search/compare
browsers, export manager, autosave, persistence, archives, diagnostics, commands, shortcuts, rendering.
No feature was added or removed.
