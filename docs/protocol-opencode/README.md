# opencode 2.x wire protocol

Stub from slice S0 of the 2.x migration ([ADR-093](../adr/adr-093_opencode-v2-only.md)); S9 fills
it out. The spike's findings are in [`docs/opencode-v2-spike.md`](../opencode-v2-spike.md).

## Pin

- opencode **2.0.23**, tag `v2.0.23`, commit `0fd7e2829449b052abf0078666669302923d77af`.
- The pin lives in `scripts/generate-opencode-protocol.mjs` (`PIN`) until S1 moves the harness
  manifest to `@opencode/cli`; from then on `manifest.tested` must equal it.
- Source checkout: `vendor/opencode-v2-src` at the tag (gitignored, like every `vendor/*-src`).
  The generator also honours `OPENCODE_V2_SRC`, and from an agent worktree falls back to the main
  checkout's `vendor/opencode-v2-src`.

## Generated types

`src/core/opencode/protocol-v2/` (the 1.x adapter keeps `protocol/` until S10):

| File                   | What                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openapi.ts`           | GENERATED from `packages/protocol/openapi.json` at the pinned commit: every component schema as a type, plus `Operations` / `OPERATIONS` per operationId. |
| `provenance.json`      | GENERATED: tag, commit, spec sha256, generator version, the sha256 of `openapi.ts`.                                                                       |
| `events.ts`            | HAND-CURATED: the SSE events ClaudeUI consumes (see below).                                                                                               |
| `events.reviewed.json` | The sha256 of every upstream file `events.ts` was transcribed from, at the commit it was reviewed against.                                                |

```sh
bun run generate-opencode-protocol   # regenerate
bun run check-opencode-protocol      # fail on drift; prints + / - / ~ per type and operation
```

**Why the events are curated.** The spec types the SSE payload as an opaque JSON string
(`V2EventEncoded`; the server's own `/openapi.json` says the same). The payloads exist only as
Effect Schemas in `packages/schema/src`, and dumping them to JSON would mean installing and running
upstream's source tree. So `events.ts` transcribes the consumed events by hand and references the
generated component types wherever a payload is one (TokenUsage.Info, Permission.Request, Form.Info,
…). A bump that changes any transcribed source file fails generate and check until someone reviews
the upstream diff (the failure prints the `git diff` command), updates `events.ts`, and runs
`bun scripts/generate-opencode-protocol.mjs --accept-events`.

The unit test `src/core/opencode/__tests__/opencode-protocol-v2.test.ts` runs everywhere: it pins the
emitter, checks the committed `openapi.ts` against provenance, and regenerates byte-for-byte when
the upstream checkout is present.

## Contract suite (the per-bump gate, ADR-093 §8.1)

`src/integration/opencode-v2/` drives a real `opencode serve --stdio` against a localhost
fixture model. It is gated and skips cleanly without the gate:

```sh
OPENCODE_V2_INTEGRATION=1 OPENCODE_V2_BIN=/abs/path/to/opencode \
  bun run test:integration src/integration/opencode-v2
```

- Every server runs with `HOME`/`XDG_*` under `.cache/opencode-v2-it/`, a refusing proxy in every
  proxy variable, models.dev fetch and autoupdate off, and on darwin under a loopback-only
  `sandbox-exec` profile. It is ended by closing stdin, and SIGKILLed if that fails.
- A failed test prints the redacted event sequence, the requests the model received, refused
  outbound attempts and the engine log, and keeps its `.cache/opencode-v2-it/<label>-*` directory
  (`OPENCODE_V2_KEEP=1` keeps all of them).
- The binary must report the pinned version; to try a candidate before bumping, add
  `OPENCODE_V2_ALLOW_VERSION_MISMATCH=1`.
- The ChatGPT credential case needs `sandbox-exec`, so it runs on darwin only.

Bump procedure: move the source checkout to the new tag, update `PIN`, run
`generate-opencode-protocol` (review the drift report and any event-source diff), then run the
contract suite with the new binary.
