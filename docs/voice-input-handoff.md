# Voice input rework — handoff

Branch `voice-mic-investigation`, worktree `.claude/worktrees/voice-mic` (base `6aa3fa43`).
Kept current after every slice. Read this first in a new session.

## Why

Daniel (2026-10-06): the desktop sometimes records from the MacBook mic instead of a connected
Bluetooth mic; remote/browser voice "doesn't register at all" (notably on a phone under Android Auto).

## Verified facts (investigation 2026-10-06)

- **Desktop capture today** = Claude Code's vendored `audio-capture.node` (Rust, cpal 0.15.3). No
  device API (exports: start/stop/isRecording, playback, `microphoneAuthorizationStatus`). Probed
  with a CoreAudio aggregate device: it binds the macOS **default input at each `startRecording`**,
  does **not** follow a default change mid-stream, and a stop+start picks up the new default.
  cli.js's own `/voice` is the same (no device setting; `rec` fallback has no device arg).
- **Lid closed** (clamshell): built-in mic stays the default input and records digital zeros
  (−91 dB). Today we say nothing; cli.js says "No audio detected from microphone…" after the press.
- **Browser DSP chain is correct**: Electron/Chromium fake-mic (speech WAV) → `BrowserVoiceCapture`
  → worklet → `pcm16.ts` → cli.js voice server → exact transcript.
- **AudioWorklet works from `file://`** under the renderer's CSP (`script-src 'self'`), and
  `enumerateDevices()` lists inputs — so desktop capture can move into the renderer.
- **Silence through the voice server** → no transcript, no error, just `closed`.
- **Cold start**: cli.js spawn ~4.6 s + Deepgram `ready` ~1.1 s. A release before `ready` is
  DISCARDED silently (`VoiceStreamClient.stopRecording` → `cleanup()` when `!streamReady`;
  `ClaudeSession.voiceStopRecording` / `RemoteVoiceRegistry.stop` cancel a pending start).
- Other defects: web start errors only reach `logRelay` (console); no `AudioContext.resume()`; no
  track `ended`/`mute` handling; an `error` frame before `ready` leaves the UI in `connecting`;
  `ClaudeSession.voiceServerPort` is not cleared when cli.js exits (only in `voiceStopServer` and
  teardown), so a respawned engine is handed a dead port; worklet drops its last partial (<150 ms)
  batch on stop; `textarea.focus()` after dictation pops the phone keyboard.
- **Engines**: pi and opencode have no STT. Codex has realtime voice over app-server
  (`thread/realtime/*`, experimental) but it is a conversational model, the websocket/appendAudio
  path needs an OpenAI API key (ChatGPT login only works via WebRTC), audio is 24 kHz PCM16.

## Decisions (Daniel, 2026-10-06)

1. Move desktop capture into the renderer (Web Audio), sharing one implementation with the web
   client. Stop loading Claude Code's native module.
2. Device policy: BOTH — follow the system default (hot-swap when it changes mid-capture) AND an
   optional preferred device used whenever it is connected (fallback to default when absent).
3. **No** shared Claude transcription host for non-Claude engines — using cli.js's voice pipeline
   for anything other than Claude Code sessions is likely a ToS violation. Voice stays bound to
   Claude sessions; other-engine STT is an open question (see below).
4. No integration tests against the real voice API, in CI or otherwise. Do not probe the voice API
   to test. Unit/component tests with fakes only.

Per-client preferences (mic device, hold/tap mode) live in renderer `localStorage`, not the synced
UISettings — a phone and the Mac have different microphones.

## Slices

| #             | Slice                                                                                                                                                                             | Status                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| S1            | Renderer-owned capture for desktop + web (behavior-preserving move)                                                                                                               | committed a814b15b (gates green; real-app boot + worklet asset + mic button verified) |
| S2 (4949d471) | Lifecycle robustness: never drop a short press, ready timeout, error-before-ready, stale port, outcome messages, visible errors, `resume()`, track ended/mute, worklet tail flush | todo                                                                                  |
| S3            | (S3a d11bc206, S3b committed) Device selection: system default + preferred device, `devicechange` hot-swap, level meter, live digital-silence warning, Settings UI                | todo                                                                                  |
| S4            | Phone/car: tap-to-talk mode with silence auto-stop, touch hardening, no keyboard pop, capture diagnostics (track label/settings/level stats → logRelay, never audio)              | todo                                                                                  |
| —             | Other-engine STT (Codex realtime w/ API key, BYO-key provider, on-device)                                                                                                         | open — needs Daniel                                                                   |

