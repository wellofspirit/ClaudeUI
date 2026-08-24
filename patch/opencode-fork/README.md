# Patch set: opencode fork (`claudeui` branch)

ClaudeUI's opencode patches, unlike the `cli.js` ones in the sibling directories,
are **source patches on a git fork**, not surgery on a minified bundle. There is
no `.patch` file to re-anchor: the patches live as commits on
`github.com/wellofspirit/opencode` branch `claudeui`, and `scripts/ensure-opencode.mjs`
clones that branch, builds it with opencode's own release pipeline, and vendors
the binary into `vendor/opencode-cli/`.

Policy: **ADR-037** — fork + patch, narrow diffs, **never upstream**.

## Affected component

| Component   | Value                                                                   |
| ----------- | ----------------------------------------------------------------------- |
| Upstream    | `github.com/sst/opencode` (MIT)                                         |
| Fork        | `github.com/wellofspirit/opencode`, branch `claudeui`                   |
| Forked from | tag `v1.18.9`, currently merged up to **`v1.18.10`**                    |
| Pinned by   | `package.json#opencodeCliVersion` + `package.json#opencodeFork`         |
| Provenance  | `vendor/opencode-cli/version.json` (`source`, `fork.commit`, `builtAt`) |

Upstream's release branch is **`dev`**, not `main`. Release tags (`vX.Y.Z`) are
CI commits created _on top of_ `dev` and never merged back, so `git merge-base
--is-ancestor v1.18.10 origin/dev` is **false**. Bump by merging the _tag_, not
the branch.

## The patches

### P1 — `POST /judge/completion` (tool-less completion)

**Files:** `groups/judge.ts` (new), `handlers/judge.ts` (new), `api.ts` (+2),
`server.ts` (+2), all under
`packages/opencode/src/server/routes/instance/httpapi/`.

**Why.** ClaudeUI's auto-mode judge reads attacker-influenced transcript text and
returns a verdict. Routing that through `POST /session/{id}/message` forces a
real session with a tool registry and a permission ruleset, so "the model called
a tool" is a state we can only _deny_, never make unreachable — and the session
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
  → 200 { text, usage? }        (usage added by P3)
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
**instance-global** state, _not_ keyed by sessionID, and `evaluate()` appends
that list **after** the session's own ruleset with `findLast`-wins. So the
deny-all ClaudeUI patches onto every throwaway session is outranked by any
pattern the user ever always-approved anywhere on that server. Prompt-inject the
judge into proposing such a command and it executes, with no human in the loop.

**What.** `permissionHermetic?: boolean` on the session PATCH payload. A sealed
session is evaluated against its own ruleset **alone**, and is also a _sink, not
a source_: an "always" answered inside it never widens the instance for anybody
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

### P3 — prompt caching on the judge system prompt

**Files:** `packages/opencode/src/provider/transform.ts` (+2 exports, one
behaviour-preserving extraction), `.../httpapi/groups/judge.ts` (+optional
`usage` on the response), `.../httpapi/handlers/judge.ts`.

**Why.** A judge call is ~24 KB of policy that is identical for the whole
session plus a small transcript that is different every time — the textbook
prompt-cache shape, and P1 was getting none of it. Every classification paid
full input price on the same document.

**Anchor points.** The session path's cache machinery is
`ProviderTransform.applyCaching`, reached from `ProviderTransform.message` —
_message middleware_, which the judge route deliberately does not run. It holds
two things worth reusing: the marker set (which provider slug reads
`cacheControl` / `cachePoint` / `cache_control` / `copilot_cache_control`) and
the gate deciding who takes explicit markers at all. Both are now exported as
`cacheMarkers()` and `usesCacheMarkers(model, options)`, with `message()`
calling the latter — a pure extraction, upstream behaviour unchanged, verified
by the 397 tests in `test/provider/transform.test.ts`. On a bump, expect the
conflict here to be upstream adding a provider to the marker set; take both.

