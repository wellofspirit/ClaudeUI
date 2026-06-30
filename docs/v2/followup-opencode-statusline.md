# Follow-up — opencode status-line usage (tokens + context) + billingType cost gating

> Resolves ROADMAP **#3** and a newly-found bug: **the opencode status line shows In:0 / Out:0 /
> Total:0 · 0% context even after a turn**, because `OpencodeSession` never emits `session:status-line`
> (StatusLineData). This wires opencode's live token + context usage into the status line, and gates the
> cost segment on `Account.billingType` so a free model (e.g. OpenCode Zen / mimo 2.5) doesn't show a
> misleading "$". **Claude untouched.** Branch `v2-followup-opencode-statusline` (off
> `v2-followup-opencode-auth-ux`). opencode source ref: `D:\WorkPlace\opencode-src` (READ-ONLY).

## Root cause (verified)

- The status line renders from `statusLine: StatusLineData` (per-session), fed by `session:status-line`
  → store → `InputBox` `StatusLine` (`InputBox/View.tsx:119-150`, template at `:342`). The cost segment
  is gated by `showCost` (`View.tsx:570`, from `props.showCostInStatusLine`).
- **Claude** populates it: `buildStatusLineFromAccumulators()` (`claude-session.ts:1705`) →
  `session:status-line` (`:1249,1266,1330,1791`); context size via `getContextWindowSize(model)`,
  `lastContextLength` tracked per turn.
- **opencode** emits `session:metering` (`OpencodeSession.ts:1119`) + `sendStatus` (SessionStatus) but
  **never `session:status-line`** → the renderer keeps `DEFAULT_STATUS_LINE` (all zeros). The
  `cost_update` case (`:578-579`) explicitly defers and emits nothing live; `MeteringSnapshot.contextWindow`
  is hardcoded `{used:0,size:0}` (`:1116`).
- The data exists: per-message tokens live on the accumulators (`acc.tokens` = `{input, output,
  reasoning?, cache:{read,write}}`), already summed in `sendMetering` (`:1089-1101`); `totalCostUsd` is
  tracked (`:142`, updated via ref `:482-490`). The model's context window is in `/config/providers`:
  `model.limit.context` (`protocol/types.ts:21`) — but model-discovery (`model-discovery.ts:31-50`)
  drops it (reads caps/name only; `ModelInfo` has no contextWindow field).

## Scope (locked)

- **A.** Build + emit `StatusLineData` for opencode (tokens In/Out/Total + context used %), live during
  the turn and at result — so the status line matches Claude's behavior. Also fix the metering
  `contextWindow`.
- **B.** Gate the status-line **cost** segment on the active session's `Account.billingType` — hide it
  when `'free'` (behavior-preserving for Claude, which is never free). This is ROADMAP #3.
- **Out of scope:** richer per-billingType *metric semantics* (subscription→utilization%+window,
  apiKey→spend) from foundation 5 §6 — that's a larger separate item; here we only gate the `$` and
  surface tokens/context.

## Steps

### A. opencode StatusLineData emission (main)

1. **Capture context window in discovery** (`model-discovery.ts`): read `m.limit?.context` in the model
   map; store per-model in a module cache `Map<"providerID/modelID", number>` populated alongside
   `cachedGroups`, and export `getOpencodeModelContextWindow(providerID, modelID): number` (0 if
   unknown). Clear it in `invalidateOpencodeModelCache()`. (Don't change the `ModelInfo` shape unless
   you also thread it through — the side map is simpler.)
