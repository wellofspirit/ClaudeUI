# Follow-up — opencode auth UX: native `auto` OAuth drive (#7) + 401 re-login card (#2)

> ROADMAP **#7** (🟡) + **#2** (🟠), built together (the card triggers the flow). Gives opencode a
> **no-paste browser login** for OAuth/subscription vendors (ChatGPT/Copilot/etc.) and a **structured,
> interactive re-login card** when a vendor token expires mid-conversation. **Claude untouched.** Branch
> `v2-followup-opencode-auth-ux` (off `v2-followup-subagent-questions`). opencode source for reference:
> `D:\WorkPlace\opencode-src` (v1.17.9, READ-ONLY).
>
> **#3 (cost-display billingType gating) is a separate small follow-up — NOT in this branch.**

## The decision (locked, user-confirmed): drive opencode's native `auto`. Do NOT self-host a listener.

Verified in opencode source — `method:'auto'` means *the vendor's auth plugin completes the flow
itself*; the client supplies **no code**:
- **OpenAI/Codex** (`plugin/openai/codex.ts`): the plugin runs its **own loopback HTTP server** on
  `http://localhost:1455/auth/callback` (PKCE + state internal). `authorize()` starts it + returns the
  browser URL; the client then POSTs `/oauth/callback` **with no code**, which blocks until the
  plugin's loopback catches the redirect, then exchanges + persists tokens.
- **GitHub Copilot** (`plugin/github-copilot/copilot.ts`): `auto` is a **device-code** flow — no
  loopback; `callback()` polls the token endpoint until the user enters the code on GitHub's page.

Either way the **client contract is identical and listener-free**: `authorize` → open `url` (show
`instructions`) → `await callback(NO code)`. We host nothing. (`auth.ts:194-199`: core calls
`match.callback()` with no args for `auto`; `match.callback(code)` only for `code`.)

## Scope (locked)