_(An earlier read of this ground pointed at a `cacheControlFormat` capability
flag. That field is **pi's** — `vendor/pi-cli/docs/models.md` — not opencode's.
opencode has no capability bit for this; the decision is the provider heuristic
above.)_

**System-only markers.** `applyCaching` marks up to four breakpoints: two system
messages and the last two non-system messages. The tail markers exist because a
session replays a growing conversation whose _prefix_ keeps extending. A judge
call has no tail worth marking — the user turn is a fresh transcript every call,
so a breakpoint there can never hit, and Alibaba caps breakpoints at four. So
the judge marks the system message and nothing else. Attaching a marker means
the route now passes `messages` rather than `system` + `prompt`: the string form
has nowhere to hang `providerOptions`.

**Byte-stability — the requirement automatic caching imposes.** OpenAI
Responses (and its Codex/ChatGPT OAuth cousin) caches by hashing the leading
bytes of the request; there is nothing to mark and nothing to opt into. The only
thing the route can do is not defeat it, and that is a real constraint:
**everything ahead of the user turn must be byte-identical between calls.** It
holds because the judge uses `ProviderTransform.smallOptions` (a pure function
of the model), _not_ `ProviderTransform.options` (which injects `sessionID` as
a cache key), and because `instructions` is `payload.system` verbatim. One thing
did violate it — the `session-id` header, which was a per-call random string and
is a routing/affinity key — and is now a hash of the system prompt. The same
hash is passed as `promptCacheKey` / `prompt_cache_key` to the providers whose
`setCacheKey` block in `ProviderTransform.options` expects one.

The corollary lands on **the caller**: a system prompt that is not byte-stable
costs full price on every call and reports no error anywhere. ClaudeUI's
`buildPolicyPrompt` is deterministic given its `EnvironmentInfo`, pinned by
`buildPolicyPrompt — byte-stability` in
`src/main/automode/__tests__/rules.test.ts`.

**Contract.** The request payload is **unchanged** — caching is capability- and
content-driven, so there is no `cache?: boolean` to pass and nothing for an
older client to set. The response gains an optional `usage`
(`inputTokens`, `outputTokens`, `totalTokens`, `reasoningTokens`,
`cacheReadInputTokens`, `cacheWriteInputTokens`; same vocabulary as
`session/llm/ai-sdk.ts`, every field absent when the provider does not report
it). Purely additive: `judge-transport.ts` reads `text` and ignores the rest.
`cacheReadInputTokens` is the only in-band evidence that any of this works.

**Measured** (`live-judge-cache.py`, 5 calls, identical 23,957-byte system
prompt, different user turn each call, fork `163b5762`):

| model                          | call 1        | calls 2–5               | input tokens |
| ------------------------------ | ------------- | ----------------------- | ------------ |
| `openai/gpt-5.6-luna`          | `cacheRead 0` | `cacheRead 3840` (77 %) | 4958         |
| `alicloud/qwen3.8-max-preview` | `cacheRead 0` | `cacheRead 4224` (82 %) | 5131         |

Latency (1.0–3.8 s) is noise at this size and proves nothing on its own — which
is exactly why `usage` was added. The `--vary-system` negative control drives
both back to `cacheRead 0`, confirming the metric is prefix-keyed and not a
constant the provider echoes.

## ClaudeUI side

