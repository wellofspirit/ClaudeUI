# ADR-101: On-device speech-to-text for opencode, pi and Codex sessions

**Status:** Accepted (2026-10-12). Implementation on branch `local-voice`; resume notes in
`docs/local-voice-handoff.md`.
**Amends:** [ADR-098](adr-098_voice-capture-in-the-renderer.md) §6 (the deferred speech-to-text
for other engines is now this on-device recognizer).
**Relates to:** [ADR-082](adr-082_harness-sources-downloads-and-unbundling.md) (the download,
verification and staging machinery the speech pack reuses), [ADR-030](adr-030_capability-honesty.md)
(`capabilities.voice`), [ADR-070](adr-070_one-auth-surface.md) (notices carry their tone; nothing keys
on wording), [ADR-058](adr-058_core-extraction-and-claudeui-server.md) (why the server artifacts carry no native addon).

## Context

ADR-098 kept voice bound to Claude sessions: cli.js's transcription runs under the user's Claude
login and is not ours to serve to other products. opencode and pi have no speech-to-text. Codex has
realtime voice in its app-server, but its audio path is a conversational model behind a private
endpoint the Codex CLI does not expose to us. So voice for those engines has to be ClaudeUI's own,
and ADR-098 §6 allows exactly two sources: the user's own API key, or an on-device recognizer.

**Model choice: measured on the owner's voice, not taken from leaderboards.** A bake-off harness
(kept outside this repo: `voice-input-test/`) recorded 20 coding prompts (13.7 min, 15 scripted + 5
lifted from real Claude history), one speaker with a non-native accent, and ran 18 configurations:

| Model (runtime)                             | WER¹  | long-take WER | terms written right² | median / max latency | dropped sentences³ |
| ------------------------------------------- | ----- | ------------- | -------------------- | -------------------- | ------------------ |
| Qwen3-ASR 1.7B (GPU, biased)                | 3.9%  | 3.2%          | 76%                  | 1.3 s / 5.1 s        | none               |
| Whisper large-v3 (GPU, biased)              | 4.4%  | 3.2%          | 72%                  | 0.5 s / 2.2 s        | none               |
| **Parakeet TDT 0.6B v2 int8 (CPU)**, biased | 4.6%  | 2.9%          | 69%                  | 0.5 s / 2.6 s        | none               |
| **Parakeet TDT 0.6B v2 int8 (CPU)**         | 5.1%  | 2.8%          | 52%                  | 0.4 s / 2.0 s        | none               |
| Whisper large-v3-turbo (CPU)                | 5.8%  | 3.5%          | 66%                  | 6.1 s / 18 s         | none               |
| Parakeet TDT 0.6B v3 int8 (CPU)             | 16.1% | 13.2%         | 33%                  | 0.4 s / 2.4 s        | 4                  |
| Canary 180M flash int8 (CPU)                | 20.1% | 21.9%         | 31%                  | 0.8 s / 5.6 s        | 4                  |

¹ Open ASR Leaderboard normalization, identifiers split into words, spacing not counted. ² A prompt's
key identifier appears verbatim (`useStickToBottom`, not `use stick to bottom`). ³ A run of ≥4
reference words missing from the transcript; a silently lost sentence of an instruction is worse than
any misspelling, so this disqualifies a model whatever its WER.

Parakeet v2 int8 on CPU is within 0.7 points of the best GPU model, needs no GPU, and is 660 MB.
int8 costs it nothing (fp32: 5.2%). v3 is worse for this voice and its int8 export is broken for it
(v3 fp32 6.9%, still one dropped sentence). The owner chose v2 int8 (2026-10-12).

**The runtime spike** (sherpa-onnx-node 1.13.8, the same C++ core the harness measured through
Python) decoded the same recordings with identical text under Node 26, Electron 43 run as Node, bun
1.4.2, and a `bun build --compile` executable run with `BUN_BE_BUN=1`; `decodeAsync` keeps the event
loop live. Loaded: ~760 MB RSS; ~1.3 GB peak decoding 55 s. Windows: Node loads the addon's sibling
`onnxruntime.dll`, so the OS's older `System32\onnxruntime.dll` (which segfaults the Python wheel)
does not win. macOS (`@loader_path`) and Linux (`$ORIGIN`) resolve their libraries beside the addon,
so no `DYLD_LIBRARY_PATH` — which a hardened-runtime app would strip anyway. Under Electron the V8
sandbox forbids external buffers: every sherpa call must pass `enableExternalBuffer = false`.

## Decision

1. **opencode, pi and Codex sessions transcribe on-device with Parakeet TDT 0.6B v2 int8 on
   sherpa-onnx, CPU only.** Claude sessions keep cli.js's voice server unchanged. Nothing audio
   leaves the host.