2. **`OpencodeSession`**:
   - Add `private lastContextLength = 0`. Update it from the **latest assistant** `message.updated`
     tokens = `info.tokens.input + (info.tokens.cache?.read ?? 0)` (the running prompt size). Best place:
     where the own-path `cost_update` tokens are processed (the event-mapper `cost_update` carries
     `tokens?: MessageTokens`; thread the per-message tokens to update `lastContextLength`). Reset to 0
     in `cancel()`/`dispose()` with the other per-session state.
   - Extract a `sumSessionTokens()` helper from `sendMetering`'s loop (`:1089-1101`) → `{input, output,
     cacheWrite, cacheRead}`; have `sendMetering` use it too (DRY).
   - Add `buildStatusLine(): StatusLineData`: `{ totalCostUsd: this.totalCostUsd, totalDurationMs:
     <best-effort from startTimeMs>, totalApiDurationMs: 0, totalInputTokens: sum.input,
     totalOutputTokens: sum.output, cachedTokens: sum.cacheRead + sum.cacheWrite, totalTokens:
     input+output+cached, contextWindowSize: getOpencodeModelContextWindow(parsed.providerID,
     parsed.modelID), usedPercentage: ctx>0 && lastContextLength>0 ? round(lastContextLength/ctx*100) :
     null, remainingPercentage: usedPercentage!=null ? 100-usedPercentage : null }`. (`Date.now()` is
     fine here — main process, NOT a workflow script.)
   - Add `private sendStatusLine() { this.send('session:status-line', this.buildStatusLine()) }`.
   - **Emit it live on `cost_update`** (replace the "deferred to result" no-op at `:578-579` with
     `this.sendStatusLine()`), and at `'result'` (alongside the existing `sendMetering`/`sendStatus`),
     and once after init/model-switch so an idle session shows 0/size correctly.
   - **Fix `MeteringSnapshot.contextWindow`** (`:1116`) → `{ used: this.lastContextLength, size:
     getOpencodeModelContextWindow(parsed.providerID, parsed.modelID) }`.

### B. billingType cost gating (renderer) — ROADMAP #3

3. `InputBox.tsx:725` — replace `showCostInStatusLine={true}` with a value derived from the active
   session's account: read `useActiveSession((s) => s.status?.account?.billingType)` and pass
   `showCostInStatusLine={billingType !== 'free'}`. Hide cost ONLY for `'free'` (so Claude —
   subscription/apiKey/unknown — is unchanged; opencode free models hide the `$`). Remove the stale
   `/* Phase 7: gate on Account.billingType */` comment.

## Tests (mocked, no binary)

- **model-discovery**: a `/config/providers` fixture with `models[].limit.context` →
  `getOpencodeModelContextWindow('provider','model')` returns it; unknown → 0;
  `invalidateOpencodeModelCache()` clears it.
- **OpencodeSession** (extend the existing fixtures): after a `message.updated` with `info.tokens
  {input,output,cache}`, a `session:status-line` is emitted with matching `totalInputTokens/output/
  total`, `contextWindowSize` from the discovery map, `usedPercentage` from `lastContextLength/size`;
  emitted on `cost_update` (live) and at `result`. `MeteringSnapshot.contextWindow` is populated (not
  0/0). A free-model session still emits tokens (cost handling unchanged).
- **InputBox** (component): `billingType:'free'` → cost segment hidden; `'subscription'`/`'apiKey'` →
  shown; absent/`'unknown'` → shown (Claude-safe default).
- Keep existing status-line / metering / Claude tests green (Claude path byte-identical).

## Verify

```
bun run typecheck && bun run test && bun run test:ci && bun run lint && bun run build
```
- 0 lint errors (3 pre-existing warnings OK). **No `bun install`** (better-sqlite3 ABI).
- **Real-app (orchestrator-driven):** the user is running a live opencode session (OpenCode Zen / mimo
  2.5), so the definitive check is live — but the orchestrator will also screenshot via the temp
  `__sessionStore` hook: inject an opencode session `statusLine` (non-zero In/Out/Total + context %) +
  `status.account.billingType='free'`, and assert the status line shows tokens/context with **no cost
  segment**. Agent: report unit/gate results; the orchestrator does the real-app shot. (User can confirm
  the live turn shows real numbers.)

## Gotchas

- **Claude is byte-identical** — only opencode gains `session:status-line`; the renderer cost-gate hides
  only for `'free'` (Claude is never free).
- **Context "used" = latest turn's input + cacheRead**, not the cumulative sum (which is In/Out/Total).
  Don't conflate them.
- **Context window may be 0** if discovery hasn't run for the model yet → `usedPercentage:null` (status
  line shows tokens, omits %). Acceptable; the model picker warms discovery on session open.
- **Emit live on `cost_update`** so the status line updates during the turn (matches Claude); don't only
  emit at result.
- opencode-src is READ-ONLY. No new deps.

## Out of scope
- Per-billingType metric semantics (subscription utilization%/window, apiKey real-spend formatting) —
  foundation 5 §6, a separate larger item.
- Claude status-line changes (none).

## Commit (orchestrator, after review + shot)
One commit, no AI attribution. Suggested subject:
`fix(v2/opencode): surface token + context usage in the status line; gate cost on billingType`.
