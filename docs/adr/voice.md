# Voice input

Governs: `src/renderer/src/lib/voice/`, `src/core/voice/`, `src/core/services/voice-relay.ts`, `src/core/services/voice-stream-client.ts`, `src/core/ipc/voice-pack-commands.ts`, `src/shared/voice-pack.ts`, `src/main/voice-worker-launcher.ts`, `scripts/extract-cli.mjs`

Push-to-talk voice input: where audio is captured (the renderer, for the desktop window and the web client alike),
how the microphone is chosen, and the on-device speech-to-text that serves engines with no voice path of their own.
The as-built contracts of the local server are in `docs/architecture/local-voice.md`. The remote voice lane is part of
the volatile stream lane, ADR-055 (sync-core.md). Claude's own voice path is gated on a patch, ADR-079
(claude-engine.md). Why the server artifacts carry no native addon is ADR-058 (core-and-hosts.md).

## Voice capture runs in the renderer; the microphone is chosen per device (ADR-098)

**§1.** Capture runs in the renderer, one implementation for every client. The desktop window and the remote web
client both use `renderer/src/lib/voice/` (`BrowserVoiceCapture` plus an AudioWorklet shipped as a same-origin hashed
asset, which satisfies `script-src 'self'` under `file://` and on the remote origin) and push 16 kHz i16LE PCM to the
main process. The main process owns no microphone: `core/services/voice-relay.ts` relays pushed audio to the
session's voice server, keyed by CAPTURE OWNER, either a remote connection or the desktop window
(`desktop:<webContents.id>`, audio over the `voice:audio` IPC message). An owner's death (socket close, window
destroyed, renderer reload or crash) releases its capture. A windowless boot therefore has no local microphone.
(The earlier path loaded Claude Code's `audio-capture.node` in the main process; it has no device API, binds the OS
default at each start and does not follow a default change.)

**§2.** The microphone is chosen per device. Settings > Voice input offers _System default_ or a chosen microphone,
used whenever connected (matched by `deviceId`, else by label, since ids rotate) and otherwise falling back to the
default. While capturing, `devicechange` re-resolves the target: an OS default change or the chosen mic connecting
swaps the `MediaStreamSource` feeding the same worklet (same context, queue and transport) with a "Switched to ..."
notice, and an unplug tries that switch before reporting a disconnect. A Test mic meter runs a local capture whose
audio goes nowhere. Following an OS default change mid-press relies on Chromium reporting `groupId` on the `default`
entry and the live track; where that is missing (Firefox, Safari) only an unplug or the chosen device connecting
moves the capture.

**§3.** Per-client voice preferences (preferred microphone, live preview on or off) live in the renderer's
`localStorage` (`mic-preference.ts`, `preview-preference.ts`), NEVER in the synced UISettings: a phone and a desktop
have different microphones.

**§4.** A press is never silently lost. A release before the stream is `ready` (a cold engine spawn plus the voice
socket takes several seconds) drains: the renderer halts the mic but keeps its queue until the start resolves, and
`VoiceStreamClient` keeps its buffer and finalizes on `ready`. A 10 s `ready` timeout, an `error` before `ready` and
a capture that ends with no transcript each say so, with wording that mirrors cli.js's own ("No audio detected from
microphone..." for digital silence, "No speech detected").

**§5.** Voice messages are a notice pill, never the error stack. Every voice message, failures included, is one pill
above the mic: grey for an outcome, amber for an error or something to fix. A newer one replaces the older; it stays
while push-to-talk is held and fades within 5 s of release. Main sends the tone on `voice:error`; the renderer never
infers it from the wording (ADR-070). Because the desktop's `voice:error` is replicated, a client shows these
notices only for captures it started itself (until 15 s after its stop, `VOICE_OWNERSHIP_WINDOW_MS`). A live "No
signal from <mic> - lid closed or muted?" warning appears after 1.5 s of digital silence (RMS <= 1 LSB) and clears
when sound returns (a closed lid leaves the built-in mic as default and delivering zeros).

**§6.** Claude's voice pipeline (Anthropic's transcription proxy under the user's Claude login) is used only for
Claude Code sessions. It is NOT run as a shared transcriber for other engines' sessions: serving another product from
it is likely outside Claude Code's terms. Speech-to-text for other engines must come from a sanctioned source: the
user's own API key, an on-device recognizer, or an engine's own voice feature inside its own sessions. The on-device
recognizer is ADR-101; Claude sessions are unchanged.

**§7.** No loose native addons are extracted or shipped. `scripts/extract-cli.mjs` writes no
`vendor/claude-cli/vendor/<addon>/**/*.node` and `electron-builder.yml` packages none (the server zips copy
`vendor/claude-cli` whole, so they follow). cli.js loads its addons (`audio-capture`, `computer-use-*`) from inside
the Bun binary, which the rebundle preserves. macOS microphone permission is requested by Chromium for the app.

**§8.** Voice is tested with fakes only. No test, in CI or locally, drives the real voice API, and it is not probed to
verify a change. Behaviour that needs a real press or real devices is checked by hand. The opt-in verifier handle
exposes the voice notice store, so a real-app drive can show a notice without a microphone.

## opencode and pi sessions transcribe on-device (ADR-101)

