# Phase 0 — Rip Codex (implementation kickoff)

> **You are a fresh session starting the V2 implementation.** Read this doc fully, then the
> "Required reading" below, before touching code. This is **Phase 0** of the plan in
> [implementation-plan.md](implementation-plan.md). It is a **removal-only** phase: delete the
> Codex backend, **preserve the provider scaffolding**, and leave a clean, working **Claude-only**
> app. No opencode work, no renames, no new features.

## Background (why this phase exists)

ClaudeUI was built as a desktop client for **Claude Code**. We are re-platforming it into a
**multi-engine** app and **pivoting the second backend from Codex to opencode** (a meta-harness
that runs OpenAI/Anthropic/Google/local models — it subsumes OpenAI's coding models while being a
better harness). The full V2 design is **locked** in `docs/v2/` and **ADR-018..021**.

Codex was previously integrated as the second backend (`codex-sup` branch). It is now being
**removed** — recoverable from git history, and demoted to a documented *dormant fallback* should
OpenAI ever de-support opencode (see ADR-019). opencode will be added later (Phase 5); this phase
only removes Codex.

**The one critical rule:** the Codex work introduced two things — (1) the *Codex backend* itself,
and (2) a *provider-neutral scaffolding* (`ISession`/`BaseSession`/`ProviderRegistry`, capabilities,
`ApprovalDecision`, the `session:plan` event, provider tagging). **Delete (1). Keep (2)** — opencode
is built on it in later phases. Deleting the scaffolding means rebuilding it in Phase 1; that's the
main risk of this phase.

## Required reading (in order)

1. **[README.md](README.md)** — the V2 frame: engine / vendor / account, the foundation list.
2. **[implementation-plan.md](implementation-plan.md)** — the 0→7 sequencing; re-read the Phase 0 row.
3. **[../adr/adr-019_opencode-engine-backend.md](../adr/adr-019_opencode-engine-backend.md)** — why opencode supersedes Codex; its "Codex removal" list.
4. **[../adr/adr-018_v2-engine-vendor-account-model.md](../adr/adr-018_v2-engine-vendor-account-model.md)** — what the *kept* scaffolding becomes (so you know what not to delete).
5. Skim **`CLAUDE.md`** → the "Codex Integration" and "Provider abstraction" sections + the structure tree, to see what currently exists.

## Definition of done

