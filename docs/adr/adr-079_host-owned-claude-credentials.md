# ADR-079: Multi-account Claude credentials are host-owned — in-app sign-in, tokens handed to cli.js the way Claude Desktop does

**Status:** Accepted (2026-09-27; owner rulings of the same day). Supersedes the mechanism of
[ADR-015](adr-015_multi-account-file-credentials.md) (§1 the `skip-securestorage` patch, §2 the
`SKIP_SECURESTORAGE` spawn env, §3 "Add" through cli.js); ADR-015's account model — one directory
per account under `~/.claude/ui/accounts/<id>/`, shared `~/.claude` config, switch = respawn —
stands. Amends [ADR-014](adr-014_native-anthropic-oauth.md) (multi-account sign-in no longer drives
cli.js's OAuth control requests) and [ADR-078](adr-078_claude-harness-capability-gating-and-patch-set.md)
(`skip-securestorage` leaves the patch set).
**Relates to:** [ADR-071](adr-071_metering-ledger-and-window-value.md) §6 (one refresh attempt per credential
version), [ADR-030](adr-030_capability-honesty.md), [ADR-057](adr-057_remote-vendor-oauth-paste-back.md).

## Context

ADR-015 made multi-account work by patching cli.js: `SKIP_SECURESTORAGE` forced its credential store
to a plaintext file, `CLAUDE_SECURESTORAGE_CONFIG_DIR` pointed that file at the active account's
directory, and cli.js did everything else — sign-in, storage, refresh. ADR-078 set the goal of
running any Claude Code harness, including Anthropic's unpatched binary, and the owner asked
(2026-09-27) whether the store could be forced to a file without a patch.

It cannot (cli.js 2.1.280): Linux is file-only; Windows is file-only only while the remote flag
`tengu_windows_credman` is off (`CLAUDE_CODE_FORCE_WINDOWS_CREDMAN` can only force it on); macOS is
Keychain-primary unconditionally, and the first Keychain write deletes the file. But cli.js has a
supported host-token path, and Claude Desktop uses it. Read from Desktop 2.9939.2's own bundle:

- spawn env: `CLAUDE_CODE_ENTRYPOINT=claude-desktop`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `CLAUDE_CODE_OAUTH_SCOPES`, `CLAUDE_CODE_SUBSCRIPTION_TYPE`, `CLAUDE_CODE_RATE_LIMIT_TIER`, and
  (from the SDK's `getOAuthToken` option) `CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH=1`; `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_CUSTOM_HEADERS` removed and `ANTHROPIC_BASE_URL` pinned to its
  own API host; the token refreshed first if it expires
  within 5 minutes, and no spawn at all without a usable token;
- a renewal timer at `expiresAt − min(5 min, remaining/2)` (6 h cap, 60 s floor after a write,
  60 s retry), and every rotation pushed to live sessions with
  `update_environment_variables {CLAUDE_CODE_OAUTH_TOKEN}`;
- `oauth_token_refresh` (sent by cli.js on a 401) answered with a token or
  `{accessToken:null, reason}` — `signed_out` / `identity_changed` / `transient` / `refresh_failed`.

A live probe with Haiku against the official 2.1.280 binary confirmed every leg: a valid env token
runs a turn with no refresh; an invalid one recovers through `oauth_token_refresh` (four concurrent
requests on one spawn, so the host's refresh must be single-flight); pushes are acknowledged; a
declined refresh fails the turn with cli.js's own 401 text; cli.js writes no credential file and
no file holds the token; Bash children get none of the token variables (cli.js scrubs them).

One gap: sign-in. Multi-account sign-in was cli.js's `claude_authenticate` flow, which stores what
it gets in cli.js's own store — on macOS, without the patch, the Keychain.

## Decision

1. **The app owns multi-account credentials end to end.** Each account's
   `~/.claude/ui/accounts/<id>/.credentials.json` is written only by the app — at sign-in and at
   every refresh — in cli.js's own `claudeAiOauth` shape. cli.js never reads or writes it.
2. **Sign-in is in-app for multi-account** (`src/core/auth/claude-oauth.ts`, behind
   `ClaudeLoginBackend` in `src/main/services/claude-login-backend.ts`): cli.js's claude.ai login
   reproduced — authorize URL, params and scopes, PKCE, loopback or pasted `code#state`, the JSON
   exchange, the profile and roles reads. Single-account sign-in stays cli.js's (ADR-014).
3. **Sessions get the token the way Desktop gives it** (spawn env, 5-minute margin, fail closed,
   renewal timer, push on rotation, the four decline reasons; an inherited `ANTHROPIC_BASE_URL` is
   dropped so the account's token never reaches a gateway named in the user's shell), from one keeper in core
   (`src/core/services/claude-host-token.ts`). Every refresh, from the keeper or from the usage
   reader, goes through the one single-flight `refreshClaudeToken` and ADR-071 §6's guard, and every
   rotation reaches the live sessions of the active account.
4. **Scope.** Multi-account only. Single-account keeps the user's own Claude Code login, stored and
   refreshed by cli.js. A custom endpoint profile wins over host tokens.
5. **`skip-securestorage` is deleted**; the patch set is ADR-078's minus it.

### Rejected alternatives

- **Keep the patch for sign-in only** — smaller, but the patch stays and multi-account sign-in works
  only on the patched harness.
- **Force a file store without a patch** — not possible on macOS (see Context).
- **Per-account `CLAUDE_CONFIG_DIR` with the Keychain** — ADR-015's rejected alternative still holds
  (fragmented config), and the app would need Keychain reads, which prompt.

## Consequences

- Multi-account runs on any Claude Code harness, including Anthropic's unpatched binary, on every
  platform — the Keychain is never in the path.
- One refresher per account instead of one per live cli.js process plus the app; the race over a
  single-use rotating refresh token that existed under ADR-015 (cli.js's `.storage-write` lock was
  never taken by the app) is gone.
- A spawn whose token is unusable is refused with a sign-in error instead of silently using the
  machine's default Claude login.
- cli.js's initialize `account` carries no email under an env token, so login state in multi-account
  mode comes from the account's credentials, not from cli.js.
- MCP OAuth tokens (`mcpOAuth`) now live in cli.js's default store and are shared by all accounts,
  as they are between Desktop and a terminal `claude`; per-account MCP logins from ADR-015 need one
  re-authorisation.
- ADR-071 §6's refresh guard moved out of the usage fetcher into one shared instance
  (`claude-refresh-guard.ts`), keyed per file; a 408, 429 or 5xx from the token endpoint is no
  longer read as a refusal.
- The OAuth authorize/exchange details join the CLI-bump re-check list
  (`docs/protocol-cc/12-maintenance.md` §12.1).
- Not enforced on the multi-account path: cli.js's managed `forceLoginMethod` /
  `forceLoginOrgUUID` policy (the app reads no managed settings).

## Verification (2026-09-27)

Haiku 4.5, Windows, official unpatched 2.1.280 binary unless noted: the app's own `query()` + token
keeper ran a turn on a host token, an `update_environment_variables` push was acknowledged, an
invalid token was declined through `oauth_token_refresh` with cli.js's 401 text, and no file
carried the token. In the real Electron app (isolated home, fake credential, both binaries): the
spawn ran on the env token and the refresh round trip reached the keeper; a missing credential
refused the spawn with the sign-in message and spawned no cli.js; the Proxy pane and the voice gate
behaved as ADR-078 says. Not verified live: an in-app sign-in against claude.ai, and the macOS
bundle.
