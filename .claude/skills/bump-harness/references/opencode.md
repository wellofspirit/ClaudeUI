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
- **Diff the tool plugins** (`packages/core/src/tool/plugin/`, `schema/src/config/flag.ts`): a new
  or renamed `opencode`-namespace tool is a DIRECT tool while ClaudeUI hides `execute`, and most
  carry no permission check (2.3.2 renamed `schedule_*` to `automation_*`). Each needs a
  `DIRECT_TOOL_DENY_RULES` decision and a `direct-tools` contract case with its flag on.
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
- Windows lifecycle and shell run before a release (ADR-097 §8.2; isolate the managed store with `CLAUDEUI_HARNESS_STORE`).
- Real-app verifier: a turn with a tool call, an outside-workspace path in default mode (must
  ask), a subagent (`explore`), a reload.

## Known rulings (not bugs)

- (2.4.1) The automation tools moved out of the `opencode` namespace (`automation_*`, on by default)
  and the image tool is `generate_image`: config files map the old name (`renamedTool`), session
  rules do not, so a rule naming `experimental_image_generate` is inert. Hide direct tools by
  EXACT id, never `<word>_*` (an MCP server may carry that name).
- (2.4.1) ChatGPT (`chatgpt-browser`) model gating comes from the models.dev `openai-codex` list
  (`plugin/provider/openai.ts`), not a fixed set: check `GET /api/model?types=image` live.
- Quitting ClaudeUI removes the opencode ChatGPT login ClaudeUI itself wrote (ADR-097 §5); a
  different token the user added stays.
- A new session starts on the last-picked model.
- (2.3.2) A foreground shell that reaches its timeout moves to the background; a dispatch target
  then answers with its interim text and the shell's later wake is a stray turn.
- (2.3.2) opencode reads CLAUDE.md (and `~/.claude/CLAUDE.md`) where no AGENTS.md exists;
  ClaudeUI does not set `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT`.
- (2.3.2) A process a successful command left detached (`npm run dev &`) survives ClaudeUI's quit.
- Verifiers must not run a second app on the owner's real profile: its quit removes the shared
  credential. Isolate the home.
