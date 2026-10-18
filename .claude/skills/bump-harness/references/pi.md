# pi bump checklist

Wire notes: `docs/protocol-pi/README.md`; version-exact upstream docs in
`vendor/pi-src/packages/coding-agent/docs/` at the pinned tag (ADR-035). pi has no version
handshake: the pin is the contract.

## Research

- Read `packages/coding-agent/CHANGELOG.md` across the range, then `git diff v<old> v<new>` in
  `vendor/pi-src` over `docs/rpc.md`, the RPC mode, the event types and the tool-list parsing.
- Grep ClaudeUI's mapper (`src/core/pi/`) for every field the changelog removes or renames. 0.84
  removed `message_update.message`; it would have crashed every tool-using turn, and no suite pushed
  a tool turn through the mapper.
- Check argument validation changes against what ClaudeUI passes (1.1.0 rejects a `--tools` list
  that mixes `+`/`-` entries with plain names; ClaudeUI always appends a plain `send_message`).

## Files that move with the pin

- `src/shared/harness-manifests/pi.json`: `tested`, `floor` (owner rule: floor = tested unless told
  otherwise) and each platform's `asset` + `archiveSha256` from the release's `SHA256SUMS`, checked
  against the downloaded archive.
- `vendor/pi-src` at the new tag.
- Version stamps in `docs/protocol-pi/README.md`.

## Gates

- `bun run update-pi`.
- `PI_INTEGRATION_TESTS=1 bun run test:integration src/integration/pi`. The vitest setup moves
  HOME, so the model-call tests skip unless `PI_CODING_AGENT_DIR` points at an isolated agent
  directory whose credential is a `!command` (recipe at the top of `docs/protocol-pi/README.md`).
  Count the skips; 8 skipped means the model calls did not run.
- Never copy a real `auth.json` into another tool's store or refresh its token; compare the real
  `~/.pi/agent/auth.json` sha256 and mtime before and after the run.
- Real-app verifier: a tool turn, a subagent, abort, resume.
