# ADR-070: One authentication surface — a top-bar pill, an engine-neutral transcript row, one resolution signal

**Status:** Accepted (2026-09-19), owner-ruled from mockups `c2e5ec5f` (directions), `e3975156` (direction B refined), `4ed195a3` (dialog trim)
**Amends:** [ADR-068](adr-068_chatgpt-identity-vault-owned-codex-injection.md) §3 (one sign-in dialog — held) and §4 ("one event, one card" — **not achieved**; this ADR names the cause and finishes it)
**Relates to:** [ADR-030](adr-030_capability-honesty.md) (never advertise a flow that cannot complete), [ADR-057](adr-057_remote-vendor-oauth-paste-back.md) (the remote paste panel this trims but keeps), [ADR-027](adr-027_component-test-data-attributes.md) (the testids the verification asserts), [ADR-051](adr-051_sync-core-replication-architecture.md) (`authRequired` is a sealed field; its writer is the replica fold)

## Context

ADR-068 §3 consolidated the sign-in **flow** into one dialog and succeeded: there is one `SignInDialog`, and the four flow implementations it replaced are gone. ADR-068 §4 promised the matching consolidation of the **notification** — "one event, one card" — and did not deliver it. The owner hit the result on a cold start (2026-09-19): a yellow banner on boot, a different error on the first prompt, and the recollection that a ChatGPT expiry had previously produced four separate prompts. After signing in, none of them cleared, and the one Retry affordance was missed.

That report is accurate, and the code explains all of it.

### Every surface an auth problem can reach today

Six render in the chat, and they are not mutually exclusive — a single Codex token-refresh failure lights four of them at once:

| Surface                                                                              | Site                                                                                                                                    | Fed by                                                          |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `AuthBanner` — the yellow line                                                       | `ChatPanel.tsx:290`                                                                                                                     | `vendorAuth.anthropic` ← `session:auth-source` from cli.js init |
| `InputBox.signInHint`                                                                | `InputBox/View.tsx:567`                                                                                                                 | `providerAuth`                                                  |
| `AuthRequiredRow`                                                                    | `ChatPanel.tsx:412`                                                                                                                     | `session:auth-required`                                         |
| `FloatingError` (×N)                                                                 | `ChatPanel.tsx:413`                                                                                                                     | each engine's **duplicate** `session:error`                     |
| `AuthErrorBlock`                                                                     | `MessageBubble.tsx:175`                                                                                                                 | Claude's `api_error` / `errorType: 'authentication'`            |
| Model picker, mobile config sheet, four Settings rows, the dialog's own account list | `InlinePickers.tsx`, `MobileConfigSheet.tsx`, `ProviderSheet.tsx`, `ChatgptAccountsSetting.tsx`, `CodexAccount.tsx`, `SignInDialog.tsx` | `providerAuth`, `provider-registry:list`                        |

**The duplicate is deliberate and it is the root cause.** Every engine emits the generalized event _and_ re-sends its own words as an ordinary error, on the reasoning that dropping the vendor's text would lose information:

- `CodexSession.ts:715-721` — event, then `'ChatGPT sign-in expired; sign in again from Settings › Models & providers'`
- `OpencodeSession.ts:1259-1261` — event, then `output.message`
- `PiSession.ts:1354-1356` — event, then `output.message`
- `claude-session.ts:1187` — the transcript `api_error` block, then the event

The information-preservation instinct was right; the delivery was wrong. The event's own doc comment states the intent plainly — _"It carries no message — the emitting engine sends its own words as `session:error`"_ (`events.ts:245`) — which is how "one event, one card" became one event and two cards. A third arrives from model discovery: `CODEX_SIGN_IN_REQUIRED_ERROR` (`session-store.ts:285`) is pushed onto the same `errors[]` list with a Sign in button of its own.

### A layout bug on top of the duplication

`AuthRequiredRow`, `FloatingError` and `SandboxViolationToast` are siblings in `ChatPanel`, each rendering `absolute top-12 left-0 right-0 z-20`. They occupy the same coordinates with the same stacking order and paint over one another; which one the user sees is DOM order, not intent.

### Why nothing clears after a successful sign-in

There is no signal anywhere in the app that means _this provider's credential is good now_. Each surface therefore invented its own clear condition, and none of them is "the user signed in":

