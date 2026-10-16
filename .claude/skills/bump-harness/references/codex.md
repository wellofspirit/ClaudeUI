# Codex bump checklist

Authoritative: `docs/protocol-codex/README.md` (install, §Regeneration, §Verification) and the
bump note in `scripts/ensure-harness.mjs`'s header. Owner rule: floor = tested.

## Research

- Codex releases are cut from `main`, not from the previous minor's branch: diff the tags
  (`git diff rust-v<old> rust-v<new>` in `vendor/codex-src`), not the release notes alone, over
  `codex-rs/app-server-protocol`, `codex-rs/core/src/session`, and the feature flags
  (`Stage::UnderDevelopment` features that flip to default-on change behaviour without an API
  change — e.g. `instant_interrupt` in 0.162).
- A behaviour claim from source reading is checked live before it goes into a comment or doc:
  the SSE and websocket paths behave differently.

## Files that move with the pin

- `src/shared/harness-manifests/codex.json`: `tested`, `floor`, `sourceCommit`, `license` +
  `licenseSha256`, and per host the `binaries` digests for both `codex` and
  `codex-code-mode-host` (they install together; without the host every tool call fails).
- `vendor/codex-src` at the new tag.
- `bun run generate-codex-protocol`, then `bun run check-codex-protocol`; review the generated diff
  and `provenance.json`.
- The version line and delta notes in `docs/protocol-codex/README.md`.

## Gates

- `bun run update-codex`.
- `bun run test:unit src/core/codex`, then
  `CODEX_INTEGRATION=1 bun run test:integration src/integration/codex --maxWorkers=1` (serially).
  Four tests run on every reviewed host; the other eight are macOS arm64 only — on Windows they
  skip, and the PR must say the macOS run is still owed.
- Linux: `scripts/docker/codex-linux-verify.sh --arch x64` (and `arm64`) when Docker is available.
- Real-app verifier: a tool turn with an approval, a steer mid-answer, reopen (effort and model are
  restored), a subagent.
