# On-device voice

Speech-to-text for opencode and pi sessions, **as built** (ADR-101). Claude sessions keep cli.js's own voice server and are not covered here. The decisions, the model bake-off and the measurements live in [ADR-101](../adr/adr-101_on-device-speech-to-text.md); the security posture (the loopback token, what is audited, why the pack install is `admin`) is [security.md](security.md) §Audit "On-device voice". This page is the contract each piece codes against; the sections keep the labels C1–C6 that source comments cite (`docs/architecture/local-voice.md Cn`).

## Overview

```
renderer capture (desktop window or remote browser)
   │  16 kHz i16le PCM frames (`voice:audio` IPC / `voice-audio` lane)
   ▼
voice-relay.ts ── VoiceRelayRegistry.start ──► session.voiceStartServer()
   │                                              │ BaseSession → localVoiceServer.acquire()
   │                                              ▼
   │                                   local-voice-server.ts   one worker per host, lazy spawn
   │                                              │  spawn: launcher + --addon/--model, token in env
   ▼                                              ▼
VoiceStreamClient ── TCP 127.0.0.1:<port> ──► worker/ (server.ts, preview.ts, segments.ts, recognizer.ts)
   (cli.js protocol + `token`, `preview`)        sherpa-onnx-node + Parakeet TDT 0.6B v2 int8, CPU
```

| Piece                                                                          | Where                                                                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| The pack's pins, status and result types                                       | `src/shared/voice-pack.ts` (C1, C6)                                                                    |
| Store layout and `resolveVoicePack()`                                          | `src/core/voice/pack-store.ts` (C2)                                                                    |
| Download, verify, publish, remove                                              | `src/core/voice/pack-installer.ts` (C2, C6)                                                            |
| The host's handle on the one worker                                            | `src/core/voice/local-voice-server.ts` (C3)                                                            |
| The worker process: entry, protocol server, preview, final pass, sherpa loader | `src/core/voice/worker/` (`main`, `server`, `preview`, `segments`, `recognizer`, `protocol`) (C3, C4)  |
| The two launchers                                                              | `src/main/voice-worker.ts` + `voice-worker-launcher.ts`, `src/server/voice-worker-launcher.ts` (C3)    |
| Client of the protocol, relay, session wiring                                  | `src/core/services/voice-stream-client.ts`, `voice-relay.ts`, `src/core/providers/BaseSession.ts` (C5) |
| Pack commands and the `voice:pack-changed` event                               | `src/core/ipc/voice-pack-commands.ts` (C6)                                                             |

Nothing here is bundled: the app ships no native addon (ADR-101 §4, ADR-058). The speech pack is downloaded on demand, and the worker is the app's own executable relaunched as a Node-like process.

## C1. Speech-pack manifest

`src/shared/voice-pack.ts`. One `VOICE_PACK` constant (`as const`) holds every pin, and nothing else carries a version or digest, so a sherpa-onnx or model bump is an edit to that file. Read it for the current values; this page does not copy them.