- All Codex code, scripts, deps, and config wiring removed.
- The provider scaffolding intact; `ProviderId` narrowed to `'claude'` (no rename to `EngineId` —
  that's Phase 1).
- `bun run typecheck` clean; `bun run test` and `bun run test:ci` green; `bun run build` succeeds;
  `bun run dev` launches and a Claude session works end-to-end (chat, approvals, thinking, MCP).
- `CLAUDE.md` updated to drop Codex (see Step 7).
- No reference to `codex` remains in `src/`, `scripts/`, `package.json` except where intentionally
  historical (none expected).

## DELETE (Codex backend — remove entirely)

- **`src/main/codex/`** — the whole directory (21 files: `CodexSession.ts`, `CodexAppServerClient.ts`,
  `CodexHistory.ts`, `mapCodexEvent.ts`, `codexModels.ts`, `codexQuery.ts`, `codexSessions.ts`,
  `codexStatus.ts`, `codex-watcher.ts`, `locate.ts`, `protocol/{index,methods,schema}.ts`, and all
  `__tests__/`).
- **`src/e2e/flows/codex-session-contract.e2e.test.ts`**
- **`src/integration/codex/`** (`CodexSession.integration.test.ts`)
- **`scripts/ensure-codex.mjs`**, **`scripts/generate-codex-protocol.mjs`**
- **`vendor/codex-cli/`** on disk (gitignored — just remove locally) + its electron-builder
  `extraResources` entry.
- **`docs/codex/`** — the old Codex design notes (recoverable from git; superseded by `docs/v2/`).

## EDIT (entangled files — remove the Codex branches, keep the file + Claude behavior)

Grep is your friend: `rg -i codex src scripts` enumerates every site. Categorized:

- **`src/shared/types.ts`** — remove `CODEX_CAPABILITIES`, `CodexStatus`; narrow `ProviderId` to
  `'claude'`; simplify `capabilitiesFor()` to return `CLAUDE_CAPABILITIES`. **Keep** `ProviderId`
  (one-member union), `SessionCapabilities`, `CLAUDE_CAPABILITIES`, `SessionStatus.{provider,
  capabilities}`, `ApprovalDecision` (incl. `allowForSession`).
- **`src/main/providers/register-providers.ts`** — remove the `'codex'` registration + the
  `CodexSession` import. **Keep** the `'claude'` registration and the registry.
- **`src/main/providers/ISession.ts`, `BaseSession.ts`** — comment-only mentions ("future Codex");
  reword. Keep the interfaces.
- **`src/main/ipc/session.ipc.ts`, `remote-handlers.ts`** — remove the `getCodexStatus` handler and
  any `codex` branches in `deleteSession` / history / watch routing.
- **`src/main/services/session-history.ts`** — remove the Codex history-load branch.
- **`src/main/services/ui-config.ts`** — `sessionProviders` typing follows `ProviderId`; treat any
  persisted non-`'claude'` value as `'claude'` on read (graceful migration for users who had Codex
  sessions). Keep the map.
- **`src/main/services/claude-session.ts`** (+ `__tests__/claude-session-resolve-approval.test.ts`)
  — Codex appears only in comments / the `allowForSession`→`allow` coercion note. Keep `allowForSession`.
- **`src/preload/index.ts`** — remove the `getCodexStatus` bridge.
- **`src/web/api-adapter.ts`** — remove the Codex mirror (e.g. `getCodexStatus`).
- **`src/test/helpers/boot-test-app.ts`** — remove Codex test wiring.
- **Renderer:**
  - `stores/session-store.ts` (+ `__tests__/session-store-provider.unit.test.ts`,
    `__tests__/session-store-actions.component.test.ts`) — drop Codex provider cases; keep the
    provider-tagging mechanism.
  - `hooks/useClaudeEvents.ts` — keep `session:plan` (opencode reuses it); drop Codex-only handling.
  - `components/shared/ProviderToggle.tsx`, `ProviderLogo.tsx` — remove the Codex option/logo. With
    only `'claude'` the toggle is degenerate: hide it when a single provider exists (keep the
    component — opencode re-enables it in Phase 5).
  - `components/SettingsDialog/settings-sections.tsx` — remove the **Codex** settings section.
  - `components/chat/{MessageBubble,FloatingApproval,InputBox/InputBox,InputBox/View}.tsx`
    (+ `__tests__/FloatingApproval.component.test.tsx`) — drop Codex capability-gating / the
    Codex-only "Allow for session" wiring; keep `ApprovalDecision.allowForSession` (no producer
    until opencode — the affordance simply won't render).
  - `components/Sidebar/Sidebar.tsx` (+ `__tests__/Sidebar.component.test.ts`) — drop Codex
    session grouping/logos/delete-watch routing; keep the provider-aware `deleteSession` mechanism.

## package.json

Remove: `codexCliVersion`, `codexProtocolRef`; the `ensure-codex` / `update-codex` /
`generate-codex-protocol` scripts; and every `&& npm run ensure-codex` from `postinstall`, `build`,
and all `build:*` scripts. (`rg "ensure-codex|codex" package.json` to confirm none remain.)

## Step-by-step

1. **Branch.** `codex-sup` already has the V2 design. Create the implementation branch off it
   (e.g. `v2-phase-0-rip-codex`) — don't commit straight to `codex-sup` unless told to.
2. Delete the DELETE list (dir, test files, scripts, vendor dir, docs/codex).
3. Prune `package.json` (deps + scripts + build wiring).
4. Fix `src/shared/types.ts` (narrow `ProviderId`, drop Codex caps/status).
5. Fix the main-process entanglements (providers, ipc, services, preload, web) — every broken
   import from the deleted `codex/` dir is a site to prune.
6. Fix the renderer entanglements + tests (drop Codex cases, keep Claude + the scaffolding).
7. **Update `CLAUDE.md`** — remove/replace the "Codex Integration" section, drop `src/main/codex/`
   and Codex commands from the structure tree + Commands, and update the ADR table (016/017
   superseded; add 018–021). Point the Providers note at `docs/v2/`.
8. **Sweep:** `rg -i codex src scripts package.json CLAUDE.md` returns nothing (or only intended
   historical mentions). Resolve every hit.

## Verify

```
bun run typecheck      # must be clean
bun run test           # unit + component + e2e
bun run test:ci        # + git project
bun run build          # typecheck + build
bun run dev            # smoke: open a Claude session, send a prompt, approve a tool, check thinking/MCP
```

## Gotchas

- **Do NOT rename `provider`→`engine` or add `'opencode'`** — that's Phase 1. Phase 0 leaves
  `ProviderId = 'claude'`.
- **Do NOT delete the scaffolding** (`src/main/providers/*`, capabilities, `ApprovalDecision`,
  `session:plan`, provider tagging) — opencode reuses it. When in doubt, keep it.
- **Persisted Codex sessions:** users on `codex-sup` may have `sessionProviders` entries = `'codex'`.
  Read-map any non-`'claude'` value to `'claude'` so the sidebar doesn't break.
- **The provider toggle** becomes single-option; hide it rather than showing a one-item switch.
- This is **design-faithful removal only** — if you find a Codex behavior you think opencode will
  need, it's already captured in `docs/v2/`; don't try to preserve Codex code for it.

## Out of scope (explicitly NOT Phase 0)

opencode integration, the `EngineId` rename, the capability-model rebuild, the DB / persistence
changes, auth providers, the tool registry, metering. Those are Phases 1–7. Keep this PR small and
reviewable: *Codex out, Claude intact, scaffolding preserved.*

## Commit

Branch off `codex-sup`; **no `Co-Authored-By` line and no AI attribution** in the message (project
convention). Suggested: `refactor(v2): remove Codex backend (Phase 0) — keep provider scaffolding`.