- `authRequired` is cleared only when a turn **starts running again** (`reducer.ts:862`) or by the manual dismiss. A sign-in does not touch it — by design, because at the time the only proof of a working credential was a turn that worked.
- `errors[]` is cleared only by clicking × on each card.
- `AuthErrorBlock` holds a component-local `dismissed`; the block itself is transcript **data**, so the row returns on reload, permanently, still offering a live Sign in for a credential fixed days ago.
- `vendorAuth.anthropic` is written only by `session:auth-source`, which arrives on a cli.js spawn. The Claude banner is therefore stale in both directions.
- `providerAuth.chatgpt` _is_ refreshed, on `closeSignIn` — which is why the composer hint is the one surface that does clear, and why the inconsistency reads as random.

### Why the Retry was missed

`SignInDialog`'s footer offers "Retry last prompt" only when `stage === 'done'` **and** `request.retry` is populated — and only `AuthErrorBlock` and `AuthRequiredRow` populate it. A sign-in entered from the banner, the composer hint, the picker or Settings has no retry at all. Where it does appear it is a _tinted secondary_ button beside the _primary_ `Done` that destroys it, under three sentences of fan-out prose competing for the same attention.

### The dialog's prose

Measured as words of prose the user must read (labels, buttons and data excluded), the worst path — web ChatGPT, paste-back, open to done — is **111 words**. Choose 22, desktop flow 24, device code 36, paste-back 51, done 36.

### Two axes, one of which is not in scope

ClaudeUI's own remote-access authentication (`NoAuthBanner`, `SessionExpiredNotice`, the passkey and password screens in `src/web`) is a different question from a vendor credential, with a different audience and a different failure mode. It is deliberately **not** merged here. The only requirement this ADR places on it is that it must never contend for the same slot.

## Decision

### 1. One fact on the wire, carrying the engine's own words

`session:auth-required` gains `message?: string`. Every engine puts its verbatim text **on the event** and **stops sending the companion `session:error`**. The vendor's words are preserved — they were the reason for the duplicate — but they now arrive as part of the one fact rather than as a second, separately-dismissable card. `events.ts`'s doc comment is corrected to match.

Every engine also emits the engine-neutral transcript block Claude already emits (`api_error` with `errorType: 'authentication'`). That gives each failure a correctly-anchored place in the transcript on **every** engine, instead of Claude having history and the other three having a floating card that vanishes.

**Known limitation, accepted for now — and this paragraph was wrong when first written.** It claimed `session-history.ts` reconstructs the block from cli.js's JSONL "so a reloaded Claude session still shows the row". It does not. That path writes `errorType: (obj.error as string) || 'unknown'` — cli.js's RAW wire code, `authentication_failed` — and never calls `classifyApiError`, while `MessageBubble` switches on `errorType === 'authentication'`. So a reloaded Claude auth error falls through to the generic `ApiErrorBlock`: the fact survives, the auth row does not. On Codex, opencode and pi the block is not reconstructed at all. The honest statement is therefore that the row is permanent on **no** engine — it lives for the rest of the live session and no longer. Correcting it needs the history path to classify (a one-line change that alters rendering for every reloaded Claude transcript, so it is a decision, not a tidy-up), and the other three loaders to persist a ClaudeUI-authored block their native formats have no slot for. Carrying it would need each loader to persist a ClaudeUI-authored block its native format has no slot for — plausibly a sidecar — which is a larger change than this ADR, and one whose cost falls on three unrelated history paths. It is recorded here rather than left to be discovered as a contradiction of the paragraph above. The pill is unaffected: it derives from `authRequired`, which is snapshot-carried and survives a resync on every engine.

`CODEX_SIGN_IN_REQUIRED_ERROR` stops being an `errors[]` string with a bespoke button match in `FloatingError` and is routed through the same auth fact.

### 2. One resolution signal

A new replicated channel, `provider:auth-resolved { providerId }`, is emitted by the host whenever a credential for that provider is successfully stored — Anthropic's own success transition and the vault's account upsert. It carries no token, no URL and no flow state, so unlike `auth:state` (host-local for the CSRF reason recorded in `channels.ts:447`) it is safe to fan out, and it must: a desktop sign-in has to clear the owed sign-in on the phone too.

