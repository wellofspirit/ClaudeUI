# ADR-081: ClaudeUI makes the opencode and pi auto-mode judge's model call itself, and the opencode fork is retired

**Status:** Accepted (2026-09-28; owner rulings of the same day, one open item in §5). Implementation is arc 1 of the 3.6
line on branch `harnesses`. §4's output cap is amended by
[ADR-083](adr-083_judge-policy-rebalance-and-permission-context.md) (2026-09-29).
**Supersedes:** [ADR-037 (engine fork patch policy)](adr-037_engine-fork-patch-policy.md) §1 and
its opencode bump protocol (§3). Its §2, "pi: extend, don't patch", stands.
**Amends:** [ADR-023](adr-023_opencode-automode-classifier.md) (the judge no longer runs through
opencode, and `maxTokens` / `stopSequences` stop being advisory),
[ADR-071](adr-071_metering-ledger-and-window-value.md) (a fourth `origin`, `judge`),
[ADR-072](adr-072_usage-hub-self-hosted-sync.md) (the hub carries it).
**Relates to:** [ADR-074](adr-074_provider-surfaces-v3.md) (shared providers and vault keys, which
supply the credentials), [ADR-068](adr-068_chatgpt-identity-vault-owned-codex-injection.md) (the
ChatGPT token), [ADR-082](adr-082_harness-sources-downloads-and-unbundling.md) (why engine-version
independence matters now).

## Context

`classify()` in `src/core/automode/classifier.ts` already runs in ClaudeUI. It builds the policy
prompt, decides the stage, parses the verdict and applies the denial caps. The only part the engines
do is one model call with no tools, through `JudgeTransport = (req) => Promise<string>`.

That one call costs a lot:

- **opencode** needs the fork's `POST /judge/completion` (P1), with P2 and P3 behind it, rebuilt from
  source on every bump with a pinned bun. Without the fork, the session fallback prepends opencode's
  own coding-agent prompt, the environment block and the project's `AGENTS.md`/`CLAUDE.md` to the
  security judge's system prompt (`session/llm/request.ts:58-63` upstream). It also snapshots the
  project on every call, and turns a provider error into an empty reply, which `classify()` reads as
  a BLOCK.
- **pi** keeps a second warm `pi --mode rpc --no-tools …` process per session (`pi-judge.ts`). It
  ignores `maxTokens` and `stopSequences`, and has to re-send `set_model` after every `new_session`
  because pi 0.84.3 resets the model.
- Neither path records the judge's tokens. Judge spend is missing from the usage dashboard.
- ADR-082 lets users run their own opencode and pi. A judge that depends on engine internals would
  then depend on versions ClaudeUI never tested.

JudgEval (`src/providers.ts`, 276 lines, no dependencies) already showed that a one-turn judge
transport is small.

## Decision

### 1. Scope

ClaudeUI's main process makes the judge's model call for opencode and pi sessions, with plain
`fetch` and no SDK. The owner ruled the AI SDK "too much code for too little gain". Everything else
in the auto-mode pipeline is unchanged. Out of scope: Claude Code (cli.js runs its own classifier),
Codex (native guardian, ADR-067), `/btw` and agent-generate (not security judges; they keep their
deny-all throwaway sessions).

### 2. Routes

The judge model is `autoMode.judgeModel`, or the session's own model when unset, as today. It is a
`<provider>/<model>` string in the engine's own ids. The resolver maps it to a shared provider
definition using the ownership rule `decorateSharedProviderClaims` already uses: the definition whose
delivered route for that engine is enabled and whose native provider id equals the string's provider
id.

| Route                | Recognised by                                                                         | Wire                | Endpoint                                            | Credential                                                                           |
| -------------------- | ------------------------------------------------------------------------------------- | ------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| ChatGPT subscription | definition `chatgpt` (opencode `openai` with the ChatGPT route on, pi `openai-codex`) | Responses, streamed | `https://chatgpt.com/backend-api/codex/responses`   | `credentialSync.injectionTokenFor(null)`, the active account the engines also run on |
| OpenAI API key       | vault-backed catalog `openai`                                                         | Chat completions    | the engine catalog's base URL, `…/chat/completions` | `authVault.loadCredential(id)`                                                       |
| OpenRouter key       | vault-backed catalog `openrouter`, or a custom definition derived from it             | Chat completions    | the catalog or definition base URL                  | vault key                                                                            |
| Custom endpoint      | custom definition, protocol `openai-completions`                                      | Chat completions    | `baseUrl` + `/chat/completions`                     | vault key, or none for a keyless endpoint                                            |
| Custom endpoint      | custom definition, protocol `openai-responses`                                        | Responses           | `baseUrl` + `/responses`                            | vault key                                                                            |