- `id` and `label` (the pack's identity, quoted by the UI and recorded in `install.json`).
- `runtime.version`; `runtime.wrapper` (`sherpa-onnx-node`) and `runtime.platforms[<platform>-<arch>]` (the native package for that host). Each package carries `package`, `tarball` (a `registry.npmjs.org` URL) and `integrity` (npm's `sha512-<base64>`).
- `model.repo`, `model.revision` (a pinned Hugging Face commit, never a branch) and `model.files`: four entries of `{ name, size, sha256 }` (the three int8 ONNX files and `tokens.txt`).

Helpers, all in the same file:

- `voicePackPlatformKey(platform = process.platform, arch = process.arch)` returns a key of `runtime.platforms` or `null`. The supported keys are `win32-x64`, `darwin-arm64`, `darwin-x64`, `linux-x64` and `linux-arm64`; the parameters exist so tests and a description of another host can ask.
- `VOICE_PACK_APPROX_BYTES` (700,000,000), the UI's "~700 MB".
- `voicePackModelUrl(name)`: `https://huggingface.co/<repo>/resolve/<revision>/<name>`.
- `voicePlatformUnsupportedMessage()`: the one wording for "this host has no speech runtime", used by the capability gate (`services/voice-gate.ts`) and by `VoicePlatformUnsupportedError`.

The status and result types of C6 are declared in this file too, so the renderer, the transports and the installer share one definition.

## C2. Store layout and resolution

`src/core/voice/pack-store.ts` (layout, resolution) and `pack-installer.ts` (writing it).

```
~/.claude/ui/voice/                   root: voiceStoreRoot(); CLAUDEUI_VOICE_STORE moves it
  <pack id>/                          the installed pack
    runtime/node_modules/sherpa-onnx-node/…          the wrapper tarball's `package/` contents
    runtime/node_modules/<platform package>/…        a sibling, so the wrapper's relative native lookup resolves
    model/<the four files>
    install.json                      written last
  .staging/<id>-<random>/             an install's payload (becomes <pack id>/)
  .staging/<id>-<random>.downloads/   the archives and model files while they download
  .trash/<id>-<random>/               a pack moved aside, deleted afterwards
```

The root is never shared with the harness store (ADR-082): its collection and "installed" semantics are about engine versions, and a 650 MB model must not be swept by either. The staging and trash machinery is ADR-082's (`harness/install/store-writer.ts`, parameterised by root).

**`install.json`** (`VoiceInstallRecord`): `packId`, `runtimeVersion`, `platform`, `model: { repo, revision }`, `files` (pack-relative POSIX path to sha256, covering every extracted runtime file and the four model files) and `installedAt` (ISO time).

**`resolveVoicePack(): { addonDir, modelDir } | null`** is non-null only when the platform key is not null, `install.json` parses, its `packId`, `runtimeVersion`, `platform` and `model.revision` equal this build's pins, every model file exists with the manifest's size, and `<addonDir>/package.json` and `<runtime>/node_modules/<platform package>/sherpa-onnx.node` exist. It never re-hashes (hashing happened at install); a quarantined or deleted runtime reads as "not installed", which offers the download. `model.repo` and the per-file hashes in `files` are recorded but not compared on resolve.

**Install order** (`createVoicePackInstaller().install()`):

1. Sweep stale entries; if the pack's slot holds a directory `resolveVoicePack()` rejects (interrupted install, other pins, deleted runtime) move it to the trash first, under the worker hold.
2. Download the two npm tarballs (wrapper, then this host's platform package) into the `.downloads` sibling, check each against its sha512 integrity, extract under `runtime/node_modules/<package>/` with the `package/` prefix stripped, then delete the tarball. Small files first, so a blocked registry or CDN fails in seconds.
3. Download the model files smallest first, each capped at its pinned size and checked for size and sha256, then move into `model/`.
4. Write `install.json` last (exclusive create), remove the downloads directory, and rename the payload into `<root>/<pack id>/` in one step. The last abort check and the point of no return sit together just before that rename; past it `cancel()` returns false.

Host policies (`harness/install/download.ts`): npm tarballs use `NPM_REGISTRY` (`registry.npmjs.org`, no redirects); model files use `HUGGING_FACE`: the request must start at exactly `huggingface.co`, and a redirect may land on `huggingface.co` or any subdomain of `hf.co` / `huggingface.co` (the CDN host varies by region), via the optional `HostPolicy.redirectHostSuffixes` (suffix match requires a label boundary, so `evilhf.co` and `hf.co.evil.test` fail). Fetches use `pickNetFetch()` like the harness installer.

**Worker hold.** A running worker has the runtime's DLLs open and Windows will not rename or delete a directory containing one. Anything that moves a pack directory (removal, or putting an unusable pack aside) runs inside `localVoiceServer.suspend()`, which stops the worker and makes `acquire()` reject until released. The hold covers only the renames; the trash is deleted after the release. A fresh install into an empty slot, and the long download itself, need no hold, so installing while a capture runs on an older pack is fine.

**Concurrency.** One install at a time: a second `install()` joins the first, and `cancel()` aborts the shared job for every caller. `remove()` ends an install in flight first (unless it is already committing, in which case it finishes and is then removed); a second `remove()` joins the first; an `install()` waits for a removal in flight.

**Stale cleanup.** `.staging` and `.trash` entries untouched for an hour (a payload and its `.downloads` sibling count as one) are removed by `sweepVoicePackStore()`: at boot (`core/boot/core-services.ts`, in `afterBoot` and when the updater is disabled), at the start and end of an install, and after a removal. Entries this process is using are skipped.

## C3. Worker process contract

`src/core/voice/worker/main.ts` (`runVoiceWorker`) in the worker; `src/core/voice/local-voice-server.ts` (`LocalVoiceServer`, module singleton `localVoiceServer`) in the host.

**Launch.**

- Arguments: `--addon <dir> --model <dir> [--threads <n>]`. A leading `voice-worker` argument is stripped, so one parse serves the server subcommand and the desktop entry. An unknown flag, a missing value or a non-positive `--threads` ends the start with a `fatal` line.
- The token is the environment variable `CLAUDEUI_VOICE_TOKEN` (`VOICE_TOKEN_ENV`, defined in the import-free `worker/protocol.ts` so the host does not pull the worker graph into its bundle). Never argv: argv is readable by every local user.
- `threads` defaults to `Math.min(8, Math.max(2, Math.floor(os.availableParallelism() / 2)))` (`defaultThreads`).
- The host has no default launch command. Each entrypoint installs one with `setVoiceWorkerLauncher(fn)` (the `setSqliteDriver` pattern); an uninstalled launcher rejects `acquire()` with a message naming the fix. A launcher turns the worker's own arguments into `{ command, args, env? }`.
  - Desktop (`src/main/voice-worker-launcher.ts`): `process.execPath` + `[<appPath>/out/main/voice-worker.js, …args]` with `ELECTRON_RUN_AS_NODE=1`. `out/main/voice-worker.js` is a second electron-vite main entry (`src/main/voice-worker.ts`, configured in `electron.vite.config.ts`) and must not import `electron`. `app.getAppPath()` is the repository root in development and `…/app.asar` packaged, so one join serves both; Electron's Node mode reads inside an asar. Whether the packaged worker runs from the asar is unverified here (the path join is unit-tested; a packaged run was not exercised while writing this page).
  - Server (`src/server/voice-worker-launcher.ts`): the server's own executable. A `bun build --compile` executable (its entry is a virtual-filesystem path, recognised by `isCompiledBunEntry`) runs `[process.execPath, 'voice-worker', …args]`; from source or the pure-asset bundle it is `[process.execPath, process.argv[1], 'voice-worker', …args]`. `src/server/cli.ts` accepts `voice-worker` as a command that passes the rest of the arguments through unparsed, and `src/server/main.ts` dispatches it to `runVoiceWorker` before any database or host-adapter setup, with a dynamic import.
- Shutdown: `localVoiceServer.stop()` runs from the desktop's quit teardown (`src/main/index.ts`) and the server's SIGINT/SIGTERM path (`src/server/main.ts`), fire-and-forget; stdin EOF would end the worker anyway.

**stdout.** Exactly one protocol line: `{"type":"listening","port":N}` once the model is loaded and the server listens on `127.0.0.1` (port 0, OS-chosen), or `{"type":"fatal","message":"…"}` followed by exit 1. A failure after `listening` goes to stderr only (and exit 1). The worker routes `console.log`/`info`/`debug` to stderr first thing so a stray log cannot become that line. Diagnostics go to stderr. **Audio, transcripts and the token are written nowhere.**

**Lifetime.**

- stdin ending (`end` or `close`) exits 0: the parent is gone. So the host gives the worker a stdin pipe it keeps open for the worker's whole life and never writes to. The handlers are installed before the model load, so a parent that dies during the multi-second load leaves no orphan.
- Exits 0 after 10 minutes (`IDLE_EXIT_MS`) with no authenticated connection. The idle timer is armed when the server starts listening, disarmed while an authenticated connection is open, and re-armed when the last one closes. Unauthenticated peers never hold it off.
- Exits 1 on `uncaughtException` / `unhandledRejection` (the `fatal` line carries the error's message only, never a stack).
- A crash costs the in-flight capture; the next `acquire()` respawns.

**Host side** (`LocalVoiceServer`).

- `acquire(): Promise<{ port, startFields: { token } }>`. Spawns ONE worker lazily; concurrent acquires share the spawn. A live worker (running and `exitCode`/`signalCode` still null) is reused. The token is 32 random bytes as hex, fresh per spawn, passed in the child's environment and kept in memory; never logged.
- `isRunning()`; `stop()` ends stdin, kills the child and waits for its exit, with a hard kill after 3 s; `suspend(reason)` stops the worker and makes every `acquire()` reject with `VOICE_SERVER_HELD_MESSAGE` until the returned `release()` runs (holds do not nest: a second `suspend()` throws).
- Errors: `VoicePlatformUnsupportedError` (`code = 'voice-platform-unsupported'`) when `voicePackPlatformKey()` is null; `VoicePackMissingError` (`code = 'needs-voice-pack'`) when `resolveVoicePack()` is null; `isVoicePackMissing(err)` matches by `code` so a copy of the class from another bundle still reads as one. The platform check runs before the pack check.
- Start: the `listening` line must arrive within 20 s (`VOICE_WORKER_START_TIMEOUT_MS`), else the worker is killed and the start fails. Only the first protocol line matters: up to 20 lines / 64 KiB of non-protocol stdout before it are skipped (logged at debug), past that the start fails; after it stdout is drained and ignored. The stdin pipe's, stdout's and stderr's `error` events are defused.
- Logging: spawn (pid) and exit (code or signal) at info, a `fatal` message and a crash (with the last 2,000 characters of stderr) at warn, each stderr line at debug, hold and release at info. A `fatal` message reaches the user capped at 300 characters.
- The worker is respawned by the next `acquire()` after any exit.
- The idle exit races a start: `acquire()` can hand out the port of a worker that exits before the client connects. See C5 for the single retry.

**Recognizer** (`worker/recognizer.ts`). The `Recognizer` interface is `decode(samples: Float32Array): Promise<{ text: string; words: Word[] }>`; the protocol server takes one, so tests inject a fake. `loadSherpaRecognizer(addonDir, modelDir, threads)`:

- Requires the addon by absolute path with `createRequire` from `node:module`, anchored at `<addonDir>/package.json`, and loads the package's main file (the `main` of its `package.json`, else `index.js`, kept inside `addonDir`) rather than the directory: a bun-compiled executable cannot resolve a directory specifier, and this form works under the electron-vite CJS output and `bun build` alike (`addonEntry`).
- Loads with `OfflineRecognizer.createAsync` and decodes with `decodeAsync`. Config: `featConfig { sampleRate: 16000, featureDim: 80 }`, `modelConfig { transducer { encoder, decoder, joiner }, tokens, numThreads, modelType: 'nemo_transducer', provider: 'cpu' }`, `decodingMethod: 'greedy_search'`.
- Electron's V8 sandbox forbids external buffers, so the worker only feeds `Float32Array`s it allocated itself. The calls it makes (`acceptWaveform`, `decodeAsync`, `getResult`) take no `enableExternalBuffer` option, so there is nothing to switch off; a new use of an API that does (`readWave`, VAD) must pass `enableExternalBuffer: false`.
- Words come from the result's `tokens` / `timestamps` / `durations` (`wordsFromTokens`): a token starting with a space starts a new word, the others continue the word before it; a result without `durations` ends each token where it starts.

Decodes are serialized through one queue (`DecodeQueue` in `server.ts`): one recognizer, many connections, strict arrival order. A preview can therefore wait behind another capture's final pass, which costs a stale interim, never a wrong answer.

## C4. Protocol

The cli.js voice-server protocol, newline-delimited JSON over TCP on `127.0.0.1`, with two extra `voice_start` fields (cli.js ignores unknown fields).

```
client → server   {"type":"voice_start","language":"en","token":"<hex>","preview":true}
                  {"type":"audio","data":"<base64 i16le 16 kHz mono>"}
                  {"type":"voice_stop"}
server → client   {"type":"ready"}
                  {"type":"transcript","text":"…","isFinal":false|true}
                  {"type":"error","message":"…"}
                  {"type":"closed"}
```

Implemented in `worker/server.ts` (`createVoiceServer`), with the preview policy in `worker/preview.ts` and the final-pass cut in `worker/segments.ts`.

**Authentication and connection limits.**

- `token` is compared as fixed-length SHA-256 digests with `crypto.timingSafeEqual`, so neither the value nor its length is observable. A missing or wrong token gets `{"type":"error","message":"unauthorized"}`, the socket is half-closed (`end()`), and destroyed 100 ms later (`REJECT_LINGER_MS`), so a peer that keeps its side open cannot hold it.
- A connection must send a `voice_start` line within 5 s (`PRE_AUTH_DEADLINE_MS`) and at most 64 KiB before it (`PRE_AUTH_MAX_BYTES`), else it is destroyed. A line that is not a JSON object is ignored. A repeated `voice_start` is ignored (one capture per connection). `audio` before a valid start is ignored.
- Only authenticated connections hold off the idle exit (C3). Closing the socket cancels the capture: decodes queued for it are skipped when their turn comes.
- `preview` defaults to on; only an explicit `false` turns it off.

**Capture.** Frames are decoded to `Float32Array`s the server allocates (`i16 / 32768`); a dangling odd byte is dropped. A capture holds at most 300 s of audio (`MAX_CAPTURE_SECONDS`): past it the server sends one `error` ("Recording is too long — the rest was not transcribed"), ignores further audio, and the capture still finalizes over the first 300 s.

**Preview** (only when `preview` is on; `preview.ts` is pure arithmetic over `{ word, start, end }`, with no sherpa, sockets or clock). A 100 ms poll asks `previewDue`: a preview starts when none is in flight for this capture, at least 1.5 s of audio has arrived (`MIN_PREVIEW_AUDIO_S`), and at least 1000 ms have passed since the previous preview STARTED (`PREVIEW_EVERY_MS`). It decodes the audio from a window start to the live edge, queued like any decode; the window and the commit logic are:

- The window starts `LEAD_IN_S` = 3 s before the commit point (never before the take), decoded for left context; words whose midpoint falls before the commit point are discarded. A repeat of the last committed word that starts within 0.3 s of the commit point is the model hearing that word's tail again and is dropped (`BOUNDARY_ECHO_S`).
- LocalAgreement-2: the longest common word prefix of this hypothesis and the previous one (the still-open words) is stable. Words are compared lower-cased with everything but letters and digits stripped (`/[^\p{L}\p{N}]+/gu`), so "Okay so" and "Okay, so" agree; the newer spelling is kept.
- Stable words that end at least 1.0 s before the live edge (`GUARD_S`) are committed. If nothing commits and the take's length past the commit point exceeds 15 s (`MAX_WINDOW_S`), words ending at least 1.0 s behind the edge are force-committed, keeping at least the last word open.
- After a commit the commit point moves to the END of the last committed word (capped at the edge). With no commit it still advances through silence: `commitStart = max(commitStart, min(firstOpenWordStart ?? edge, edge) − GUARD_S − 0.2)`, so a pause never grows the window.
- The server sends `{transcript, isFinal:false}` with committed plus open words joined by spaces: the WHOLE preview text, which the renderer REPLACES (never appends). Nothing is sent when the text is empty.
- A preview decode failure stops previewing that capture (the audio is kept) and logs the error class and code only; the final pass reports a real recognizer failure itself.

**Final pass** (`voice_stop`). The server waits for an in-flight preview decode, then decodes the whole utterance: one decode when it is at most 60 s (`MAX_SEGMENT_S`), else consecutive segments of at most 60 s, each cut at the quietest 300 ms (`QUIET_WINDOW_S`, lowest RMS) within the last 15 s of its segment (`CUT_SEARCH_S`), each segment its own queued job so other captures can interleave, texts joined with spaces. Measured: one pass over 120 s peaks at 1.8 GB / 6 s and over 300 s at 3.9 GB / 25 s, against ~1.3 GB / ~2 s for 60 s. It sends `{transcript, text, isFinal:true}` when the text is non-empty, then `closed`, then ends the socket. A stop with no audio sends only `closed`. A recognizer failure in the final pass sends `{"type":"error","message":"Speech recognition failed"}` and then `closed`. A stop before `voice_start` is ignored.

**Never logged:** audio, transcripts, the token. Diagnostics name the failure class only (`errorName`).

## C5. Client side: `VoiceStreamClient`, relay, sessions

- `ISession.voiceStartServer?(): Promise<{ port: number; startFields?: Record<string, unknown> }>` (`core/providers/ISession.ts`). `BaseSession.voiceStartServer()` is `localVoiceServer.acquire()`; Claude overrides it with cli.js's own server and returns no `startFields`.
- `VoiceStreamClient.startRecording(language, earlyBuffer = [], startFields = {})` (`core/services/voice-stream-client.ts`) sends `{ ...startFields, type: 'voice_start', language }`, so a start field can never override `type` or `language`.
- The finalize safety timeout scales with the audio relayed: `8000 + ceil(relayedBytes / 32 / 4)` ms (`finalizeTimeoutMs`), i.e. 250 ms per second of speech on top of the 8 s floor; a minute of speech gets 23 s. The on-device server decodes the whole utterance on release, which a fixed 8 s would eventually cut off.
- `VoiceRelayRegistry.start(manager, VoiceOwner, routingId, language?, opts?: { preview?: boolean })` (`core/services/voice-relay.ts`) passes `{ ...server.startFields, ...(opts.preview === false ? { preview: false } : {}) }` to the client. The desktop IPC `voice:start-recording` and the remote `voice:start` accept a trailing `{ preview?: boolean }`; only an explicit `false` has an effect. The renderer's per-client "live preview" setting is `lib/voice/preview-preference.ts` (localStorage).
- Capability gate: `capabilities.voice` is static `true` for opencode and pi, narrowed by `voicePackPlatformKey() !== null` where each session builds its capabilities (`OpencodeSession.resolveCapsForModel`, `PiSession`'s capabilities getter); installed or not, since the install is one press away. `voice-gate.ts`'s `voiceRefusal` words a refusal: the unsupported-platform message for these engines, a patched-binary message for Claude.
- **Missing pack.** When `voiceStartServer()` throws `VoicePackMissingError`, the relay delivers `VoiceDelivery.error(routingId, VOICE_PACK_MISSING_MESSAGE, 'warn', 'install-voice-pack')`, sets the capture's state to `idle` and returns without throwing (the pill explains it). The message is "Voice input for this engine needs the on-device speech model (~700 MB)", built from `VOICE_PACK_APPROX_BYTES`; clients key on the action, never the wording (ADR-070). Any other error sets `idle` and is rethrown (including `VoicePlatformUnsupportedError`).
- `type VoiceNoticeAction = 'install-voice-pack'` is in `src/shared/types.ts`. `voice:error` carries `(routingId, message, tone, action?)`; the fourth argument is present only when there is an action, on both delivery paths (the desktop through the sync funnel's `emitEvent`, a remote through a targeted `stream-ev` frame), and the `SyncEventMap` listener type in `core/shared/sync/events.ts` has the optional fourth parameter.
- **The one retry.** The worker idle-exits, so the port just handed out can be dead by the time the socket opens. `VoiceStreamClient.startRecording` handles a connect `ECONNREFUSED` by calling the protected hook `reacquireEndpoint()` ONCE and connecting again with the new port and start fields; this happens inside the connect step, so the pill never sees it. The relay supplies the hook only when the first answer carried `startFields` (that is how the on-device server is told apart from cli.js's cached port). If the retry's acquire fails with a missing pack (the pack was removed meanwhile) the relay delivers the same download notice and throws `VoiceStartReported`, which ends the client quietly without a second, generic "Failed to connect" error; any other failure is reported as the reason. A start superseded while asking touches nothing.

## C6. Pack status, commands and events

Types in `src/shared/voice-pack.ts`:

```ts
type VoicePackState = 'unsupported' | 'missing' | 'installing' | 'ready' | 'failed'
interface VoicePackStatus {
  state: VoicePackState
  packId: string
  label: string
  approxBytes: number
  progress?: { receivedBytes: number; totalBytes: number } // installing only
  error?: string // failed only
}
```

`unsupported` is a host with no speech runtime. `failed` carries the last install's error and is kept until the next install or removal, so a client that connects later still sees why there is no pack. `totalBytes` starts at the model files' pinned total and grows as each tarball's size becomes known (never shrinks), so a bar never runs backwards. `status()` is `resolveVoicePack()` (a few `stat`s) plus the in-memory job and last failure, so a client may poll it freely; the precedence is unsupported, then installing, then ready, then failed, then missing.

Commands (`src/core/ipc/voice-pack-commands.ts`, `voicePackCommands()`), declared once and registered on BOTH transports (the desktop in `session.ipc.ts`, remote clients in `remote-handlers.ts`):

| channel                     | capability | kind    | result                                                                        |
| --------------------------- | ---------- | ------- | ----------------------------------------------------------------------------- |
| `voice:pack-status`         | `chat`     | query   | `VoicePackStatus`                                                             |
| `voice:pack-install`        | `admin`    | command | `{ status: 'installed' \| 'satisfied' \| 'cancelled' \| 'failed'; message? }` |
| `voice:pack-install-cancel` | `admin`    | command | `{ status: 'cancelled' \| 'not-running' }`                                    |
| `voice:pack-remove`         | `admin`    | command | `{ status: 'removed' \| 'not-installed' }`                                    |

The three writes are in `PINNED_CAPABILITIES` (`core/ipc/command-registry.ts`) like `harness:install`. `voice:pack-install` resolves when the install does (minutes, on a slow link), never throws (failures are `{ status: 'failed', message }`) and a second call joins the first; `voice:pack-install-cancel` ends it for every client. Results never carry an `ok` key: the preload and web `unwrap` would take it for the transport envelope.

Failure messages reach every `chat` client through the event, so they carry no filesystem path: the installer's own errors and the download/archive errors (which name a URL host and path) are passed through, anything else is reduced to its errno code, and the full detail goes to the log only.

Event: `voice:pack-changed (status: VoicePackStatus)`, classified `replicated` and ringed in `core/shared/sync/channels.ts` (the entry's `why` has the reasoning), emitted on every state change and, while installing, at most four times a second (250 ms), by `startVoicePackEvents(emitEvent)` from `startCoreServices`. The ring can replay stale progress to a reconnecting client, so `voice:pack-status` is the truth and the last event of an install is always `ready`, `failed` or `missing`.

Renderer consumers (outside this contract, listed for orientation): `lib/voice/voice-pack-store.ts` (one status for the pill and Settings; subscribes to the event once and refreshes on appearance; treats an invoke timeout on `voice:pack-install` as an install still running, since the web transport gives up after 30 s and the install resolves only when done; reads a permission refusal for a remote client without `admin` as one plain sentence) and `lib/voice/voice-pack-notice.ts` (the pill's offer, progress and outcome states for a notice carrying the `install-voice-pack` action).

## Verification status

Everything above was read from the code. Not exercised while writing it: a packaged desktop build running the worker from inside `app.asar`; the real-model path on each supported platform (the measurements quoted are ADR-101's).