## S1 outcome (review 2026-10-06)

- Main side is `core/services/voice-relay.ts` (`VoiceRelayRegistry`, owners = remote connection or
  `desktop:<webContents.id>`); desktop audio feed is `main/ipc/voice-feed.ts` (`voice:audio`).
- Desktop owner keeps the old immediate `connecting` / cancel→`idle` (`announcesPendingStart`);
  remote does not — unify in S2.
- Review fix: `voice:stop-recording` always releases the window's capture (no session gate).
- app-shot never finishes quitting (90 s watchdog) — PRE-EXISTING, reproduced on a HEAD build.
- Build gate: use `bunx electron-vite build` in this worktree — `bun run build` runs ensure-cli,
  which writes the symlinked `vendor/claude-cli` in the main checkout. Full `bun run build` after merge.

Carried into S2: desktop mic failures are now console-only until S2's visible errors (regression vs
the old native-path toast); release the desktop owner on renderer reload / `render-process-gone`;
macOS TCC for Chromium getUserMedia needs a real-device check (signed build). Separate decision:
stop packaging `audio-capture.node` (electron-builder.yml, extract-cli.mjs, packaging.test.ts,
docs/protocol-cc/01-transport.md, ADR-061/082). `BaseSession.win` is now unused by every engine.
After merge: update `patch/voice-server/README.md` (data-flow diagram says Electron main captures).

## S1 kickoff spec — renderer-owned capture

### Goal

One capture implementation (`BrowserVoiceCapture` + the AudioWorklet) runs in the renderer for BOTH
the desktop window and the remote web client. The main process only ever receives pushed PCM and
relays it to the cli.js voice server. Behaviour otherwise unchanged (S2 fixes the lifecycle bugs —
do NOT fix them here, except where the move makes the old code disappear).

### Seam map

Renderer (shared by desktop and web — `src/web/main.tsx` renders the same renderer app):