- **#7** — wire the `method:'auto'` path end to end: thread an **optional** `code` through our
  `oauthCallback` chain, add a reusable **store action** that does authorize → open browser → await
  callback(no code) → refresh, and replace the Settings › Vendors misleading *"…run `opencode auth
  login` in a terminal"* hint (`settings-sections.tsx:660-666`) with the real awaited flow + a
  "Waiting for browser authorization… [Cancel]" state. The existing **`code` (paste) path stays**.
- **#2** — when an opencode turn fails with `ProviderAuthError`, surface a **structured interactive
  re-login card** (not the plain `FloatingError` hint) targeting the failing vendor, whose
  "Re-authenticate" button runs the **#7 store action** inline; on success, offer **Retry** (re-send
  the last user prompt) + Dismiss.
- **Claude untouched** — Claude never emits `ProviderAuthError`; its `AuthErrorBlock` (ADR-014) is a
  separate path. The generic opencode `FloatingError` path stays for **non-auth** errors.

## Verified facts (seam map — do NOT re-discover)

### OAuth plumbing (already exists, Phase 5c)
- **IPC** (`src/main/ipc/session.ipc.ts`): `vendor-auth:probe` (:1731), `:list-options` (:1739),
  `:set-key` (:1752), `:oauth-authorize` (:1763 → `{url, method:'auto'|'code', instructions}`),
  `:oauth-callback` (:1782 → `boolean`), `:remove` (:1801). All dispatch to
  `engineAuthRegistry.require(engineId).<method>()`.
- **Preload** (`src/preload/index.ts:314-337`): `vendorAuthProbe`, `vendorAuthListOptions`,
  `vendorAuthSetKey`, `vendorAuthOauthAuthorize`, **`vendorAuthOauthCallback(engineId, vendorId,
  method, code)`** (:330-335, uses `unwrap` — **no `withTimeout`**, so a long await is fine),
  `vendorAuthRemove`. Mirror in `ClaudeAPI` (`src/shared/types.ts`).
- **`OpencodeAuthProvider`** (`src/main/auth/OpencodeAuthProvider.ts`): `oauthAuthorize(vendorId,
  method, inputs?)` (:161), `oauthCallback(vendorId, method, code)` (:175 → `client.oauthCallback`),
  `listVendorAuthOptions()` (:129), `setVendorApiKey` (:149), `removeVendorAuth` (:188),
  `buildAccountRef(vendorId)` (:208). Mutations invalidate the vendor-map cache +
  `invalidateOpencodeModelCache()`.
- **`OpencodeClient`** (`src/main/opencode/OpencodeClient.ts`): `oauthAuthorize(providerId, method,
  inputs?)` (:94), **`oauthCallback(providerId, method, code)`** (:109 → `POST
  /provider/{id}/oauth/callback {method, code}`). **`code` must become optional here** (opencode's
  `CallbackInput.code` is already optional — `provider/auth.ts:62-66`).
- **`method` is the index** into the per-vendor `/provider/auth` catalog (`AuthOption[]`).
- **Open browser**: renderer uses `window.open(url, '_blank')`; `main/index.ts:323-326`
  `setWindowOpenHandler` → `shell.openExternal`. Reuse this (no new IPC needed).
- **Post-auth refresh**: `settings-sections.tsx` `refresh()` re-calls `vendorAuthProbe` +
  `vendorAuthListOptions`; models refresh on the next `session:get-engine-models` (cache was
  invalidated). **No cross-window broadcast today** (acceptable).

### Current renderer auth UI (the gap)
- `src/renderer/src/components/SettingsDialog/settings-sections.tsx:556-837` `VendorOpencodeSection`.
  `handleOAuthStart` (:642): for `method:'auto'` it opens the URL and shows a hint telling the user to
  run a terminal command — **it never awaits the callback** (:660-666). For `method:'code'` it opens
  the URL + shows a paste box (`handleOAuthSubmit` :670, paste UI :780-808). Uses `firstOauthIdx`
  (first oauth option) — no method picker.

### Auth-error (401) path
- `event-mapper.ts:280-298` `session.error`: wire shape `properties.error = { name, data:{providerID?,
  message} }`. For `name==='ProviderAuthError'`, `vendorId = data.providerID`; currently returns
  `{kind:'error', message:<hint>}`.
- `OpencodeSession.dispatchMapperOutput` `kind:'error'` → `this.send('session:error', message)`
  (:582-586).
- Renderer: `useClaudeEvents.ts:213-216` `onError` → `addError` → **`FloatingError.tsx:133-167`**
  (transient floating banner, string only). This is where opencode errors show today.
- Claude reference: `AuthErrorBlock` (`MessageBubble.tsx:547-723`) — inline `api_error` block wired to
  Claude's `signIn`/`submitOAuthCode`/`retrySend` store actions. **Different mechanism — do not reuse
  for opencode**; build an opencode-specific card driven by the vendor-auth action.

## Design / steps

### Part A — #7: native `auto` OAuth drive

1. **Optional `code` through the chain.** `OpencodeClient.oauthCallback(providerId, method, code?)` →
   POST body `{ method, ...(code !== undefined ? { code } : {}) }`. Then make `code` optional in
   `OpencodeAuthProvider.oauthCallback(vendorId, method, code?)`, the `vendor-auth:oauth-callback` IPC
   handler, the preload `vendorAuthOauthCallback(…, code?)`, and the `ClaudeAPI` type. (Claude's
   `ClaudeAuthProvider` doesn't implement vendor oauthCallback — unaffected.)
2. **Reusable store action** (`session-store.ts`): `authorizeVendorOAuth(engineId, vendorId): Promise<
   {ok: boolean; needsPaste?: {url:string; method:number; instructions:string}}>`:
   - `listVendorAuthOptions(engineId)` (or cached) → pick the first `type:'oauth'` method index.
   - `vendorAuthOauthAuthorize(engineId, vendorId, methodIdx)` → `{url, method, instructions}`.
   - `window.open(url, '_blank')`.
   - if `method === 'auto'`: set a store field `vendorOAuth = {engineId, vendorId, stage:'waiting',
     instructions}`; `await vendorAuthOauthCallback(engineId, vendorId, methodIdx)` (**no code** —
     long-lived); on `true` → clear `vendorOAuth`, re-probe + refetch models, return `{ok:true}`; on
     throw/false → `vendorOAuth.stage='error'`, return `{ok:false}`.
   - if `method === 'code'`: return `{ok:false, needsPaste:{url, method:methodIdx, instructions}}` so
     the caller can show the existing paste box.
   - A `cancelVendorOAuth()` action clears `vendorOAuth` (abandons the await UI; opencode's plugin
     times out server-side — note it; we can't abort the server wait).
3. **Settings › Vendors**: replace the `auto` branch's terminal-hint (`settings-sections.tsx:660-666`)
   with a call to `authorizeVendorOAuth`; render the `vendorOAuth.stage==='waiting'` state ("Waiting
   for browser authorization…" + Cancel) and `'error'` state. Keep the `code`/paste branch
   (use `needsPaste`). Keep API-key + remove flows unchanged.

### Part B — #2: structured 401 re-login card

4. **Mapper**: in `event-mapper.ts:280-298`, when `name==='ProviderAuthError'` **and** `data.providerID`
   is present, return a new MapperOutput `{kind:'auth-required', vendorId, message}` instead of
   `{kind:'error'}`. If `providerID` is absent, keep the current `{kind:'error'}` hint (fallback).
   Add `'auth-required'` to the `MapperOutput` union.
5. **Dispatch + IPC**: `OpencodeSession.dispatchMapperOutput` new case → `this.send(
   'session:vendor-auth-required', { vendorId, message })`. Add the `session:vendor-auth-required`
   listener to preload + `ClaudeAPI`; `useClaudeEvents.ts` handler → store action
   `setVendorAuthRequired(routingId, { vendorId, message })`. Store: a per-session
   `vendorAuthRequired: { vendorId, message } | null` (cleared on success/dismiss and on a successful
   turn).
6. **Card** (`src/renderer/src/components/chat/`): a new interactive component (mounted near
   `FloatingError` in `ChatPanel.tsx`, or as a sibling floating card) shown when the active session has
   `vendorAuthRequired`:
   - "Authentication required — **{vendorId}**" + the message.
   - **[Re-authenticate]** → `authorizeVendorOAuth(engineId, vendorId)`; reflect the shared
     `vendorOAuth` waiting/error state. On `{ok:true}` → clear `vendorAuthRequired`, show success +
     **[Retry]** (re-send the last user prompt for the session via the existing send path) + [Dismiss].
     On `needsPaste` → link to Settings › Vendors (rare for subscription vendors).
   - **[Dismiss]** → clear.
   - **opencode-only**: only opencode emits `session:vendor-auth-required`; Claude unaffected.

## Tests (mocked, no binary/no live OAuth)

- **OpencodeClient/Provider**: `oauthCallback` without a `code` → POST body omits `code` (auto);
  with a code → includes it (paste). (Guard the optional-thread.)
- **store `authorizeVendorOAuth`**: mocked IPC — `authorize` returns `method:'auto'` → `window.open`
  called, `vendorAuthOauthCallback` invoked **without code**, success → `vendorOAuth` cleared + probe/
  models refetched + `{ok:true}`; `method:'code'` → returns `needsPaste`, no callback awaited;
  callback rejects → `{ok:false}` + `stage:'error'`.
- **event-mapper**: `session.error` with `ProviderAuthError` + `data.providerID` → `{kind:'auth-
  required', vendorId, message}`; **without** `providerID` → `{kind:'error'}` (fallback unchanged);
  non-auth error → `{kind:'error'}` (unchanged).
- **OpencodeSession**: an `auth-required` mapper output → `session:vendor-auth-required` emitted with
  `{vendorId, message}`.
- **Card component**: given a session with `vendorAuthRequired`, renders the card; clicking
  Re-authenticate calls `authorizeVendorOAuth`; success shows Retry; Dismiss clears. A session without
  it → no card. (Reuse the `__sessionStore`-injection screenshot technique for a real-app shot if
  driving live OAuth isn't possible — see Verify.)
- Keep existing vendor-auth + FloatingError + Claude AuthErrorBlock tests green.

## Verify

```
bun run typecheck && bun run test && bun run test:ci && bun run lint && bun run build
```
- 0 lint errors (3 pre-existing warnings OK). **No `bun install`** (better-sqlite3 ABI).
- **Real-app (orchestrator-driven):** live OAuth needs real vendor creds, so the orchestrator will
  pixel-verify the **card** + the **waiting state** by injecting a synthetic `vendorAuthRequired` (and
  a `vendorOAuth` waiting state) via the temporary `__sessionStore` hook + a throwaway Playwright
  inject script (same technique as the subagent-question card), then screenshot. Agent: report
  unit/gate results; the orchestrator does the real-app shot. (A genuine end-to-end OAuth drive against
  a real ChatGPT/Copilot account is a manual check the user can do later.)

## Gotchas

- **We host NO listener.** For `auto`, success comes from `await oauthCallback(NO code)` — opencode's
  plugin owns the loopback/device flow. Do not add a custom protocol/scheme or local server.
- **The `auto` callback is long-lived** (until the user finishes in-browser / the plugin times out).
  It's not `withTimeout`-wrapped (preload `unwrap`), so it won't be killed — show the waiting state;
  Cancel only abandons the UI (server times out on its own).
- **`vendorId` from `data.providerID`** — only emit `auth-required` when present; else keep the hint.
- **Don't double-surface** — `ProviderAuthError` routes to the card, NOT also `FloatingError`.
- **Behavior-preserving:** Claude's `AuthErrorBlock`, the opencode `code`/paste flow, API-key + remove
  flows, and `FloatingError` for non-auth errors all stay unchanged.
- **`pricing.ts`/shared stay pure** (n/a here, but no new deps). opencode-src is read-only.

## Out of scope (this branch)
- **#3** cost-display billingType gating (separate small follow-up next).
- Multi-method picker (we use the first oauth method); full per-billingType metric semantics.
- Cross-window auth-state broadcast (single settings window is fine today).
- Self-hosted loopback / custom URL scheme (explicitly rejected).

## Commit (orchestrator, after review + real-app shot)
One commit, no AI attribution. Suggested subject:
`feat(v2/opencode): native browser OAuth (auto) + interactive vendor re-login card`.
