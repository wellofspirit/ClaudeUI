# Patch set: opencode fork (`claudeui` branch)

ClaudeUI's opencode patches, unlike the `cli.js` ones in the sibling directories,
are **source patches on a git fork**, not surgery on a minified bundle. There is
no `.patch` file to re-anchor: the patches live as commits on
`github.com/wellofspirit/opencode` branch `claudeui`, and `scripts/ensure-opencode.mjs`
clones that branch, builds it with opencode's own release pipeline, and vendors
the binary into `vendor/opencode-cli/`.

Policy: **ADR-037** — fork + patch, narrow diffs, **never upstream**.

## Affected component

| Component | Value |
| --------- | ----- |
| Upstream | `github.com/sst/opencode` (MIT) |
| Fork | `github.com/wellofspirit/opencode`, branch `claudeui` |
| Forked from | tag `v1.18.9`, currently merged up to **`v1.18.10`** |
| Pinned by | `package.json#opencodeCliVersion` + `package.json#opencodeFork` |
| Provenance | `vendor/opencode-cli/version.json` (`source`, `fork.commit`, `builtAt`) |

Upstream's release branch is **`dev`**, not `main`. Release tags (`vX.Y.Z`) are
CI commits created *on top of* `dev` and never merged back, so `git merge-base
--is-ancestor v1.18.10 origin/dev` is **false**. Bump by merging the *tag*, not
the branch.

## The patches

### P1 — `POST /judge/completion` (tool-less completion)

**Files:** `groups/judge.ts` (new), `handlers/judge.ts` (new), `api.ts` (+2),
`server.ts` (+2), all under
`packages/opencode/src/server/routes/instance/httpapi/`.

**Why.** ClaudeUI's auto-mode judge reads attacker-influenced transcript text and
returns a verdict. Routing that through `POST /session/{id}/message` forces a
real session with a tool registry and a permission ruleset, so "the model called
a tool" is a state we can only *deny*, never make unreachable — and the session
prompt API exposes neither `max_tokens` nor `stop_sequences`, so the judge's cost
budget is unenforceable (the standing ADR-023 deviation).

**What.** Resolve the model through `Provider.Service.getModel` / `getLanguage`
and hand it straight to the AI SDK. No session row, no `ToolRegistry`, no
`Permission` evaluation, no `permission.asked`. Same server-password Basic auth
as every other instance route (it reuses `Authorization` +
`WorkspaceRoutingMiddleware` + `InstanceContextMiddleware` verbatim from the
`question`/`experimental` groups).

**Contract.**

```
POST /judge/completion
  { model: {providerID, modelID}, system, user, maxTokens?, stopSequences? }
  → 200 { text }
  → 400 BadRequest        (payload)
  → 404 ModelNotFoundError
  → 502 UpstreamError     (carries the provider's response body + status)
```

**Three non-obvious constraints, each of which cost a debugging cycle:**

1. **It MUST stream.** The route uses `streamText` and collects `await
   stream.text`. `generateText` — the obvious choice for a single-turn route —
   gets `400 {"detail":"Stream must be set to true"}` from the ChatGPT/Codex
   OAuth backend. The session path has always used `streamText`, so nothing
   upstream exercises the non-streaming path. `onError` is wired because
   `streamText` reports mid-stream failures there instead of throwing, and an
   empty verdict must never reach a fail-closed caller as success.
2. **Some backends reject an output cap.** `rejectsOutputCap()` mirrors three
   upstream `chat.params` hooks (`plugin/openai/codex.ts`,
   `plugin/github-copilot/copilot.ts`, `plugin/cloudflare.ts`). `maxTokens` is
   still honoured everywhere else — verified: `maxTokens: 8` truncates.
3. **The plugin hooks cannot be called from here.** Both `chat.params` and
   `chat.headers` require a real `UserMessage`, and copilot's `chat.headers`
   hook dereferences `message.sessionID` to fetch that session's parts. So their
   transport effects (the cap drop above, and openai's
   `originator`/User-Agent/`session-id` headers) are replicated directly, each
   with a source citation in the code.

Known, documented limits: on OpenAI's Responses API neither `maxTokens` nor
`stopSequences` is enforceable (the SDK drops `stopSequences` with an
"unsupported" warning). Stated in the OpenAPI description so `/doc` carries it.

### P2 — `permissionHermetic` (sealed sessions)

**Files:** `packages/opencode/src/permission/index.ts`,
`.../httpapi/groups/session.ts` (+4), `.../httpapi/handlers/session.ts` (+15),
`packages/opencode/test/permission/hermetic.test.ts` (new).

**Why (auto-mode rework plan §7 Q5).** "Always" approvals are stored in
**instance-global** state, *not* keyed by sessionID, and `evaluate()` appends
that list **after** the session's own ruleset with `findLast`-wins. So the
deny-all ClaudeUI patches onto every throwaway session is outranked by any
pattern the user ever always-approved anywhere on that server. Prompt-inject the
judge into proposing such a command and it executes, with no human in the loop.

**What.** `permissionHermetic?: boolean` on the session PATCH payload. A sealed
session is evaluated against its own ruleset **alone**, and is also a *sink, not
a source*: an "always" answered inside it never widens the instance for anybody
else. Unsealed sessions evaluate against exactly the same rulesets in the same
order as before — the entire behavioural delta is behind the flag.

**Where the flag lives.** In `Permission`'s instance state, beside the `approved`
list it cancels — **not** on the session row. `approved` is itself in-memory and
instance-scoped, so a persisted flag would outlive the risk it exists to cancel;
and a session-schema change would fork the on-disk DB away from upstream's
migrations. Sealed sessions are throwaways that never outlive the server.

