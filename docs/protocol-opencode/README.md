# opencode 2.x wire protocol

Stub from slice S0 of the 2.x migration ([ADR-093](../adr/adr-093_opencode-v2-only.md)); S9 fills
it out. The spike's findings are in [`docs/opencode-v2-spike.md`](../opencode-v2-spike.md).

## Pin

- opencode **2.0.24**, tag `v2.0.24`, commit `e7a34f09bfd9134dfade5a8ddb843f7030bc9a69` (verified
  against upstream's `refs/tags/v2.0.24`). Spec and event sources are byte-identical to 2.0.23, the
  S0 pin; only the packages' `version` fields moved.
- **One pin.** The version is the harness manifest's `tested`
  (`src/shared/harness-manifests/opencode.json`); `scripts/generate-opencode-protocol.mjs` reads it
  and keeps only the reviewed commit (`PIN_COMMIT`), which it proves the tag still names. A unit
  test pins `manifest.tested` = `provenance.json#version` = `events.reviewed.json#version`.
- Source checkout: `vendor/opencode-v2-src` at the tag (gitignored, like every `vendor/*-src`).
  The generator reads the pinned commit with `git show`, so the checkout's HEAD does not matter; it
  also honours `OPENCODE_V2_SRC`, and from an agent worktree falls back to the main checkout's
  `vendor/opencode-v2-src`.

## Acquisition (ADR-082 §4, ADR-093 §1)

- npm: `@opencode/cli` (bins `opencode` and `opencode2`, both `bin/opencode.exe`, a placeholder its
  postinstall replaces with a hard link to the platform build on every OS) and one package per host,
  `@opencode/cli-<os>-<arch>` (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`,
  `windows-x64`, `windows-arm64`, plus `-baseline` / `-musl` variants). Each platform tarball holds
  exactly `package/package.json` and `package/bin/opencode[.exe]`.
- ClaudeUI's managed copy: the installer reads `@opencode%2fcli-<os>-<arch>/<version>` from
  `registry.npmjs.org`, checks the tarball against npm's `integrity` and, for the tested version,
  the reviewed `integrity` and `binarySha256` in the manifest, and keeps only the binary
  (`~/.claude/ui/harnesses/opencode/<version>/opencode[.exe]`). Windows on arm64 still runs the x64
  build. `bun run ensure-opencode` installs the tested version; `update-opencode` reinstalls it.
- Provenance (2.0.24): every package's `repository` is `anomalyco/opencode`, maintainer `thdxr`,
  published by GitHub Actions through npm trusted publishing (OIDC); the darwin binaries are signed
  `Developer ID Application: Anomaly Innovations, Inc. (5NZ4Q7NXJ4)`.
- `--version` prints `opencode v2.0.24` (1.x printed the bare version; a source build without a
  version prints `opencode vlocal`). Detection reads both; a 1.x install is labelled too old
  ("opencode 1.18.34 is from the 1.x line; ClaudeUI uses opencode 2.x (2.0.24 or newer)"), and
  `opencode2` is searched on PATH beside `opencode`. Homebrew's `opencode` formula is a 2.x source
  build with the version stamped in (`OPENCODE_VERSION`), found at `<prefix>/bin/opencode` as
  System and labelled by its version like any other (on 2026-10-06 the formula was 2.0.20, below
  the 2.0.24 floor: too old).
- Floor = tested, ceiling `3.0.0`.

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
bun run ensure-opencode   # the tested version into the managed store, once
OPENCODE_V2_INTEGRATION=1 bun run test:integration src/integration/opencode-v2
```

The binary defaults to the managed store's copy of the manifest's `tested` (honouring
`CLAUDEUI_HARNESS_STORE`); `OPENCODE_V2_BIN=/abs/path/to/opencode` overrides it.

- Every server runs with `HOME`/`XDG_*` under `.cache/opencode-v2-it/`, a refusing proxy in every
  proxy variable, models.dev fetch and autoupdate off, and on darwin under a loopback-only
  `sandbox-exec` profile. It is ended by closing stdin, and SIGKILLed if that fails.
- A failed test prints the redacted event sequence, the requests the model received, refused
  outbound attempts and the engine log, and keeps its `.cache/opencode-v2-it/<label>-*` directory
  (`OPENCODE_V2_KEEP=1` keeps all of them).
- The binary must report the pinned version; to try a candidate before bumping, add
  `OPENCODE_V2_ALLOW_VERSION_MISMATCH=1`.
- The ChatGPT credential case needs `sandbox-exec`, so it runs on darwin only.

Bump procedure: fetch upstream tags into the source checkout, set the manifest's `tested` and
`floor` with each platform package's reviewed `integrity` and `binarySha256`, set `PIN_COMMIT` to
the tag's commit (check it against `git ls-remote origin refs/tags/v<version>`), run
`generate-opencode-protocol` (review the drift report and any event-source diff), `ensure-opencode`,
then the contract suite.