| File                                   | Role                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/main/opencode/judge-transport.ts` | direct P1 transport + `/doc` probe + fallback to the session judge                                 |
| `src/main/opencode/OpencodeSession.ts` | `SEALED_THROWAWAY_PATCH`; `makeJudgeFn` prefers the endpoint, `makeSessionJudgeFn` is the fallback |
| `src/main/opencode/agent-generate.ts`  | seals its throwaway session                                                                        |
| `scripts/ensure-opencode.mjs`          | clone → build → vendor; `--from-release` falls back to the unpatched upstream tarball              |

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
3. **Merge the tag** (not `dev`) into `claudeui`. Expect conflicts _only_ in the
   `version` field of every `package.json` plus `bun.lock` — the release commit
   bumps them all. Resolve with `--theirs`.
4. **Watch for real drift** in: `Provider.Service` (`getModel` / `getLanguage`
   signatures), `ProviderTransform` (`smallOptions`, `maxOutputTokens`,
   `providerOptions`, `applyCaching`'s marker set and provider gate, the
   `setCacheKey` block in `options()`), the `chat.params` / `chat.headers` hooks
   (a new drop-the-cap provider means a new line in `rejectsOutputCap`), and
   `Permission.ask`'s `evaluate(...)` call.
5. **Re-verify behaviourally — apply-success is not correctness:**
   ```bash
   bun test test/permission/hermetic.test.ts        # in the fork clone
   bun run ensure-opencode -- --force               # rebuild + re-vendor
   OPENCODE_INTEGRATION_TESTS=1 bunx vitest run --project integration
   python patch/opencode-fork/live-judge.py vendor/opencode-cli/opencode.exe
   python patch/opencode-fork/live-judge-cache.py vendor/opencode-cli/opencode.exe
   ```
   The live-fire step is not optional: it is the only thing that exercises the
   provider transports, and it is where both P1 regressions were caught. The
   cache run is the only thing that catches a _silent_ P3 regression — a lost
   marker or a newly injected per-call value costs money and breaks nothing.
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
  MSVC toolchain _and aborts the rest of `bun install`_, leaving a half-extracted
  `node_modules` (an `effect` package containing only `dist/`) whose eventual
  build error points nowhere near the cause. opencode only imports that
  package's prebuilt `.wasm`, so the script temporarily untrusts it.
- **Replacing a running binary.** A live ClaudeUI holds two `opencode serve`
  children open on `vendor/opencode-cli/opencode.exe`, so `rename(tmp, dest)`
  fails `EPERM`. The script renames the _old_ file out of the way first (allowed
  on Windows even while running) and sweeps the leftovers next run.
- **Clone refresh.** `bun install` rewrites `bun.lock` in the cache clone, so the
  refresh path uses `git checkout -f` before `reset --hard`. It never runs `git
clean` — that would delete the cached `node_modules` and make every run a cold
  install.
- **Pushing to the fork.** The fork's husky `pre-push` hook runs `bun typecheck`
  over all 30 packages and refuses a bun older than the pinned
  `packageManager` — so push with `.cache/bun-<version>` first on `PATH`, from
  a clone whose `node_modules` actually has `tsgo.exe` (a scratch clone built
  with the wrong bun can be missing it, and the failure reads as a bare
  `spawnSync … ENOENT`). The hook also fails for a reason that has nothing to do
  with your change: `core.symlinks=false` on Windows checks out
  `packages/{app,enterprise}/src/custom-elements.d.ts` as _text files
  containing a path_, which `tsgo` rejects with `TS1128`. Copy
  `packages/ui/src/custom-elements.d.ts` over both and the hook passes; the next
  `ensure-opencode` resets them. Do not reach for `--no-verify` — the hook is
  the only typecheck the fork gets.

## Verification assets

| Script                                                                 | What it answers                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live-judge.py <binary> [provider/model ...]`                          | does the judge endpoint return real text on an API-key provider AND a Codex-OAuth model?                                                                                                                                                                |
| `live-judge-cache.py <binary> [--calls N] [--vary-system] [model ...]` | is the ~24 KB system prompt actually served from the provider's prompt cache from call 2 on? Renders ClaudeUI's real policy through `buildPolicyPrompt` and asserts its byte-stability before spending a token; `--vary-system` is the negative control |
| `probe-patch-schema.py <binary>`                                       | does this build's session PATCH schema reject unknown fields? (run against a `--from-release` binary to re-confirm the no-gating assumption)                                                                                                            |

Automated coverage: `packages/opencode/test/permission/hermetic.test.ts` in the
fork (the P2 piercing, end to end through real `ask`/`reply`);
`src/main/opencode/__tests__/judge-transport.test.ts` and the
`OpencodeSession` / `agent-generate` suites in ClaudeUI;
`src/integration/opencode/opencode-judge.integration.test.ts` and
`opencode-hermetic.integration.test.ts` against the built binary.