**Client-side consequence:** the stock PATCH payload schema **ignores unknown
keys** (Effect Schema strips excess properties; measured against the unpatched
1.18.9 release build and asserted on every integration run). So ClaudeUI sends
`permissionHermetic` unconditionally with **no fork detection** — an unpatched
server simply drops it.

## ClaudeUI side

| File | Role |
| ---- | ---- |
| `src/main/opencode/judge-transport.ts` | direct P1 transport + `/doc` probe + fallback to the session judge |
| `src/main/opencode/OpencodeSession.ts` | `SEALED_THROWAWAY_PATCH`; `makeJudgeFn` prefers the endpoint, `makeSessionJudgeFn` is the fallback |
| `src/main/opencode/agent-generate.ts` | seals its throwaway session |
| `scripts/ensure-opencode.mjs` | clone → build → vendor; `--from-release` falls back to the unpatched upstream tarball |

The judge transport probes **`GET /doc`**, never a speculative `POST`. An
unpatched opencode does not 404 on an unknown path — it serves the web UI (`200
text/html`) or, without an embedded UI, **proxies the request to
`app.opencode.ai`**. Probing by POST would ship the judge prompt, transcript
included, to a third party.

## Bump protocol (ADR-037 §3)

```bash
cd .cache/opencode-fork                       # the pipeline's own clone
git fetch upstream --tags
git tag -l "v1.*" --sort=-v:refname | head    # newest release tag
```

1. **Check the licence first.** `git diff <old> <new> -- LICENSE` and the
   `license` fields in `package.json` / `packages/opencode/package.json`. Any
   move off MIT freezes us on the last acceptable version — stop and escalate.
2. **Stop conditions.** If `packages/opencode/src/permission/` has lost the v1
   tool path (the v2 schema is already staged upstream), P2 is a redesign, not a
   conflict resolution — stop and escalate. Same for a rewrite of the
   `HttpApiBuilder.group` / `addHttpApi` registration shape.
3. **Merge the tag** (not `dev`) into `claudeui`. Expect conflicts *only* in the
   `version` field of every `package.json` plus `bun.lock` — the release commit
   bumps them all. Resolve with `--theirs`.
4. **Watch for real drift** in: `Provider.Service` (`getModel` / `getLanguage`
   signatures), `ProviderTransform` (`smallOptions`, `maxOutputTokens`,
   `providerOptions`), the `chat.params` / `chat.headers` hooks (a new
   drop-the-cap provider means a new line in `rejectsOutputCap`), and
   `Permission.ask`'s `evaluate(...)` call.
5. **Re-verify behaviourally — apply-success is not correctness:**
   ```bash
   bun test test/permission/hermetic.test.ts        # in the fork clone
   bun run ensure-opencode -- --force               # rebuild + re-vendor
   OPENCODE_INTEGRATION_TESTS=1 bunx vitest run --project integration
   python patch/opencode-fork/live-judge.py vendor/opencode-cli/opencode.exe
   ```
   The live-fire step is not optional: it is the only thing that exercises the
   provider transports, and it is where both P1 regressions were caught.
6. Bump `package.json#opencodeCliVersion` and `opencodeFork.tag`, then confirm
   `vendor/opencode-cli/version.json` records the new `fork.commit`.

## Build environment notes (Windows)

`scripts/ensure-opencode.mjs` handles all three of these automatically; they are
recorded because they are non-obvious if the pipeline is ever rebuilt.

- **bun version.** opencode's build scripts hard-require the `packageManager`
  version in their root `package.json`. Rather than force a global `bun
  upgrade`, the script drops a pinned standalone bun in `.cache/bun-<version>/`.
  It extracts with PowerShell `Expand-Archive`, **not** `tar` — Windows bsdtar
  reads `D:\...` as `host:path`.
- **`tree-sitter-powershell`.** Its node-gyp postinstall fails without a matching
  MSVC toolchain *and aborts the rest of `bun install`*, leaving a half-extracted
  `node_modules` (an `effect` package containing only `dist/`) whose eventual
  build error points nowhere near the cause. opencode only imports that
  package's prebuilt `.wasm`, so the script temporarily untrusts it.
- **Replacing a running binary.** A live ClaudeUI holds two `opencode serve`
  children open on `vendor/opencode-cli/opencode.exe`, so `rename(tmp, dest)`
  fails `EPERM`. The script renames the *old* file out of the way first (allowed
  on Windows even while running) and sweeps the leftovers next run.
- **Clone refresh.** `bun install` rewrites `bun.lock` in the cache clone, so the
  refresh path uses `git checkout -f` before `reset --hard`. It never runs `git
  clean` — that would delete the cached `node_modules` and make every run a cold
  install.

## Verification assets

| Script | What it answers |
| ------ | --------------- |
| `live-judge.py <binary> [provider/model ...]` | does the judge endpoint return real text on an API-key provider AND a Codex-OAuth model? |
| `probe-patch-schema.py <binary>` | does this build's session PATCH schema reject unknown fields? (run against a `--from-release` binary to re-confirm the no-gating assumption) |

Automated coverage: `packages/opencode/test/permission/hermetic.test.ts` in the
fork (the P2 piercing, end to end through real `ask`/`reply`);
`src/main/opencode/__tests__/judge-transport.test.ts` and the
`OpencodeSession` / `agent-generate` suites in ClaudeUI;
`src/integration/opencode/opencode-judge.integration.test.ts` and
`opencode-hermetic.integration.test.ts` against the built binary.