- Move `src/web/voice-capture.ts` → `src/renderer/src/lib/voice/browser-voice-capture.ts` (create
  the dir if needed; follow the renderer's existing lib/folder conventions — check first).
- Move `src/web/public/voice-worklet.js` next to it and load it through a Vite `?url` import so both
  builds (electron-vite renderer, `vite.web.config.ts`) emit it as a hashed asset under `/assets/`
  (`remote-server.ts` `serveStatic` already serves `/assets/*`; renderer CSP is `script-src 'self'`,
  satisfied by a same-origin asset in both `file://` and the remote origin). Delete the old
  `VOICE_WORKLET_URL = '/voice-worklet.js'` path and the public copy. Confirm `bun run build` and
  `bun run build:web` emit it and that nothing else references `/voice-worklet.js`.
- New `src/renderer/src/lib/voice/voice-controller.ts`: owns ONE `BrowserVoiceCapture`; exposes
  `start(routingId, language)` / `stop(routingId)` / `isActive()`. Body = today's web logic in
  `api-adapter.ts` `voiceStartRecording`/`voiceStopRecording` (start capture first, then the
  transport start, then `arm()`; on transport failure stop the capture and rethrow; idempotent while
  active), parameterized over a small transport interface:
  `{ start(routingId, language): Promise<void>; audio(routingId, dataB64): void; stop(routingId): Promise<void> }`.
- `InputBox.tsx` calls the controller instead of `window.api.voiceStartRecording/StopRecording`.
  Keep the existing held/press refs and the `ensureSession()` ordering exactly.

Transport API (`src/shared/types.ts` `VoiceAPI`), replacing `voiceStartServer`, `voiceStopServer`,
`voiceStartRecording`, `voiceStopRecording` (the server pair has no renderer caller):

- `voiceStart(routingId, language): Promise<void>`
- `voiceAudio(routingId, dataB64): void` (fire-and-forget)
- `voiceStop(routingId): Promise<void>`
- `onVoiceTranscript`, `onVoiceState` unchanged.

Web (`src/web/api-adapter.ts`): `voiceStart` → `connection.invoke('voice:start', routingId, language)`;
`voiceAudio` → `connection.sendVoiceAudio(dataB64)`; `voiceStop` → `connection.invoke('voice:stop')`.
The capture object moves OUT of the adapter into the controller.

Desktop preload (`src/preload/index.ts`): `voiceStart` → invoke `voice:start-recording`;
`voiceStop` → invoke `voice:stop-recording`; `voiceAudio` → `ipcRenderer.send('voice:audio', routingId, dataB64)`.
Remove `voice:start-server` / `voice:stop-server` IPC.

Main — one push-fed registry for both transports:

- Generalize `RemoteVoiceRegistry` (`src/core/services/remote-voice.ts`) so the CAPTURE OWNER is an
  opaque key plus a delivery strategy, not necessarily a WS connection. Remote owner = WS
  `connectionId`, delivery = targeted `stream-ev` frames (unchanged). Desktop owner =
  `desktop:<webContents.id>`, delivery = what `VoiceClient` does today: `voice:state` /
  `voice:transcript` to that window's webContents (guard destroyed), `voice:error` through
  `emitEvent` (see the long comment on `VoiceClient.emitError` + `shared/sync/channels.ts` NOTE —
  keep that classification and update the comments to describe the new emitter). Rename the file /
  class only if it clearly reads better (e.g. `voice-relay.ts` / `VoiceRelayRegistry`); if you
  rename, update every import and doc reference. Keep the frame-size bound, the generation-based
  pending-start cancellation, `releaseConnection` on owner death, and "audio is never logged".
- `session.ipc.ts`: `voice:start-recording` / `voice:stop-recording` handlers call the registry with
  the desktop owner key derived from the IPC sender; add an `ipcMain.on('voice:audio', …)` feed
  (validate it is a string; the registry already bounds size). Release the desktop owner's capture
  when its window/webContents is destroyed. Keep `voiceRefusal` gating exactly as today.
- `ClaudeSession`: delete `voiceStartRecording`, `voiceStopRecording`, `voiceClient`, the early
  buffer, `voiceStartGen`/`voicePendingStart`, and the `voice-capture` import. Keep
  `voiceStartServer` / `voiceStopServer` (the registry uses them). `ISession`: drop the two
  recording methods.
- Delete `src/core/services/voice-capture.ts`, `src/core/services/voice-client.ts` and their tests
  (`src/main/services/__tests__/voice-capture.test.ts`, `voice-client.test.ts`); port any test in
  `claude-session-voice.test.ts` that still applies to the registry; remove the now-dead
  `vi.mock('.../voice-capture')` lines in the other claude-session tests.
- Windowless boot: desktop voice simply has no renderer — make sure nothing still references the
  removed "needs the desktop window" path (`src/e2e/flows/windowless-boot.e2e.test.ts`).

Docs (NOT `patch/` — another agent has uncommitted voice-server patch work in the main checkout; that README is updated after merge): update
diagram (Electron Main no longer captures; the renderer does), `docs/architecture/*` mentions of the
native module for voice (grep `audio-capture`, `VoiceClient`, `voice-capture`), and the header
comments of the moved files (they describe the old desktop/native split).

### Out of scope (later slices)

Device selection / `devicechange`, level meter, silence detection, `resume()`, early-release drain,
ready timeout, error-before-ready, stale port, tap mode, touch CSS, keyboard focus, diagnostics.
Don't add settings. Don't touch the cli.js patch itself.

### Tests

- Port `src/web/__tests__/voice-capture.unit.test.ts` with the file move.
- Controller unit tests with a fake transport + fake capture env: start order (capture → transport
  start → arm), transport failure stops capture and rethrows, idempotent start while active, stop
  order (capture stop → transport stop).
- Registry tests: desktop owner delivery (state/transcript to the owning webContents only; destroyed
  webContents tolerated; error via `emitEvent`), owner release on window destroy, both owner kinds
  coexisting without crosstalk. Keep every existing remote-voice test green.
- `remote-voice.e2e.test.ts` must stay green (rename paths if the module moves).
- InputBox component tests: update mocks to the controller/transport; keep release-during-spawn
  coverage.

### Gates

`bun run typecheck && bun run lint && bun run test` (report exact output; known flaky:
`vscode-web-service probeCli` on darwin and `remote-*.test.ts` ~1-in-4 under parallel load — rerun
those in isolation before calling them pre-existing). Also `bun run build` and `bun run build:web`
and confirm the worklet asset is in both outputs.

### Constraints

Work only in `/Users/daniel.liu/work/ClaudeUI/.claude/worktrees/voice-mic`. Never commit, `git add`,
branch, stash, or run `bun install`/`add`/`remove`. `vendor/` and `node_modules` are symlinks —
never stage or modify them. Never run anything that opens a real microphone or talks to the real
voice API. Report: files changed, deviations from this spec and why, exact gate output.

### Suggested commit message

```
refactor(voice): capture in the renderer for desktop and web

Desktop voice no longer loads Claude Code's native audio-capture module.
Both the desktop window and the remote web client now capture with the
same Web Audio implementation (BrowserVoiceCapture + AudioWorklet) and
push 16 kHz PCM to the main process, which relays it to the cli.js voice
server through one push-fed registry keyed by capture owner.

This is the groundwork for microphone selection: the native module binds
the macOS default input at start and exposes no device API.
```

## S2 kickoff spec — lifecycle robustness

Base: `a814b15b` (S1). Same standing constraints as S1 (worktree only; no commit/add/branch/stash/
`bun install`; never open a real mic or contact the voice API; build with `bunx electron-vite build`,
not `bun run build`; don't touch `patch/`).

### Goal

No press is ever silently lost, and every failure the user can act on is VISIBLE on both the desktop
window and the web client. All items below get a guard test that fails against `a814b15b`.

### Items

1. **Never drop a short press (drain).**
   - Renderer: `voice-controller.ts` serializes stop after an in-flight start. `stop()` HALTS the
     microphone immediately (tracks stopped, graph torn down) but KEEPS the pre-arm queue; if a start
     is in flight it awaits it (ignoring its failure), the start's `arm()` then flushes the queue,
     and only then does it call `transport.stop`. A start that failed discards the queue. Split
     `BrowserVoiceCapture.stop()` accordingly (e.g. `halt()` keeps queued blocks; `stop()` = halt +
     discard), keep it idempotent, and keep the existing permission-race bail semantics.
     A release during `ensureSession()` in `InputBox` (mic not yet opened) still cancels, as today.
   - Main: `VoiceStreamClient.stopRecording()` while connected but not yet `ready` must NOT
     `cleanup()` away the buffer. Mark the stop requested, stop the source, keep buffering what is
     already queued, and on `ready` flush the buffer, send `voice_stop`, enter `processing` and arm
     the finalize timer exactly as the post-`ready` path does. A second stop while draining is a
     no-op. If there is no connection yet (connect in flight), the existing generation logic applies
     but the connect, once it lands, must proceed into the same drain rather than being dropped —
     unless `cleanup()`/`destroy()` ran (owner death), which still discards.
   - Ordering note to preserve: on both transports the audio frames and the stop verb travel on one
     ordered channel (`ipcRenderer.send` + `invoke` on one webContents; frames + invoke on one WS),
     so flushed frames reach the relay before the stop. Don't introduce a path that reorders them.
2. **`ready` timeout.** After the voice socket connects, if `ready` hasn't arrived within 10 s, emit
   an error ("Voice transcription didn't start. Try again.") and clean up. Cleared by `ready`/cleanup.
3. **Error before `ready` is terminal.** A server `error` frame while `!streamReady` → emit the
   error and clean up (today the UI stays in `connecting`). After `ready`, keep today's behaviour.
4. **Stale voice-server port.** `ClaudeSession.voiceServerPort` must be cleared when the cli.js child
   exits (the block around `this.activeQuery = null`, claude-session.ts ~1175), so the next start
   asks the respawned engine for a fresh port.
5. **Outcome messages** (mirroring cli.js's own `/voice`, whose strings are below), computed in
   `VoiceStreamClient` from the PCM it relays (both owners pass through `pushAudio`) — never logged:
   - per chunk, level = `sqrt(min(rms / 2000, 1))` over i16LE samples; `hadSignal` once level > 0.01;
   - on a capture that ended normally (stop → `closed`) with NO non-empty transcript and a capture
     duration ≥ 2 s: if `!hadSignal` → "No audio detected from microphone. Check the selected input
     device and microphone access."; else → "No speech detected."
   - Delivered through `emitError` (same surface as other voice errors). Not emitted after
     owner death, a ready timeout, or an error (those already said something).
6. **Visible start/stop failures.** `InputBox` currently only `logRelay`s a failed start. Surface the
   message through the same store path `voice:error` uses (`useSessionStore.getState().addError(routingId, msg)`),
   keeping the `logRelay` line. Applies to desktop and web (this also fixes the S1 regression where
   a denied desktop mic is console-only). Keep `describeCaptureFailure`'s wording.
7. **Owner-wide `connecting`.** Remove `announcesPendingStart`; every owner is told `connecting` when
   its start is accepted and `idle` when that pending start is cancelled or fails (a phone gets
   feedback during a cold spawn too). Update the remote tests that pinned the old silence, and the
   e2e flow if it asserts on it.
8. **`AudioContext.resume()`.** After building the context, if `state === 'suspended'`, `await
resume()` (with the same post-await bail checks as the other awaits).
9. **Track faults.** `BrowserVoiceCapture` takes an optional `onFault(message)` option. Track
   `ended` while capturing → fault "The microphone was disconnected." and the controller ends the
   capture through the normal stop path (so what was said still finalizes). Track `mute` while
   capturing → fault "The microphone was muted by the system." (no stop). The controller exposes a
   fault listener; `InputBox` subscribes and routes faults to `addError` for the active session.
10. **Worklet tail.** On halt, ask the worklet to flush its partial batch (a `port` message) and wait
    for it, bounded at ~100 ms, before disconnecting, so the last <150 ms of speech is not dropped.
    Worklet logic stays minimal (it is untestable); the waiting/bounding lives in the capture class.
11. **Desktop owner release on reload/crash.** In `main/ipc/voice-feed.ts`, also release the desktop
    owner's capture on `render-process-gone` and on a main-frame cross-document navigation
    (`did-start-navigation` with `isMainFrame && !isSameDocument`), not only on `destroyed`.

### Out of scope

Device selection, level meter UI, live silence warning (S3); tap mode, touch CSS, keyboard focus,
diagnostics (S4). No new settings.

### Gates

`bun run typecheck && bun run lint && bun run test` (exact tail), `bunx electron-vite build`,
`bun run build:web`. For each item, name the guard test and confirm it fails at `a814b15b`
(e.g. `git stash`-free: copy the test into a scratch checkout is NOT allowed — instead temporarily
revert the one source hunk, run the test, show the failure, restore; report the commands).

### Suggested commit message

```
fix(voice): never lose a short press; make every voice failure visible
```

(+ a body listing the items.)

## Hands-on checks for Daniel (cannot be automated without probing the voice API)

Run on the real Mac, with the dev build of this branch:

1. First press after launch on a cold session, short (~1 s) phrase → transcript appears (S2 drain).
2. Lid closed + Bluetooth headset connected, macOS default input left on the MacBook mic → after S3,
   the preferred-device setting picks the headset; before S3, expect "No audio detected from microphone…".
3. Deny/revoke mic permission (System Settings → Privacy → Microphone) → visible error in the session.
4. Unplug/disconnect the Bluetooth mic mid-press → "The microphone was disconnected." and what was
   said before still transcribes.
5. (S3b) With System default selected, change the macOS default input mid-press (or connect the
   Bluetooth mic) → "Switched to …" pill and the transcript continues. Unplug the default mic mid-press
   → switch or "Microphone disconnected — kept what you said".
6. Settings › Voice input › Test mic with the lid closed → "No signal …"; pick the Bluetooth mic → level moves.
7. Phone (tailnet HTTPS), short press on a cold session → transcript; with Android Auto connected →
   note what happens (S4 adds diagnostics to the log).

## Approved UI (Daniel, 2026-10-07) — binding for S3/S4

Mockups (gitignored store `.claude/ui/mockups/`): `2f6cef47` input-bar states + notice pills,
`9ba790b8` Settings › Voice input (picker, test meter, mode), `1b412724` phone (chat + settings).

- Voice messages NEVER go to the session error stack (`addError`/`FloatingError`) — errors included.
  Every voice message is ONE pill anchored above the mic button: grey = outcome, amber = error or
  something to fix. A newer notice replaces the older.
- Fade rule: while the push-to-talk is HELD (Tab key or mic button), a notice stays. Once it is
  RELEASED, the notice fades out (animated) within 5 s. A notice that arrives after the release
  (e.g. "No speech detected", an error at finalize) shows and fades out 5 s after it appears.
  Tap mode: "released" = the capture ending (tap or auto-stop). Hover holds it.
- Main sends a tone with each voice message (no renderer string-matching — ADR-070).

## S3a kickoff spec — notice pills, level ring, live silence warning

Base: `4949d471` (S2). Standing constraints unchanged (worktree only; no commit/add/branch/stash/
`bun install`; no real mic or voice API; `bunx electron-vite build`; don't touch `patch/`).
UI is BINDING to mockup `2f6cef47` (rows 1–10; open it at `.claude/ui/mockups/2f6cef47/index.html`
in the main checkout — read-only) and the "Approved UI" section above.

1. **Tone on the wire.** `voice:error` gains an optional third arg `tone: 'info' | 'warn'` (absent =
   `'warn'`, so older emitters stay valid). `VoiceStreamClient.emitError(message, tone?)`; outcome
   "No speech detected" is `info`, everything else `warn`. Thread it through `VoiceDelivery.error`,
   both owners, `shared/sync/channels.ts` docs, and the web client's lane-frame path.
2. **Voice notices leave the error stack.** New renderer-local store (e.g.
   `renderer/src/lib/voice/voice-notice.ts`, zustand like the rest): one notice per routing id
   `{ id, text, tone }`; `show()` replaces. `useClaudeEvents`' `voice:error` → notice (not
   `addError`); InputBox start/stop failures and mic faults → notice (`warn`). Nothing voice-related
   calls `addError` any more. Not replicated, not persisted.
3. **Pill component** anchored above the mic button in `InputBox/View.tsx`, matching the mockup
   (dot + text, pointer tail toward the mic, grey/amber tokens from the existing theme, no new
   colours if the theme has equivalents). `data-testid="InputBox.voiceNotice"` with a `data-tone`
   attribute. Fade rule: while push-to-talk is HELD (Tab or mic button; tap mode is S4) the notice
   stays; once released it fades out (CSS opacity transition) and is removed within 5 s of the
   release. A notice that arrives while NOT held is removed 5 s after it appears. Hover holds it;
   leaving restarts the 5 s. Respect `prefers-reduced-motion` (no animation, same timing).
4. **Wording** (mockup): "Microphone disconnected — kept what you said"; "Microphone access denied —
   allow ClaudeUI in System Settings › Privacy › Microphone" on the desktop window, "…— allow it for
   this site" on the web client; "No speech detected"; "No audio from microphone — check the input
   device and microphone access"; "Voice transcription didn't start — try again"; "The microphone
   was muted by the system" stays. Keep the constants exported and tests updated.
5. **Level ring.** `BrowserVoiceCapture` gains `onLevel(level)` per block (same formula as main's
   `pcm16Level`, computed on the int16 samples it already produces — share the function via
   `shared/audio/` rather than duplicating it). Controller exposes a level subscription; the
   recording mic renders a ring whose scale follows the level (rAF-throttled, no React re-render per
   block if avoidable). `data-testid="InputBox.voiceLevel"`.
6. **Live silence warning.** While capturing, ≥ 1.5 s of digital silence (every block level exactly 0) → amber notice "No signal from <track label> — lid closed or muted?" (label from the live
   track; fall back to "the microphone"). It stays while silent and is removed as soon as a block
   has signal. Distinct from main's after-the-fact "No audio" outcome; when the live warning fired,
   suppress main's duplicate outcome for that capture if it is cheap to do so cleanly — otherwise
   let the newer notice replace it (acceptable).

Tests: notice store (replace, per-session), fade rule with fake timers (held vs released, arrival
after release, hover hold/restart), tone threading main→renderer for both owners, level + silence
detection on the capture with fake blocks, InputBox: no `addError` for voice. Guard tests must fail
at `4949d471` where applicable. Gates as before. Report as before.

Suggested commit: `feat(voice): quiet notice pill above the mic, live level ring and silence warning`

## S3b kickoff spec — microphone picker, mid-press switching, test meter

Base: `d11bc206` (S3a). Standing constraints unchanged. UI BINDING to mockup `9ba790b8`
(Settings › Voice input: Microphone row + Test mic; the Recording mode row is S4 — do NOT build it)
and the phone layout in `1b412724` (settings column). Notices use the S3a pill (`showVoiceNotice`).

1. **Per-client preference** (renderer `localStorage`, every access in try/catch, works when storage
   throws): preferred mic `{ deviceId, label } | null` (null = system default). Small module next to
   the capture (e.g. `lib/voice/mic-preference.ts`). Never in synced UISettings.
2. **Resolution** (pure, unit-tested): given `enumerateDevices()` audioinputs + the preference →
   the target: the preferred device if present (match `deviceId`, else exact `label` — deviceIds can
   rotate), otherwise the system default. Ignore Chromium's synthetic `communications` entry.
   `getUserMedia` uses `{ deviceId: { exact } }` for a preferred device; on `OverconstrainedError` /
   `NotFoundError` fall back to the default once.
3. **Mid-press switching.** While capturing, on `navigator.mediaDevices` `devicechange`: re-resolve;
   if the target differs from the live track (compare `deviceId`, and for system default the
   `default` entry's `groupId` vs the track's `getSettings().groupId` — that is how Chromium shows an
   OS default change), open the new stream and swap the `MediaStreamSource` feeding the SAME worklet
   (same context, resampler state kept), then stop the old tracks. No gap in the queue/armed logic,
   no transport restart. Grey notice "Switched to <label>". A live track `ended` (unplug) first tries
   the same swap; only if that fails does S2's fault path ("Microphone disconnected — kept what you
   said" + end capture) run. Debounce `devicechange` (~300 ms; Bluetooth fires bursts).
4. **Settings › Voice input** (`settings-sections.tsx`, existing `SettingRow`/`SelectField`
   patterns, "this device" badge as in the mockup, `data-testid`s per ADR-027):
   - Microphone select: "System default — <current default label>", each input, and a remembered
     preferred device that is absent shown disabled as "<label> · not connected"; under it the amber
     "Not connected now — using <default label>" line when applicable. Labels need permission: if
     labels are empty, show a small "Allow microphone access to list devices" action that opens and
     immediately closes a stream (user-initiated only).
   - Test mic: Start/Stop button, a level bar from the capture's `onLevel`, and the status line —
     "Speak to see the level. Nothing is recorded or sent." / "Hearing you on <label>." / the silence
     warning text from S3a. Runs a LOCAL `BrowserVoiceCapture` whose `sendAudio` is a no-op (never
     the voice controller, never the transport); stops on Stop, on unmount and on window blur.
   - Follows `devicechange` while open (list refresh + default label).
   - Same component on the web client (phone layout per `1b412724`).
5. **Pill tail alignment** (S3a leftover): the tail is ~4 px left of the mic's centre in the real
   app — centre it on the measured mic rect rather than a fixed offset.

Tests: resolution table (preferred present/absent/rotated id/label match, default, communications
ignored); hot-swap with a fake env firing `devicechange` and `ended` (source swapped, worklet kept,
old tracks stopped, queue intact, notice shown, fallback to fault when swap fails); preference
storage incl. throwing storage; settings component with fake `mediaDevices` (list, not-connected
line, permission action, test meter start/stop/unmount, never touches the transport). Guards fail
at `d11bc206`. Gates as before.

Suggested commit: `feat(voice): choose a microphone, follow device changes mid-press, test it in Settings`

S4 carry-over: the Settings microphone dropdown menu overflows the dialog's right edge by ~20 px.

## Decisions recorded (Daniel, 2026-10-07)

- ADR-098 written (capture in the renderer, per-device mic choice, notice pill, voice bound to
  Claude sessions, fakes-only testing). ADR numbers 093–097 are taken on other branches.
- Loose native addons are no longer extracted or shipped (`build:` commit after a1bd280f).
- Other-engine speech-to-text: parked by Daniel — don't pursue for now.
