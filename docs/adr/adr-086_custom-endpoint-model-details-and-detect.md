# ADR-086 — Custom endpoints: per-model limits and capabilities in the form, filled by Detect from vLLM and SGLang

**Status:** Implemented (2026-09-30, branch `endpoint-model-details`, S1 `37d091cb` + S2 `673fa304` —
see § As built); accepted 2026-09-30, owner-ruled from mockup `3fdf1efe` (Option A).
**Amends:** [ADR-074](adr-074_provider-surfaces-v3.md) §7 (the Manage sheet's "Endpoint (custom)"
now edits each model's context window, max output, vision and reasoning) and §11 (opencode receives
custom models' capabilities; this ADR is how a user sets them)
**Relates to:** [ADR-065](adr-065_settings-ia-v2-pages-groups-row-vocabulary.md) (row vocabulary,
the Add sheet), [ADR-027](adr-027_test-data-attributes.md) (testids),
[ADR-036](adr-036_unified-auth-vault.md) (the vault key Detect uses when editing),
[ADR-052](adr-052_remote-auth-passkeys-capabilities.md) (the capability grants that gate the probe)

## Context

Add provider → **Custom endpoint** saves a shared `kind: 'custom'` definition. `SharedProviderModel`
already carries `reasoning`, `vision`, `contextWindow` and `maxTokens`; the repository validates them
and both adapters project them into opencode's config and pi's `models.json`. But the form
(`ProviderForm.tsx`) only ever edited a model's id and display name, and the Manage sheet hides
opencode's own model editor for custom definitions on the grounds that their models are "edited in
its endpoint", which they were not. Nothing in the UI could set the fields, and the gap was never a
regression: the vault form that preceded ADR-065 lacked them too.

What a blank model costs, verified at source (`vendor/opencode-src`, pi adapter):

- **opencode** receives `limit { context: 0, output: 0 }`. `context === 0` switches overflow detection
  off (`session/overflow.ts:29`), so a custom endpoint never auto-compacts; it fails when the window
  fills. `attachment`/`reasoning` are false: no image paste, no effort control.
- **opencode's output fallback** is `OUTPUT_TOKEN_MAX` (32,000) when `limit.output` is 0
  (`provider/transform.ts:1469`), and usable context is `context − maxOutput` (`overflow.ts:10-19`).
  Setting a context alone is therefore worse than setting nothing: a 32,768-token model with a blank
  output leaves about 768 usable tokens, so opencode compacts every turn, and vLLM rejects any request
  whose `max_tokens + input` exceeds `max_model_len`.
- **pi** falls back to 128,000 context and 16,384 output (`PiSharedProviderAdapter.ts`), too large
  for a small local model and too small for a long-context one.

The owner runs self-hosted endpoints on **vLLM** and **SGLang**. Both report more than a bare model
list (verified at upstream source, 2026-09-30):

| Server | Request                                            | What it reports                                                                        |
| ------ | -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| vLLM   | `GET {base}/models`                                | `id`, `owned_by: "vllm"`, `max_model_len`, `root`, `parent`                            |
| SGLang | `GET {base}/models`                                | `id`, `owned_by: "sglang"`, `max_model_len`, `root`, `parent`                          |
| SGLang | `GET {root}/model_info` (older: `/get_model_info`) | `has_image_understanding`, `reasoning_parser`, `tool_call_parser`, `served_model_name` |

Neither reports a maximum output. vLLM reports nothing about vision or reasoning outside its dev mode.
OpenAI and OpenRouter, added as **catalog** providers, already carry full metadata from models.dev
(opencode) and pi's own model table; a plain OpenAI `/v1/models` returns ids only.

## Decision

### 1. The custom-endpoint form edits every model's details (Option A)

Each model row keeps id, display name and Remove, and gains a chevron. Collapsed, a chip line
summarises the row: `{n} context` or `context: default`, `{n} output` or `output: default`,
`vision` / `text only`, `reasoning`. Expanded, the row edits Context window and Max output (numbers;
clearing one means "the engine's default") and Vision and Reasoning (switches). The same form serves
Add provider → Custom endpoint and the Manage sheet's Edit endpoint, so both get it at once.

A dense grid (Option B in the mockup) was rejected: it suits a server with many models, but a
SGLang process serves one base model and a vLLM endpoint usually one to three, and the grid had no
room for the per-field explanation the limits need.

### 2. Every value shows where it came from

A badge beside each field: **server** (read from the endpoint and unchanged), **suggested** (worked
out by ClaudeUI, never reported), **manual** (the user's value), **default** (blank, the engine's
default applies). The badge is computed against a per-model `detected` record that holds what the
last Detect read or suggested. `detected` is a ClaudeUI field only: neither adapter projects it, and a
guard test proves the projection is byte-identical with and without it.

### 3. Detect: a button, never automatic

Beside the Base URL, **Detect** asks the endpoint what it serves. It runs only when pressed, so a
half-typed URL never fires requests. The host performs the request (`shared-provider:probe`):

- `GET {base}/models`; the server kind is read from `owned_by` (`vllm`, `sglang`, otherwise
  "OpenAI-compatible"), and `max_model_len` becomes the context window whatever the kind.
- For SGLang, `GET {root}/model_info` (falling back to `/get_model_info`), where `{root}` is the base
  without its trailing `/v1`: `has_image_understanding` → vision, a non-null `reasoning_parser` →
  reasoning, applied to every model the process serves (LoRA adapters share their base). A null
  `tool_call_parser` is shown as a warning (agents cannot call tools through it), not stored. If
  `/model_info` cannot be read, Detect still succeeds with the context alone and says so.
- On a fresh Add whose model rows are all blank, the served models fill the list directly;
  otherwise **Import served models (N new)** adds the ones not yet listed, and a listed model the
  server no longer serves is marked "not served by this endpoint".

### 4. A suggested max output always accompanies a detected context

Because a context without an output is the harmful case above, a detected context brings a
suggested max output of `min(32,768, floor(context / 4))`, badged **suggested**. Independently of
Detect, a row warns when its effective output (its own value, or the largest default among the
engines it is enabled for: opencode 32,000, pi 16,384) exceeds half its context, with a one-click
**Set {suggestion}**.

### 5. Detect again never overwrites the user silently

A later Detect fills fields that are still blank. A value equal to the server's reading only
refreshes the baseline. Every other difference becomes a pending change, listed as
`{model} {field} {from} → {to}` (marked "you edited this" when the current value is the user's), with
**Apply** and **Ignore**. Nothing persists until the sheet's existing Save.

The suggested max output is the exception, because it is ClaudeUI's number, not the server's: it
fills a blank, and it enters the diff only while the current value is still the suggestion and the
context has moved. A max output the user typed is never offered a replacement; the output warning
(§4) is what speaks up if it no longer fits.

### 6. The probe is host-side, capability-gated, and never returns a key

`shared-provider:probe` carries the `config` capability, the same as saving a provider: it makes the
host fetch a user-supplied URL, so a remote session that cannot configure providers must not be able
to use the host as a fetch proxy into its network. Each request has a 5-second timeout, follows no
redirect (a 3xx is reported with its target), and reads at most 2 MiB. The key is the one being typed,
or, when editing, the vault's key looked up host-side by provider id — but only for an existing
custom definition, and only when the typed URL has the same origin as the definition's saved Base URL.
Otherwise the probe runs without a key and a failure says the saved key was withheld. Without that
rule, any provider id (a catalog provider such as OpenRouter) could send its key to any typed address,
a reach `config` does not otherwise have over catalog keys. The key is sent as a Bearer token
(plus `x-api-key` for the Anthropic-messages protocol) and appears in no result, error or log line.
The result discriminates on `status` (`detected` | `failed`, with a failure reason), never on an
`ok` key.

## Consequences

- A custom endpoint on opencode compacts on time, takes images when the model does, and exposes
  effort control for a reasoning model; on pi it stops inheriting a 128K/16K guess.
- For vLLM and SGLang the common case is Base URL → Detect → Save. Other OpenAI-compatible servers
  get their model ids imported and the limits typed by hand.
- The saved definition grows a `detected` record per model. It is validated on load like every other
  field and ignored by both adapters, so engine files do not change unless a visible value changed.
- `ProviderSheet`'s rule that opencode's model editor is hidden for custom definitions becomes true
  as written: their details are edited in the endpoint form.

## As built

- **Where it lives.** The probe is `src/core/shared-providers/endpoint-probe.ts`, reached through
  `SharedProviderService.probeEndpoint` and `shared-provider:probe`. Every rule about filling, badges,
  the diff and the warning is a pure function in `src/shared/endpoint-detect.ts` (`modelFromProbe`,
  `fieldSource`, `mergeProbe`, `liveChanges`, `applyChanges`, `importModels`, `outputWarning`,
  `suggestMaxOutput`), and `ProviderForm.tsx` only renders their outcome.
- **Found in review, now part of the decision:**
  - A max output the user typed never enters the diff (§5). The first build re-offered the
    suggestion over it on every Detect.
  - The stored key is sent only for an existing custom definition at the same origin (§6). The first
    build accepted any provider id, a catalog one included. A failure then carries `keyWithheld`.
  - The diff shows only changes that still hold (`liveChanges`), and Apply skips stale ones, so a
    value typed after the diff is never overwritten. The real-app verifier found this: Apply had
    written a stale suggestion over a hand edit.
  - Changing the Base URL or the protocol clears the last result, and an answer arriving after such
    a change is dropped, so one server's models are never imported into another endpoint.
  - The Import offer is computed live (served ids minus listed ids), so removing a served model
    offers it again.
- **Smaller choices.** Userinfo in a Base URL is refused rather than stripped. Duplicate served ids
  are dropped (the repository refuses them). A context under 4 tokens gets no suggestion (it would be
  0). "Set {n}" on a model Detect never saw badges **manual**, having no baseline to record a
  suggestion in. Chips use the existing `formatTokenCount` ("131.1K"). pi's default max output has
  one source, `PI_DEFAULT_MAX_OUTPUT`, which the pi adapter reads.
- **Verification.** Unit and component tests cover every rule, with guard tests shown to fail
  against the pre-fix code, plus the probe against a real local HTTP server in each vLLM, SGLang and
  failure shape. A separate verifier drove the real app with a throwaway profile against fake vLLM,
  SGLang and generic servers: all nine claims, then a re-check of the fixes above, with no console
  errors and the owner's real providers and engine configs untouched.

## Out of scope

- Detectors for OpenRouter-shaped or LiteLLM (`/model/info`) custom endpoints; revisit if a gateway
  in front of them becomes common. OpenAI and OpenRouter as catalog providers need nothing.
- A `toolCall` field on `SharedProviderModel` (opencode's projection keeps `toolCall: true`).
- Changing the adapters' blank-field defaults (opencode `0`, pi 128,000 / 16,384).
- Claude's Endpoint page: cli.js has no per-model capability configuration beyond the model-mapping
  variables, the `[1m]` suffix and `CLAUDE_CODE_MAX_OUTPUT_TOKENS`.
