# ADR-098: Voice capture runs in the renderer; the microphone is chosen per device

**Status:** Accepted (2026-10-07). Built on branch `voice-mic-investigation`: `a814b15b`,
`4949d471`, `d11bc206`, `a1bd280f`, and the packaging change that records this ADR.
**Amends:** [ADR-082](adr-082_harness-sources-downloads-and-unbundling.md) §8 and the
2026-09-30 amendment of [ADR-061](adr-061_ci-build-gates-and-release-artifact-matrix.md) (Claude
Code no longer ships with a loose `audio-capture.node`), [ADR-006](adr-006_rebundle-bun-binary.md)
(the extract step no longer writes loose native addons).
**Relates to:** [ADR-070](adr-070_one-auth-surface.md) (no renderer rule keyed
on an engine-authored string — voice notices carry their tone), [ADR-027](adr-027_test-data-attributes.md)
(the new `data-testid`s), `docs/architecture/sync-core.md` phase 5 S3 (remote voice, which this
generalizes). Resume/working notes: `docs/voice-input-handoff.md` on the branch.

## Context

Daniel reported two failures (2026-10-06): the desktop sometimes recorded from the MacBook's
built-in microphone while a Bluetooth headset was connected, and on the phone (notably under
Android Auto) voice input "didn't register at all".

What the investigation established:

- **Desktop capture used Claude Code's vendored `audio-capture.node`** (Rust, cpal 0.15.3), loaded
  in the Electron main process. It has no device API: it binds the macOS default input at each
  `startRecording`, does not follow a default change mid-stream, and cannot be told to prefer a
  device. Probed with a CoreAudio aggregate device; cli.js's own `/voice` behaves the same.
- **A closed lid** leaves the built-in mic as the default input while it delivers digital zeros, and
  nothing told the user.
- **The browser path's DSP was correct** (Chromium fake mic → AudioWorklet → `pcm16.ts` → the cli.js
  voice server → an exact transcript). Its failures were lifecycle ones: a release before the
  transcription stream was `ready` (a cold cli.js spawn plus the voice socket, ~5–6 s) discarded the
  audio silently; web start errors only reached the console; no `AudioContext.resume()`, no track
  `ended`/`mute` handling, no level check; an `error` frame before `ready` left the button in
  `connecting`; a respawned engine was handed the dead voice-server port.
- **Other engines:** pi and opencode have no speech-to-text; Codex has realtime voice over its
  app-server (`thread/realtime/*`), but it is a conversational model and its audio-append path
  needs an OpenAI API key.

## Decision

1. **Capture runs in the renderer, one implementation for every client.** The desktop window and
   the remote web client both use `renderer/src/lib/voice/` (`BrowserVoiceCapture` + an
   AudioWorklet shipped as a same-origin hashed asset, which satisfies `script-src 'self'` under
   `file://` and on the remote origin) and push 16 kHz i16LE PCM to the main process. The main
   process owns no microphone: `core/services/voice-relay.ts` relays pushed audio to the session's
   cli.js voice server, keyed by **capture owner** — a remote connection, or the desktop window
   (`desktop:<webContents.id>`, audio over the `voice:audio` IPC message). An owner's death
   (socket close, window destroyed, renderer reload or crash) releases its capture.
2. **The microphone is chosen per device.** Settings › Voice input offers _System default_ or a
   chosen microphone, used whenever it is connected (matched by `deviceId`, else by label, since ids
   rotate) and otherwise falling back to the system default. While capturing, `devicechange`
   re-resolves the target; an OS default change or the chosen mic connecting swaps the
   `MediaStreamSource` feeding the same worklet — same context, queue and transport — with a
   "Switched to …" notice. An unplug tries that switch before reporting a disconnect. A Test mic
   meter runs a local capture whose audio goes nowhere.
3. **Per-client preferences live in the renderer's `localStorage`**, never in the synced
   UISettings: a phone and the Mac have different microphones.
4. **A press is never silently lost.** A release before `ready` drains: the renderer halts the
   mic but keeps its queue until the start resolves, and `VoiceStreamClient` keeps its buffer and
   finalizes on `ready`. A 10 s `ready` timeout, an error before `ready`, and a capture that ends
   with no transcript all say so — the outcome wording mirrors cli.js's own ("No audio detected
   from microphone…" for digital silence, "No speech detected").
5. **Voice messages are a notice pill, never the error stack.** Every voice message — failures
   included — is one pill above the mic: grey for an outcome, amber for an error or something to
   fix. A newer one replaces the older; it stays while push-to-talk is held and fades out within
   5 s of release (Daniel, 2026-10-07; mockups `2f6cef47`, `9ba790b8`, `1b412724`). Main sends the
   tone on `voice:error`; the renderer never infers it from the wording (ADR-070). Because the
   desktop's `voice:error` is replicated, a client shows these notices only for sessions it captured
   for itself (until 15 s after its stop). A live "No signal from <mic> — lid closed or muted?"
   warning appears after 1.5 s of digital silence (RMS ≤ 1 LSB) and clears when sound returns.
6. **Voice stays bound to Claude sessions.** cli.js's voice pipeline (Anthropic's transcription
   proxy under the user's Claude login) is used only for Claude Code sessions. It is **not** run as a
   shared transcriber for pi, opencode or Codex sessions: serving another product from it is likely
   outside Claude Code's terms (Daniel, 2026-10-06). Speech-to-text for other engines is deferred;
   any future source must be sanctioned for that use (the user's own API key, an on-device
   recognizer, or an engine's own voice feature inside its own sessions).
7. **No loose native addons are extracted or shipped.** `scripts/extract-cli.mjs` stops writing
   `vendor/claude-cli/vendor/<addon>/…/*.node`, and `electron-builder.yml` stops packaging them
   (the server zips copy `vendor/claude-cli` whole, so they follow). cli.js loads its addons
   (`audio-capture`, `computer-use-*`) from inside the Bun binary, which the rebundle preserves.
8. **Voice is tested with fakes only.** No test — CI or local — drives the real voice API, and it
   is not probed to verify a change (Daniel, 2026-10-06). Behaviour that needs a real press or real
   devices is a hands-on checklist in the handoff doc.

## Consequences

- Device choice, mid-press switching, a level meter and the silence warning become possible on
  every platform Chromium supports, not only macOS, and desktop voice no longer depends on a
  binary addon whose interface Claude Code may change.
- Desktop voice now needs the renderer: a windowless boot has no local microphone (it never had a
  working one — the old path refused there too). Remote clients are unaffected.
- macOS microphone permission is requested by Chromium for the app rather than by the addon; the
  TCC grant is the app's either way, but the first press after this change may prompt once.
- Following an OS default change mid-press relies on Chromium reporting the device's `groupId` on
  the `default` entry and on the live track; where it does not (Firefox, Safari), only an unplug or
  the chosen device connecting moves the capture.
- The opt-in verifier handle exposes the voice notice store, so a real-app drive can show a notice
  without a microphone.