`authRequired` grows to `{ providerId, accountId?, message?, retryPrompt?, resolved? }` and gets **three lifetimes** instead of one:

1. **broken** — set by `session:auth-required`, `resolved` false;
2. **resolved, retry owed** — `provider:auth-resolved` for a matching `providerId` sets `resolved: true` and keeps `retryPrompt`;
3. **settled** — the existing `status.state === 'running'` rule (`reducer.ts:862`) nulls it, as does performing the retry.

The reducer stays the only writer, so the answer survives a resync and is the same on every client.

### 3. The retry belongs to the session

`retryPrompt` is captured by the reducer at failure time from the session's own last user message. Every entry point can then offer the retry, and it survives closing the dialog — which is what makes deleting the dialog's footer safe.

### 4. Direction B: one pill, one row, no cards over the chat

**The pill.** One indicator for every provider and every session, in `TopBar`'s **left** flex group immediately after `TopBar.info`. Left, not right, for four reasons: the right cluster is already five icons plus branch plus dirty-state plus window controls and still growing; the pill is a property of _this session's_ engine, which is what the title names, whereas on the right it reads as another tool button; left-of-centre is in the reading path from the transcript row; and it exists only while something is wrong. That last reason was originally offered as grounds for letting the pill take whatever room it needed, and the real-app drive proved it wrong: as `shrink-0` in a `min-w-0` group with a fixed ~668px right cluster, the pill squeezed the session title to **zero** width and painted 10–25px over the VS Code button, making that slice of itself unclickable. Transient is not the same as free. The title now holds a hard reservation and the pill takes only the remainder, dropping to its compact dot-with-count form — by container query, so the trigger is available width rather than a window breakpoint, which matters because the sidebar moves it by ~276px at a constant window size. The engine and model are **not** added to the bar — they stay in the composer.

