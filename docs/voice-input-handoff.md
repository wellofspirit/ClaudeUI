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

| # | Slice | Status |
|---|---|---|
| S1 | Renderer-owned capture for desktop + web (behavior-preserving move) | reviewed, gates green; real-app verify pending |
| S2 | Lifecycle robustness: never drop a short press, ready timeout, error-before-ready, stale port, outcome messages, visible errors, `resume()`, track ended/mute, worklet tail flush | todo |
| S3 | Device selection: system default + preferred device, `devicechange` hot-swap, level meter, live digital-silence warning, Settings UI | todo |
| S4 | Phone/car: tap-to-talk mode with silence auto-stop, touch hardening, no keyboard pop, capture diagnostics (track label/settings/level stats → logRelay, never audio) | todo |
| — | Other-engine STT (Codex realtime w/ API key, BYO-key provider, on-device) | open — needs Daniel |

## S1 outcome (review 2026-10-06)

- Main side is `core/services/voice-relay.ts` (`VoiceRelayRegistry`, owners = remote connection or
  `desktop:<webContents.id>`); desktop audio feed is `main/ipc/voice-feed.ts` (`voice:audio`).
- Desktop owner keeps the old immediate `connecting` / cancel→`idle` (`announcesPendingStart`);
  remote does not — unify in S2.
- Review fix: `voice:stop-recording` always releases the window's capture (no session gate).
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