A catalog provider's base URL comes from the engine's catalog, because ClaudeUI stores none for it:
`getOpencodeProviderModels` (`apiUrl`) or `getPiModelCatalog()` (`baseUrl`). The resolver runs per
call, so a rotated key or a newly refreshed token applies to the next call. Keys and tokens never
leave the main process. Nothing about them is logged except the account label.

Anthropic OAuth is never used. The owner ruled OpenAI's OAuth fine to use directly.

### 3. No fallback

A judge model that no route covers gets no judge. Examples: Copilot, pi's own OAuth vendors, keys
added outside ClaudeUI, Anthropic, Google, Bedrock. Every gated action goes to the human, and the
session shows one banner saying why and linking to the judge picker. The judge picker marks the
models it can't call directly and says so, the same way `judgeModelUnavailable()` reports a removed
model today. The engine transports are deleted, not kept as a fallback.

### 4. Wire rules

Both wires stream. There is one SSE accumulator per wire. A stream that ends without a terminal
event, a mid-stream error event, or an empty text channel is a transport error, so `classify()`
returns `unavailable` and the human decides. There are no retries, except one on an HTTP 401 from
the ChatGPT backend, after a forced token refresh.

**Responses (ChatGPT backend).**

- Headers: `Authorization: Bearer`, `ChatGPT-Account-Id`, `originator: opencode`, `User-Agent`,
  `session-id`. The vault's token is issued to opencode's OAuth client (`codex-oauth.ts:35`), so
  the originator matches it. `x-openai-internal-codex-residency` is added when the token's
  `chatgpt_compute_residency` claim is set.
- Body: `model`, `instructions` (the system prompt, verbatim), one `input` user item,
  `store:false`, `stream:true`, `include:["reasoning.encrypted_content"]`, `prompt_cache_key`,
  `reasoning:{effort}` and `text:{verbosity:"low"}`.
- It never sends `max_output_tokens`, `stop` or `temperature`. The backend rejects the first at any
  value, and the Codex CLI's request type has none of the three (`codex-rs/core/src/client.rs:319-336`).
- `session-id` and `prompt_cache_key` are both `judge-` plus the first 32 hex characters of
  SHA-256(system prompt), so every call in a session hits the same cache.
- The output cap and stop sequence are enforced on the client. The accumulator cuts the text at the
  stop string and keeps reading to `response.completed` so the usage arrives. A hard character
  budget, derived from `maxTokens`, aborts a runaway stream.
- Reasoning effort is `none` where the model allows it for stage 1, `low` for stage 2
  ([ADR-083](adr-083_judge-policy-rebalance-and-permission-context.md) §2 measured `low` for stage 1
  and kept the floor: no accuracy gain, slower tail).

**Chat completions.** Each route declares its capabilities, instead of scattering model checks:

- OpenAI:
  - A reasoning model is one matching `^o\d`, or `gpt-N` with N ≥ 5 and no `-chat` suffix.
  - Cap field `max_completion_tokens`. It counts reasoning tokens, so a reasoning model gets 2048
    tokens of headroom on top of the stage's budget (ADR-083 §2). The client-side text cap is unchanged.
  - `stop` only for non-reasoning models.
  - `temperature: 0` only for non-reasoning models, or gpt-5.1 and later with `reasoning_effort:"none"`.
  - The system message goes in the `developer` role for reasoning models.
  - Also: `store:false`, `prompt_cache_key`, `stream_options:{include_usage:true}`.
- OpenRouter:
  - Cap field `max_tokens`, `stop`, and `temperature: 0` except for Claude models.
  - `reasoning:{enabled:false}` when the catalog marks the model as reasoning. Without it,
    reasoning models spend the whole budget thinking and return empty text, which the fork hit.
  - `usage:{include:true}`, so the response reports the real cost.
  - `cache_control` on the system content part for `anthropic/*` models.
  - `HTTP-Referer` and `X-Title` headers naming ClaudeUI.
- Custom `openai-completions`: `max_tokens`, `stop`, `temperature: 0`, and nothing
  provider-specific.

Every byte ahead of the user turn is stable between calls: no timestamps, no request ids.
`buildPolicyPrompt`'s byte-stability test already pins the prompt.

`JudgeRequest` gains an optional `signal`. `classify()` passes a stage-timeout signal, so a timed-out
stage aborts its request instead of leaving it running.

### 5. Usage

Every judge HTTP response that reports usage writes one `usage_event` through `recordUsageEvent`,
inside the transport. The row records whatever usage the provider reported before the call completed
or was aborted.