States: amber "Sign-in needed" (will fail), red "Sign-in expired" / "N sign-ins needed" (has failed), accent "Signing in…" (a flow is alive with the dialog closed — the fact today's banner had to stay visible for), green transient "Signed in · Retry" (sticks while a retry is owed), and **nothing** when healthy or unprobed. An unprobed host is not a signed-out one, so a cold boot shows no pill.

Collapsed sidebar: the pill follows the title after the two icons. Mobile: a bare dot with a count.

**The row.** `AuthErrorBlock` becomes an engine-neutral `AuthTranscriptRow` with exactly two hit areas and no whole-row target: **Sign in** (the same `openSignIn()` call the pill makes — one code path, so the two cannot drift) and **▾ what the engine said** (pure in-place disclosure of the event's `message`; this is where the deleted second card's text goes). The sentence itself is inert, selectable text: a whole-row target beside two real actions is how a user gets an accidental dialog while trying to copy an error, and this row is permanent history. The row renders the three lifetimes of §2 — and in the settled state it has **no action at all**, which is the specific bug that made a fixed credential keep offering a sign-in.

The lifetime is matched **per session, not per block**: `authRequired` names a provider, not the message that failed, so a session holding two auth-error blocks from two failures over its life renders both at the session's current lifetime. The residue is a rare cosmetic duplication of an action that is _correct_ — the credential really is refused, and both rows offer the same working sign-in — which is materially different from the defect this replaces, where a settled row offered a live sign-in for a credential that was fine. Matching per block would mean carrying the failing message's id on `session:auth-required`; that is a wire change for a cosmetic gain and is deliberately not taken.

**Deleted:** `AuthBanner`, `AuthRequiredRow`, `InputBox.signInHint`, and `FloatingError`'s `CODEX_SIGN_IN_REQUIRED_ERROR` special case. `FloatingError` and `SandboxViolationToast` keep their slot, now inside one ordered stack container so they cannot paint over each other.

**Kept:** the model picker's and mobile sheet's dimmed groups with their inline Sign in, and the Settings provider rows. These answer "why can I not pick this?" at the point of picking; they are not notifications and deleting them would re-introduce the dead-affordance ADR-030 forbids.

### 5. The dialog: presentation trimmed, drivers untouched

`signIn`, `authorizeVendorOAuth`, `authorizeVendorDeviceCode`, the paste submit and `classifyOAuthError` are not touched. Six rules applied to the copy:

1. **Header blurb → chips.** Which engines a credential feeds is a _set_, so render a set (`Codex` `pi` `opencode` beside the title) rather than a sentence nobody re-reads on the fourth sign-in.
2. **No sentence that restates its own button.** "Signs in to another ChatGPT account and adds it to the list", beside a button named _Add another account_.
3. **No sentence that restates its own state.** A spinner labelled "Waiting for the browser…" does not also need "Finish the sign-in in the browser window we opened. It completes on its own."
4. **Step captions → one verb per row.** `OPEN ‹link›` / `ENTER ‹code›`; the link and the code are the instruction.
5. **Parallel sentences → one row of chips.** The fan-out's three sentences differ in exactly one dimension — when the change takes effect — so: `✓ pi`, `⟳ opencode next start`, `⟳ Codex next request`. 26 words to 4.
6. **One primary action per screen.** The footer `Close`/`Done` is deleted everywhere; `×` closes. That frees the primary slot for **Retry**, which moves into the body and names the prompt.

   Scope, clarified after the drive: this governs the **single-provider stages**. Provider-list mode renders one primary per actionable row, which is what a list of N independent actions is — forcing one primary there would mean picking a provider on the user's behalf.

**Deliberately kept:** "That page fails to load — expected. Copy its address." (29 words to 9, moved under the field). It is the only genuinely surprising step in any flow, and without it the user reads a broken app and abandons. Also kept: the device-code ⇄ paste-back escape hatch (ADR-030 — a server with device code off must still have a path), the code expiry, and the engine's verbatim error text, never paraphrased.

Net: worst path 111 words → 19. No stage loses an affordance.

The dialog also gains a **provider-list mode** for the pill's entry point, since the pill aggregates and may have several providers to offer.

### 6. The remote Claude sign-in must report its own success

Found while this arc was in flight, from the owner's report (2026-09-19) that a web sign-in to Claude by pasted code appeared to fail and needed an RDP session to recover. The login had **succeeded host-side**; the remote client was never told.

`claude_oauth_callback` and `claude_oauth_wait_for_completion` are one branch in cli.js and both attach a continuation to the same `Ls.flow` promise. `AuthManager.signIn` arms the loopback wait on the remote path too, calling it "harmless" — it is not. The wait's continuation is registered first, so when the pasted code completes the exchange the wait's response lands first, `finalize` marks the flow settled, and `submitOAuthCode`'s own `finalize` returns `IDLE`. Since `auth:state` is host-local by design (the CSRF reason in `channels.ts`) and no auth-state query exists for a client to poll, that invoke return is the remote client's only outcome channel — so the UI reports neither success nor failure, and the old banner went on claiming nobody was signed in. The same race in the other order (the flow rejecting before the paste) nulls `pendingState` and refuses the paste with "No active login flow."

Two changes: the host loopback wait is **not armed** for a remote sign-in — a remote browser redirects to `localhost` on the _user's_ device, so it can never be hit from there and arming it only creates the race — and `finalize` becomes idempotent **with its result**, returning the cached terminal state when the same flow settles twice rather than erasing it. The second is the general fix: returning `IDLE` on a double-settle is what swallowed the outcome, and removing today's route to it does not remove the class. A settle belonging to a _different_, restarted flow still returns `IDLE`, which is the correct answer for a login the user abandoned.

**And the swallow was not remote-only**, which only surfaced once the fix had a guard to fail against. The desktop's manual fallback — open the link by hand, then paste — races the armed wait identically, and the renderer assigns `submitOAuthCode`'s return straight onto `authState` (`session-store.ts`): the wait's `finalize` broadcast `success`, the store rendered it, then the paste's `IDLE` overwrote it, dropping the dialog out of its own success state. `auth:state` masked the symptom on the desktop instead of preventing the defect. So the idempotent `finalize` is the load-bearing half of this slice rather than the belt-and-braces one: unarming alone would have fixed the host with the visible bug and left the other's latent.

This corrects an assumption of [ADR-057](adr-057_remote-vendor-oauth-paste-back.md), amended there too. `provider:auth-resolved` from §2 does now reach remote clients, but it does not substitute for the invoke return: it says a credential was stored, not which account or that _this_ flow is the one that succeeded.

## Consequences

- ADR-068 §4 is satisfied for the first time: one event, one card. Its `events.ts` comment sanctioning the companion `session:error` is corrected, and a guard test pins the absence of the duplicate so it cannot come back.
- `PerSessionSnapshot.authRequired` and `CanonicalSessionState.authRequired` widen to the five-field shape. `authRequired` stays sealed; `provider:auth-resolved` is folded by the reducer like any other replicated event, so no client computes the resolution.
- A new replicated channel needs a `channels.ts` classification entry and its `why`, plus a row in `docs/architecture/sync-channels.md` (its prose twin — `sync-funnel-guard.test.ts` fails without one). It is **`canonical: true`**. This ADR first said `false`, reasoning that the resolution needs no snapshot field of its own — true, but not what the flag means: `ChannelSpec.canonical` asks _"does `applyEvent` change canonical state?"_, and both `reducer.ts:429` and `replica.ts:138` gate the fold on it, so `false` would have made the new reducer case dead code on host and client alike. The two readings are recorded side by side in the channel's own comment.
- Three chat components are deleted. Their testids (`AuthBanner`, `AuthRequiredRow`, `InputBox.signInHint`) are pinned as **absent** by the entry-point test, the same way ADR-068 §3 pinned `VendorAuthRequiredCard`, so they cannot return through another component.
- Claude is the daily driver and the live login path; an auth-detection regression is a lockout. Every slice is verified against the real Electron app **and** a web client before it is committed, per ADR-026.
- Remote-access authentication is untouched and stays in Settings › Remote.
- No commit or push is authorized by this ADR; ADR-026's loop applies to every slice.

### Residuals the real-app drive found

Verified by a separate agent driving the real Electron app and a hermetic web client (screenshots
reviewed), then confirmed in the code. None is introduced by this arc; all three were made visible
by it. **Two were ruled on by the owner (2026-09-19) and closed by slice F; the third stands.**

- **The top bar cannot fit itself. — FIXED, slice F.** `TopBar.rightGroup` had no `min-w-0` and no
  shrinkable child, so it never yielded a pixel: with `minWidth: 600` and a 280px sidebar the bar can
  be ~320px while the right cluster wants 852px (measured worst case, uiFontScale 1, win32). The pill
  was merely the first child to make that visible, and §4's fix contained the pill rather than making
  the bar fit. Owner ruling: collapse in **tiers**, by container query on the bar, with the phone as a
  case of the width rule rather than a device branch beside it —
  1. `WorktreePill`, `GitBranchPill` (−344px, below 1000px of bar content);
  2. VS Code, Terminal, Skills, MCP, Permissions → the ⋯ menu (−206.6px net, below 768px);
  3. never: `GitChangesPill`, `WindowControls`.

  The thresholds are the measured cost of each tier plus a 96px floor for the title and the pill's
  34px reservation (948.4 and 604.4), rounded up; tier 2's is raised to `MOBILE_BREAKPOINT` (768) so
  that every phone viewport is inside the collapsed tier by construction. `src/layout/` sweeps the
  real bar in Chromium and pins all of it. What remains bounded rather than solved: the three "never"
  children still want 302px of content in the worst case (~275px typically), so at `minWidth: 600`
  with a 280px sidebar the bar is ~8px short — an owner decision about that row, not a leak.

- **A one-click sign-in can open a browser with no intervening screen. — FIXED, slice F.**
  `SignInDialog`'s open-time effect auto-started the flow whenever the account read reported
  `autoStart`, which for Anthropic is _whenever multi-account is off_ (that read was
  `readAccounts`; slice I replaced it with a pure mapping over the store's own accounts). So opening it on Anthropic
  called `signIn()` → `shell.openExternal` with nothing in between. ADR-068 §3's reasoning was right
  about the CONTENT — with one credential there is nothing to choose between — but the screen it
  removed was also the confirmation, and the pill that replaced the dismissible banner is permanently
  on screen. Owner ruling: a **confirm stage**, showing the provider, the account the flow will use
  when one is known, and a single primary naming what happens — `Open browser` on the desktop, and on
  web the thing that actually arrives (`Get a sign-in link` / `Get a code`), because ADR-057's host
  never `openExternal`s for a remote caller. It covers every auto-start path, `mode: 'add'` included:
  the entry-point button says what the dialog is _for_, not that a browser is about to take the
  screen, and a rule with an exception is a rule that rots. The chooser is unchanged — when there IS
  something to choose between, the account list already is the confirmation.
- **Notice legibility. — stands.** The stacked cards sit over transcript text and read poorly, and the
  band is still shared with `TodoWidget` (`top-14 z-10` against the stack's `top-12 z-20`). §4's claim
  is only that the three _notices_ no longer overlap each other, which holds and was measured; this is
  a separate pre-existing issue.

## Phases

1. **Slice A — one fact on the wire.** §1 + §2 + §3: the event's `message`, the four emitters de-duplicated, the neutral transcript block, `provider:auth-resolved`, the widened `authRequired` and its three lifetimes, snapshot and state carriers, guard tests.
2. **Slice B — the pill and the row.** §4: the `authIssues` selector, `AuthPill` and its variants, `AuthTranscriptRow`, the three deletions, the ordered stack container, retry from both surfaces.
3. **Slice C — the dialog.** §5: the copy cuts, the retry relocation, the provider-list mode.
4. **Slice D — the remote Claude sign-in.** §6.
5. **Slice E — the pill must not eat the title.** §4's containment, plus the `src/layout/` measuring
   harness the geometry claims are pinned by.
6. **Slice F — the two owner rulings above.** The confirm stage, and the bar that collapses in tiers.
7. **Slice G — the pasted code is `code#state`.** The owner's own re-auth attempt, not a test, found
   it: claude.ai joins the authorization code and the CSRF state with a `#`, cli.js splits that in
   both of its own manual entries but NOT on the control path we drive, and we posted the whole blob
   as the code — a 400 on every remote Claude sign-in. Also: an error on a live flow now carries
   `manualUrl` forward, because losing it left the panel claiming the host returned no sign-in link.
8. **Slice H — the confirm screen needs a subject.** With no account to name it rendered an
   invisible dot and a floating button. Both modes are now one shape, and the step sentence and the
   button label are one branch so a web client cannot be promised a browser the host will not open.
9. **Slice I — the dialog's second copy of the accounts.** A freshly added account read `Account N`
   until the dialog was reopened: `SignInDialog` snapshotted the account list into local state once
   per open, while the store's copy was already being refreshed. The mapping is now a pure function
   over the store's own fields, so there is one copy. `account:changed` is **host-local**, so the
   remote dialog had the same staleness by another route; `provider:auth-resolved` closes it, on the
   edge §6's ordering already guarantees is late enough.

### What the slices after the drive have in common

E, F, H and I are all one shape: **a fact with more than one copy, or an assumption that only held
where it was written.** The duplicate `session:error` (§1), two divergent last-user-prompt walks
(§3), three names for one state (§4), a pill that assumed room, a confirm that assumed an account,
an overflow menu that assumed nothing to its right, and a dialog holding its own account list. Only
the first of those was found by reading code; the rest needed the app, and two needed the owner.
That is the honest cost record of this ADR, and the reason its verification section is written the
way it is.

## Alternatives considered

- **Direction A — one card in one slot.** Keep today's `NoticeCard` geometry with a single engine-neutral owner. Cheapest, and impossible to miss because it is where the failure happened. Rejected: it is still a dismissible card covering the transcript, it recurs once per open session for one broken provider, and "Later" can still hide a real blocker.
- **Direction C — an Accounts hub in the sidebar.** A permanent address for "who am I signed in as", covering non-drivable credentials (API keys, engine-native stores) that today only whisper from Settings, with the composer's send gated and the reason stated. The best long-term answer and rejected only for now: it duplicates Settings › Models & providers unless one is demoted to a link, it is the most work of the three, and send-blocking on a stale probe would block a working engine. Worth revisiting; the pill is compatible with it.
- **Merge remote-access auth into the same surface.** Rejected — see Context; different axis, different audience, different recovery.
- **Keep the companion `session:error` and teach `FloatingError` to suppress it.** Rejected: a renderer-side suppression rule matching engine-authored strings is exactly the fragile coupling `CODEX_SIGN_IN_REQUIRED_ERROR`'s exact-string match already demonstrates. Fix it at the emitter.
- **Clear `authRequired` on `closeSignIn`.** Rejected: closing the dialog is not evidence of anything — the user may have cancelled — and it is a renderer event, so it would not reach the phone.
