# ADR-015: Multiple-account support via file-based credentials (SKIP_SECURESTORAGE)

**Status:** Accepted
**Date:** 2026-06-15

## Context

Building on native OAuth (ADR-014), users want to hold **multiple Claude
subscription accounts** and switch the active one — without macOS Keychain trust
prompts.

cli.js's credential store is a `keychain-with-plaintext-fallback` facade:
Keychain is **primary**, the plaintext `<dir>/.credentials.json` is only a
fallback, and a successful Keychain write **deletes** the file copy. There is no
built-in flag to disable the Keychain (only `CLAUDE_SECURESTORAGE_CONFIG_DIR`,
which relocates the *fallback file* but leaves Keychain primary). Consequences
established in ADR-014:

- The Keychain holds a **single** credential (service `Claude Code-credentials`,
  with a `-<sha256(configDir)[:8]>` suffix per config dir). No per-account file
  to swap.
- Cross-process Keychain reads **prompt** (the item's ACL doesn't trust our
  spawned `security` process).
- The OAuth control flow returns only `{account}`, never the raw token (it goes
  straight to the store), so we can't capture a token to manage ourselves
  without one Keychain read.

So a "swap only the token, keep one config dir" approach is impossible while the
Keychain is primary, and full per-account `CLAUDE_CONFIG_DIR` isolation would
fragment settings/history/usage (everything cli.js keeps under `~/.claude`).

## Decision

Add the missing flag to cli.js and manage per-account credential **files**.

1. **`skip-securestorage` patch.** When env `SKIP_SECURESTORAGE` is truthy, the
   credential store getter returns the **plaintext file backend directly**,
   bypassing the Keychain for all read/write. One-line, env-gated, opt-in; the
   default path is byte-identical. Full reverse-engineering guide in
   `patch/skip-securestorage/README.md`.

2. **Per-account credential dir, shared config.** Each account is a directory
   `~/.claude/ui/accounts/<id>/` holding only its `.credentials.json`. cli.js is
   spawned with `SKIP_SECURESTORAGE=1` + `CLAUDE_SECURESTORAGE_CONFIG_DIR=<that
   dir>` (via the existing `buildEnv` overlay). `CLAUDE_SECURESTORAGE_CONFIG_DIR`
   relocates **only** the credentials file — settings, `projects/` history, and
   usage stay shared in `~/.claude`. This realizes the "shared config,
   creds-only switch" goal (the option set aside in ADR-014) without symlinks or
   Keychain access.

3. **Account lifecycle.**
   - *Add* — run the OAuth login flow (ADR-014) with a fresh account dir set;
     cli.js writes that account's `.credentials.json`.
   - *Switch* — change the active account id; chat/service sessions respawn with
     the new dir (sessions already respawn to pick up credential changes per
     ADR-014).
   - *Delete* — remove the account dir.

4. **Opt-in setting.** A "multiple account support" checkbox in Settings. When
   enabled, all cli.js spawns get `SKIP_SECURESTORAGE=1`. macOS users see a
   warning that they must **re-login**, because their existing credential lives
   in the Keychain and file-mode starts empty (the file is written on next
   login). The settings area lists persisted accounts with switch + delete.

### Rejected alternatives

- **Full per-account `CLAUDE_CONFIG_DIR`** — clean isolation but fragments
  settings/history/usage; heavier and changes every `~/.claude` read path.
- **Symlink-hybrid** (per-account config dir, symlink shared files back) —
  fragile against cli.js layout changes.
- **Reuse Keychain with per-account service names** — still prompts, and we'd
  need Keychain reads to extract tokens.

## Consequences

- **Credentials are stored in plaintext** (`.credentials.json`, mode `0600`)
  when multi-account is enabled — the same fallback file cli.js itself uses in
  headless/CI. This is the explicit trade for prompt-free account switching;
  surfaced in the settings warning. Single-account users keep Keychain storage
  (flag off) by default.
- We own the per-account dirs and the active-account pointer; cli.js still owns
  all token read/write/refresh within the active dir (we never parse tokens).
- The `skip-securestorage` patch is one more content-regex patch to re-anchor on
  cli.js version bumps (guarded by `patch/skip-securestorage/test.mjs`).

## Touch points

- `patch/skip-securestorage/` — the cli.js patch (apply + README + test)
- `src/main/sdk/args.ts` (`buildEnv`) — inject `SKIP_SECURESTORAGE` + `CLAUDE_SECURESTORAGE_CONFIG_DIR`
- account manager service (per-account dirs, switch/add/delete) + IPC
- `SettingsDialog` — enable checkbox + account list; store + renderer wiring

## Related

- **[ADR-014](adr-014_native-anthropic-oauth.md)** — native OAuth login this builds on.