| Field                        | Value                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `engineId`                   | the judged session's engine (`opencode` or `pi`)                                                            |
| `vendorId`, `modelId`        | the judge model's provider and model ids, as the engine names them                                          |
| `origin`                     | `judge`                                                                                                     |
| `sessionId`                  | the judged session's engine id (`openSessionId` / `piSessionId`)                                            |
| `parentRoutingId`            | the judged session's routing id                                                                             |
| `messageId`                  | `judge:<uuid>`, globally unique because the hub is idempotent on it                                         |
| `accountKey`, `accountLabel` | API key: `apiKeyAccountKey(vendorId, key)`. ChatGPT: `credentialSync.accountIdentity(token.vaultAccountId)` |
| `billingType`                | `subscription` for ChatGPT, `apiKey` otherwise                                                              |
| `engineCostUsd`              | OpenRouter's `usage.cost`, otherwise null                                                                   |
| `tokens`                     | disjoint counts, as `codexDisjointTokens` builds them                                                       |

The dashboard labels judge spend the way it labels dispatched spend. `asOrigin` in the hub client
learns `judge`. The deployed hub accepts any origin string today, so it needs no change.

A client older than 3.6 folds `judge` into `session` when it pulls peers' buckets. It then
overwrites, rather than adds to, a colliding session bucket, so its "all machines" view undercounts
until it updates. **Pending owner ruling:** accept that (the default proposed here, since only the
owner's own machines run older builds), or bump the hub schema so old clients get unknown origins
folded into `session` by summing, or record judge rows as `origin: 'child'` instead.

The price table stops matching `gpt-4.1*` and `o3-pro` against the older `gpt-4` / `o3` entries.
Today `gpt-4.1-mini` on vendor `openai` is priced at `gpt-4`'s $30/$60 per MTok, which already
affects opencode rows and would hit judge rows directly.

### 6. Network

Today the judge inherits `HTTP(S)_PROXY` because the engines do. The new transport keeps that
behaviour. When a proxy variable is set, it uses undici's `fetch` with `EnvHttpProxyAgent`, both
from the already-declared `undici` dependency so no dispatcher crosses packages. Otherwise it uses
the global `fetch`.

### 7. The fork is retired

- `ensure-opencode` vendors the upstream npm release (`opencode-<os>-<arch>`), checked against a
  SHA-256 reviewed into the repo. The source build, the pinned bun download and the `opencodeFork`
  block in `package.json` go.
- `judge-transport.ts`, the `permissionHermetic` field and its three call sites, `pi-judge.ts`, and
  the fork's integration tests are deleted. `patch/opencode-fork/` is deleted too; this ADR and
  ADR-037 keep the history.
- Upstream v1.18.32 already hides every tool from a deny-all session's request
  (`session/llm/request.ts:208-214`), so `/btw` and agent-generate stay safe without P2.
- `autoupdate: false` stays in `OPENCODE_CONFIG_CONTENT`, with a new reason: a ClaudeUI-spawned
  server must not replace a binary under a running session.

## Verification

Arc 1 is not done until:

- The unit tests cover each wire's request body and each SSE failure shape against a mock server.
- A guard test shows the old session judge's provider-error-becomes-BLOCK defect, and that the new
  transport sends the action to the human instead.
- One live call per route succeeds, using entry-level models and free OpenRouter models only.
- A parity run of JudgEval's 41 scenarios through the new transport gives verdicts that match the
  current engine path within the bench's own run-to-run noise.

## Consequences

- opencode is an ordinary upstream binary again. Bumps are a version and a digest.
- The judge prompt is exactly the policy, and the token budgets and the stage-1 stop sequence apply
  where the provider allows them.
- Judge spend appears on the dashboard, attributed to the account that paid for it.
- Users whose judge model isn't covered lose auto-approval until they pick one that is. The banner
  and the picker say so.
- ClaudeUI now owns provider quirks the engines used to absorb. §4 lists the known ones. A provider
  that changes its API breaks the judge and fails closed to the human, without breaking the session.

## Rejected alternatives

- **Keep the fork.** Every opencode bump is a source build and a patch re-derivation, and the fork
  can't serve a user's own opencode (ADR-082).
- **Upstream opencode plus a ClaudeUI plugin** (`chat.params` for the cap,
  `experimental.chat.system.transform` to clean the prompt, a scratch-directory judge server). It
  works on paper, but it depends on an experimental hook, needs an extra server process, and does
  nothing for pi.
- **Fall back to the engine transport for routes ClaudeUI can't call.** Keeps the defects this ADR
  removes, and doubles the test matrix. The owner ruled no fallback.
- **The AI SDK.** Many packages to guard against supply-chain risk for two wire formats.