Voice for engines with no speech-to-text of their own is ClaudeUI's own, from one of the two sources ADR-098 §6
allows: an on-device recognizer. Nothing audio leaves the host once the speech pack is installed.

**§1.** opencode and pi sessions transcribe on-device with Parakeet TDT 0.6B v2 int8 on sherpa-onnx, CPU only.
Claude sessions keep cli.js's voice server unchanged. The model was chosen by measurement on recorded coding
prompts: within a point of the best GPU model, needs no GPU, 660 MB, and no dropped sentences (a model that silently
loses a sentence is disqualified whatever its word error rate). Parakeet v3 is worse for this use and its int8 export
is broken; the bake-off and runtime-spike figures are in `docs/architecture/local-voice.md`. Not in this decision:
keyword biasing from session context, Claude sessions on the local model, GPU decoding.

**§2.** A local voice server speaks the cli.js voice-server protocol: newline JSON over TCP on 127.0.0.1, with
`voice_start` / `audio` / `voice_stop` in and `ready` / `transcript{text,isFinal}` / `error` / `closed` out. That is
what lets `VoiceStreamClient`, `voice-relay`, both capture owners, the pre-`ready` drain, the timeouts and the
outcome messages serve these engines unchanged; a non-Claude session's `voiceStartServer()` returns this server's
port. `voice_start` carries a per-spawn random `token` the server requires, so another local user cannot drive it
(cli.js ignores the field), and `preview` (see §7). A respawn invalidates the old token.

**§3.** The server is a separate process, one per host. It loads the model once and serves every owner (the desktop
window and remote browsers), decoding one stream at a time. It is spawned on the first start, exits after 10 minutes
without a capture (`IDLE_EXIT_MS`, releasing about 0.8 GB), dies with its parent (stdin lifetime, like opencode's and
pi's servers), and a crash costs only the in-flight capture: the next start respawns it. Out of process, a native
fault cannot take down the host and decoding stays off Electron's main thread.

**§4.** One worker module, two launchers, no system Node. The desktop runs it as its own electron-vite main entry
with `ELECTRON_RUN_AS_NODE=1`; `claudeui-server` runs it as a `voice-worker` subcommand of its own executable (from
source: `bun src/server/main.ts voice-worker`). The app still ships no native addon (ADR-098 §7, ADR-058).

**§5.** The speech pack is downloaded, never bundled, and pinned. On a supported host (win-x64, darwin-arm64,
darwin-x64, linux-x64, linux-arm64) it is `sherpa-onnx-node` plus the platform package from the npm registry (sha512
integrity) and the four model files from Hugging Face at a pinned revision (sha256 each), installed into
`~/.claude/ui/voice/` with ADR-082's download, archive and staging code (harness-installs.md): host-allowlisted
(`registry.npmjs.org`; `huggingface.co` and its `*.cdn.hf.co` redirect targets, which vary by region), streamed and
hashed, written last-step-atomic. The pins live in one manifest, `src/shared/voice-pack.ts`. About 700 MB in total. A
sherpa-onnx or model bump is a manifest change plus a re-measure; the protocol and the relay do not move.

**§6.** The first press offers the download. Starting voice on one of these engines without the pack ends the start
with a structured `needs-voice-pack` refusal, shown as the notice pill (warn tone) with a _Download speech model
(~700 MB)_ action. That action is `voice:pack-install`, capability `admin` like `harness:install` because it puts
native code on the host, with `voice:pack-install-cancel` and `voice:pack-remove` also `admin`; `voice:pack-status`
is a `chat` query. The commands are registered on both transports, so a remote client can install; progress is a
replicated event (`voice:pack-changed`, the whole `VoicePackStatus`), so a phone sees it too, and success is an
info notice. Settings > Voice input shows the pack's state and can remove it.

**§7.** Live preview is bounded. While the button is held the server re-decodes the audio after the last committed
word, with 3 s of lead-in before it for context (the model starts mid-sentence otherwise; the lead-in's words are
discarded), about once a second. Words two consecutive decodes agree on and that end at least 1 s behind the live
edge are committed (LocalAgreement-2 over word timestamps); there is no preview before 1.5 s of audio. On release one
full pass over the whole utterance produces the final transcript, which replaces the preview; past 60 s the pass is
cut into segments of at most 60 s at the quietest moment near each cut, and a capture stops accepting audio at 5
minutes (`MAX_CAPTURE_SECONDS`). Preview is on by default; a per-client setting turns it off (localStorage, ADR-098
§3), sent as `preview: false` in `voice_start`. Accepted cost: release latency grows with utterance length (about
0.5 s at 15 s, 2 s at 60 s), the trade for full-context accuracy.

**§8.** `capabilities.voice` is true for opencode and pi on a supported platform, installed or not (the install is
one press away and the refusal says so); false elsewhere.

Tests use fakes (ADR-098 §8 in spirit): the server's protocol and preview logic run against a fake recognizer and the
installer against a fake fetch. A real-model check is gated behind an env flag and uses a synthetic text-to-speech
fixture, never a person's voice.

Consequences: voice works for every engine, desktop and remote, with no account, key or network once the pack is
installed. The first use costs a download of about 700 MB, and while the worker runs it holds about 0.8 GB of RAM.
