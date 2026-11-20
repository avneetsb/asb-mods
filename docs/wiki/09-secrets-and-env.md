# 09 — Secrets and environment

[← 08 Protection model](08-protection-model.md) · [Home](Home.md) · Next: [10 — Hooks reference](10-hooks-reference.md)

Two files, two jobs: **`secrets.env`** holds values and never leaves the state directory;
**`shell-env.sh`** holds non-secret exports and is the file your shell actually sources. Nothing in
this package puts a credential in a repo, in `state.json`, in an archive or in a report.

```text
template (names only)   shared-core/env/secrets.env.template   ──► prompts you
values (600)            ~/.config/asb-mods/env/secrets.env     ──► the only copy
exports (readable)      ~/.config/asb-mods/env/shell-env.sh    ──► sourced by your rc files
```

## What gets prompted

`templateVars()` reads the template into `{ name, placeholder, hint }`; the comment line above each
entry is the hint printed at the prompt. Ten variables ship today:

| Variable | Prompt | Hint in the template |
| --- | --- | --- |
| `HF_TOKEN` | masked | Hugging Face token (graphify embeddings, htmldocx) |
| `SYSTEM_ONE_API_KEY` | masked | System One decision-model API key |
| `OMLX_API_KEY` | masked | OMLX local inference endpoint — no key required when served from localhost |
| `OMLX_BASE_URL` | visible | default pre-filled `http://127.0.0.1:1234/v1` |
| `ANTHROPIC_API_KEY` | masked | Anthropic gateway for Claude Code (enterprise installs set both) |
| `ANTHROPIC_BASE_URL` | visible | set together with the key above |
| `OPENAI_API_KEY` | masked | OpenAI-compatible local endpoint used by graphify/prompt tooling |
| `OPENAI_BASE_URL` | visible | ditto |
| `DEEPCODE_TOKEN` | masked | misc tool auth |
| `CODX_AUTH_TOKEN` | masked | misc tool auth |

Masking is a name test, not a judgment call: any name matching
`KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL` is prompted with masked input (`readline` with the
output suppressed), everything else — mostly `*_BASE_URL` — is visible so you can see what you type.

## What happens on `asbmods secrets`

1. Read existing `secrets.env` (if present) with `parseDotEnv`, quote-tolerant.
2. For each template variable: keep the existing value, unless `--rotate-secrets` was passed.
3. Prompt for anything still unset — **unless `--no-input`**, which never prompts and simply leaves it
   unset (this is what makes CI runs non-interactive and repeatable).
4. Write with mode `600`, creating `env/` under the state dir.
5. **Re-read and verify**: content round-trips, and permission bits are still `600`. Both are reported;
   `state.json` records `secretsVerified: true|false`.
6. The report contains variable **names only** — never values. `state.json`, `reports/*` and archives
   therefore carry no credentials.

`~/.config/asb-mods/env/secrets.env` is outside any repository, which is the point: Phase 3 archives
and removes agent trees, and a credential inside one of them would end up in an archive tarball.

## Adding or removing a variable

```bash
# add: one comment line (the hint) + one uncommented NAME="" line
${EDITOR:-vi} shared-core/env/secrets.env.template
asbmods secrets --rotate-secrets     # re-prompts everything, including the new name
```

An entry whose line is commented out is invisible to `templateVars()`, so commenting a line "retires"
a variable from prompting without deleting the value from an existing `secrets.env`. To drop a value
from the file, edit `~/.config/asb-mods/env/secrets.env` directly — the installer never deletes keys.

## `shell-env.sh` and your rc files

Deployed by `deployShellEnv()` into `<state-dir>/env/shell-env.sh`, then a **marked block** is written
into `~/.zshrc`, `~/.bashrc` and `~/.zshenv`. The block is delimited by exported markers
(`MARK_BEGIN` / `MARK_END` in `lib/secrets.js`), and rewriting is idempotent: an existing block is
replaced in place, a missing one is appended, and each touched file is snapshotted first via
`backupString` into `file-backups/`.

The 13 exports are the machine-independent contract other tools rely on: TLS trust
(`SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`), pi model pin (`PI_DEFAULT_PROVIDER`,
`PI_DEFAULT_MODEL`, `LOCALLLM_OMLX_BASE_URL`, `PI_PERMISSION_MODE`), memory backends (`MNEMOSYNE_*`,
`ENGRAM_DATA_DIR`) and the shell-output filter database (`RTK_DB_PATH`).

**Why TLS variables matter:** Node and Python under Homebrew here cannot verify this machine's chain
from the stock CA bundle, so any component that downloads a model or calls a local endpoint dies on
certificate verification unless `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` point at a bundle that includes
the keychain roots. This is the single most common "it worked on my machine" cause in this setup.

Secrets are **not** exported by `shell-env.sh`: it sources the secrets file rather than inlining it,
so rotating a value never requires redeploying shell config.

## Verifying

```bash
exec zsh                                  # reload the shell so the block is sourced
find ~/.config/asb-mods -name 'asb-*check.sh'   # deployed hook helpers exist
ls -l ~/.config/asb-mods/env/secrets.env  # must be -rw-------  (600)
asbmods status                            # secrets check is one of the green checks
printenv | grep -E '^(SSL_CERT_FILE|PI_DEFAULT_MODEL)='   # exports reached the shell
```

`asbmods status` is read-only — run it any time. A `600` mismatch is reported as a warning rather than
silently chmod'd, because on a shared machine the right fix may be deletion, not a mode change.

## Rotation duty (read this once)

A file being mode 600 on your machine is not proof it was never wider, and an archive taken before you
noticed may contain a value. If a credential ever appeared in a committed file, a log, or an archive
that left the machine:

1. revoke/rotate it at the provider — removing the line is not remediation;
2. `asbmods secrets --rotate-secrets` to put the new value in place;
3. re-check archives: `grep -rl '<old-value-prefix>' ~/.config/asb-mods/backups` and delete the
   affected archive directory if it left the machine;
4. never put a value into a memory stack (`mem_save`, `mnemosyne_*`), an issue body, or a commit
   message. The auto-private-tags extension masks credentials before capture, but masking is not
   revocation.

## Non-interactive and fixture use

```bash
# CI: never prompt, never fail because a value is missing
asbmods --no-input --dry-run

# set values without the prompt at all, then verify
install -m 600 /dev/null "$XDG_CONFIG_HOME/asb-mods/env/secrets.env"   # or just create it
asbmods secrets --no-input && asbmods status

# isolate everything (state, archives, reports) under a scratch home
ASB_MODS_HOME="$PWD/fixture" XDG_CONFIG_HOME="$PWD/fixture/.config" asbmods all --yes --no-input
```

`ASB_MODS_HOME` moves the target home; `XDG_CONFIG_HOME` moves the state directory. The suite uses
both to run the full destructive flow against a throwaway fixture, which is why shipping destructive
phases is safe to test.