2. **A local voice server that speaks the cli.js voice-server protocol.** Newline JSON over TCP on
   127.0.0.1 — `voice_start` / `audio` / `voice_stop` in, `ready` / `transcript{text,isFinal}` /
   `error` / `closed` out — so `VoiceStreamClient`, `voice-relay`, both capture owners, the
   pre-`ready` drain, the timeouts and the outcome messages serve these engines unchanged. A
   non-Claude session's `voiceStartServer()` returns this server's port. `voice_start` carries a
   per-spawn random `token` the server requires (another local user must not be able to drive it);
   cli.js ignores the field.

3. **A separate process, one per host.** It loads the model once and serves every owner (the desktop
   window and remote browsers), decoding one stream at a time. It is spawned on the first start,
   exits after 10 minutes without a capture (releasing the ~0.8 GB), dies with its parent (stdin
   lifetime, as opencode's and pi's servers), and a crash costs the in-flight capture only: the next
   start respawns it. Keeping it out of process isolates a native fault from the host and keeps
   decoding off Electron's main thread.

4. **One worker module, two launchers, no system Node.** The desktop runs it as its own
   electron-vite main entry with `ELECTRON_RUN_AS_NODE=1`; `claudeui-server` runs it as a
   `voice-worker` subcommand of its own executable (from source: `bun src/server/main.ts
voice-worker`). The app still ships no native addon (ADR-098 §7, ADR-058).

5. **The speech pack is downloaded, never bundled, and pinned.** On a supported host (win-x64,
   darwin-arm64, darwin-x64, linux-x64, linux-arm64) it is `sherpa-onnx-node` + the platform package
   from the npm registry (sha512 integrity) and the four model files from Hugging Face at a pinned
   revision (sha256 each), installed into `~/.claude/ui/voice/` with ADR-082's download, archive and
   staging code: host-allowlisted (`registry.npmjs.org`; `huggingface.co` and its `*.cdn.hf.co`
   redirect targets, which vary by region), streamed and hashed, written last-step-atomic. The pins
   live in one manifest in `src/shared/`. About 700 MB in total.

6. **The first press offers the download.** Starting voice on one of these engines without the pack
   ends the start with a structured `needs-voice-pack` refusal, shown as the notice pill (warn tone)
   with a _Download speech model (~700 MB)_ action. The action is a new `voice:pack-install` command
   (capability `admin`, as `harness:install`: it puts native code on the host), with
   `voice:pack-install-cancel`; progress is a replicated event, so a phone sees it too, and success is
   an info notice. Settings › Voice input shows the pack's state and can remove it.

7. **Live preview, bounded.** While the button is held the server re-decodes the audio after the
   last committed word, with 3 s of lead-in before it for context (the model starts mid-sentence
   otherwise; the lead-in's words are discarded), about once a second: words two consecutive decodes agree on, ending at least
   1 s behind the live edge, are committed (LocalAgreement-2 over Parakeet's word timestamps); no
   preview before 1.5 s of audio. On release one full pass over the whole utterance produces the final transcript, which replaces the
   preview; past 60 s the pass is cut into ≤ 60 s segments at the quietest moment near each cut (one
   pass over 300 s peaks at 3.9 GB and 25 s, a 60 s segment at ~1.3 GB and ~2 s), and a capture stops
   accepting audio at 5 minutes. Measured on the owner's nine 17–65 s takes: an update every 1 s, ~25% CPU while held,
   preview words wrong 10.5% of the time (18.1% without the lead-in), final 0.5 s after a 17 s
   take and ~2 s after a minute. Preview is on by default; a per-client setting turns it off
   (localStorage, ADR-098 §3), sent as `preview: false` in `voice_start`.

8. **`capabilities.voice` is true for opencode, pi and Codex on a supported platform**, installed or
   not (the install is one press away and the refusal says so); false elsewhere.

9. **Tested with fakes** (ADR-098 §8 in spirit): the server's protocol and preview logic run against a
   fake recognizer, the installer against a fake fetch. A real-model check is gated behind an env
   flag and uses a synthetic (text-to-speech) fixture, never a person's voice.

**Not in this decision:** keyword biasing from session context (measured +17 points of correctly
written terms; needs a term-selection design), Claude sessions on the local model, GPU decoding.

## Consequences

- Voice works for every engine, desktop and remote, with no account, key or network once the pack is
  installed.
- The first use costs a ~700 MB download; while the worker runs it holds ~0.8 GB of RAM (released
  after 10 idle minutes).
- Release latency grows with utterance length (~0.5 s at 15 s, ~2 s at 60 s) because the final pass
  is over the whole utterance — the trade for full-context accuracy.
- Accent errors the model makes consistently ("Claude" → "cloud" for this speaker, 3–5 of 6) are not
  fixed by biasing; a context-aware correction pass is a possible follow-up.
- A sherpa-onnx or model bump is a manifest change plus the harness re-run; the protocol and the
  relay do not move.
