# opencode bump checklist

Authoritative procedure: `docs/protocol-opencode/README.md` §Bump procedure and §Contract suite
(ADR-097). opencode is the upstream npm release, installed into the managed store; there is no fork
and nothing to patch. This list is what past bumps forgot.

## Research

- `git fetch --tags` in `vendor/opencode-src`, then `git diff v<old> v<new>` over the server, the
  session/permission code and `packages/core/src/agent.ts`.
- **Diff the agent permission baseline** in `packages/core/src/agent.ts` (and each built-in agent's
  own rules, e.g. `explore`). 2.0.25 silently stopped asking for `external_directory`; the contract
  suite stayed green and only the source diff caught it. If a default changed, ClaudeUI's mode gates
  must restate the rule, with a contract test.
- Types are generated from the spec the installed binary serves (`GET /openapi.json`), not from
  upstream's committed `packages/protocol/openapi.json`, which upstream stopped regenerating at
  2.0.25.

## Files that move with the pin

- `src/shared/harness-manifests/opencode.json`: `tested`, `floor`, and per platform `package`,
  `integrity` (npm `dist.integrity`) and `binarySha256` (hash of the extracted binary). Check every
  platform, including linux-arm64 (the release CI builds on arm64).
- `PIN_COMMIT` in `scripts/generate-opencode-protocol.mjs` (check against
  `git ls-remote origin refs/tags/v<version>`).
- `vendor/opencode-src` checked out at the new tag.
- Generated protocol and `src/shared/opencode-config-schema.json` (from
  `bun run generate-opencode-protocol`; review the drift report, `--accept-events` only after
  reviewing each changed event source).
- `ceiling` only when adopting a new major, and only on the owner's say-so.

## Gates

- `bun run update-opencode`, then `bun run check-opencode-protocol`.
- `OPENCODE_V2_INTEGRATION=1 bun run test:integration src/integration/opencode` — twice, and once
  with `--maxWorkers=4`. Without the variable the suite skips and looks green.
- Contract homes inside a git checkout need `git init`: opencode treats the whole enclosing repo as
  the project.
- Windows lifecycle and shell run before a release (ADR-097 §8.2, `docs/opencode-v2-windows-test.md`).
- Real-app verifier: a turn with a tool call, an outside-workspace path in default mode (must
  ask), a subagent (`explore`), a reload.

## Known rulings (not bugs)

- Quitting ClaudeUI removes the opencode ChatGPT login ClaudeUI itself wrote (ADR-097 §5); a
  different token the user added stays.
- A new session starts on the last-picked model.
- Verifiers must not run a second app on the owner's real profile: its quit removes the shared
  credential. Isolate the home.
