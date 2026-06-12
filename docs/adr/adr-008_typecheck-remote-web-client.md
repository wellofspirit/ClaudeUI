# ADR-008: Type-check the remote web client (`src/web`) against `ClaudeAPI`

**Status:** Accepted
**Date:** 2026-05-30

## Context

The remote web client lives in `src/web` — `main.tsx`, `connection.ts`,
`components/`, and crucially `api-adapter.ts`. `createWebSocketApi()` in
`api-adapter.ts` returns a `ClaudeAPI`: a **hand-maintained mirror** of the
desktop preload (`src/preload/index.ts`), translating every `ipcRenderer.invoke`
into a `connection.invoke` over the WebSocket and every `ipcRenderer.on` into a
listener registration.

`src/web` was in a **type-checking blind spot**:

- It was excluded from both project tsconfigs — `tsconfig.node.json` covers
  `src/main`/`src/preload`/`src/shared`/`src/test`/`src/integration`;
  `tsconfig.web.json` covered `src/renderer`/`src/shared`/`src/test`/`src/e2e`/
  `src/integration` — but **neither** included `src/web`.
- It's bundled by `vite build --config vite.web.config.ts`, i.e. esbuild, which
  **strips types without checking them**.

So although `createWebSocketApi` is annotated `: ClaudeAPI`, nothing ever
verified that annotation. Any method added to `ClaudeAPI` (and to the desktop
preload) could be silently omitted from the web adapter. At runtime the missing
method is `undefined`, and the first call throws
`window.api.<method> is not a function` — an uncaught `TypeError` during render
that crashes the React subtree.

This was not hypothetical. The mockup-preview feature shipped its
`readMockupHtml`/`watchMockup`/… methods to the preload and `ClaudeAPI` but
never to the web adapter, producing exactly that crash on the remote client.
When `src/web` was added to the type-checker, it surfaced **10** more missing
`ClaudeAPI` methods (`logRelay`, `getVersionInfo`, `openLogViewer`,
`interruptSession`, `askSideQuestion`, `setThinkingMode`, `deleteSession`,
`deleteProject`, `removeMcpServer`, `testProxyConnection`) plus a batch of
latent `as Promise<ReturnType<ClaudeAPI['x']>>` double-`Promise` casts
(`ReturnType` of a `() => Promise<T>` already _is_ `Promise<T>`).

## Decision

**Add `src/web/**`to`tsconfig.web.json`'s `include`so`bun run typecheck`enforces`ClaudeAPI` conformance on the web adapter\*\*, and fix everything that
surfaced:

- Implemented all 10 missing `ClaudeAPI` methods in `api-adapter.ts` — routed to
  the WebSocket where meaningful (session control, deletes, version info) or
  stubbed where desktop-only (`openLogViewer`, `testProxyConnection`,
  `removeMcpServer`, `logRelay`), registering the corresponding server handlers
  in `remote-handlers.ts` where routing was new.
- Corrected the double-`Promise` casts to `as ReturnType<ClaudeAPI['x']>`.
- Fixed the two incidental errors the inclusion exposed in other `src/web`
  files (`ConnectionOverlay.tsx` effect return path, dead loop in `main.tsx`).

The web client is still **built** by esbuild (`build:web`); this ADR only adds a
**type-checking** pass over the same sources via `tsc --noEmit -p
tsconfig.web.json`, which already runs in `bun run typecheck` (and therefore in
`build` and CI's `test:ci` path).

## Consequences

- The `: ClaudeAPI` annotation on `createWebSocketApi` is now a real
  compile-time contract. Adding a method to `ClaudeAPI` that the web adapter
  doesn't implement fails `bun run typecheck` — the regression guard that would
  have caught the original mockup crash.
- `src/web` shares `tsconfig.web.json`'s `@renderer/*` / `@test/*` path aliases
  and DOM lib, which it needs (it imports renderer components and runs in a
  browser window).

### Trade-offs

- **Pre-existing lint debt is now more visible.** `src/web` was never
  prettier-formatted or lint-clean (it wasn't type-checked, and `bun run lint`
  already exits non-zero project-wide). Including it in the type-checker doesn't
  change the lint gate, but the files now carry visible formatting warnings and
  a couple of pre-existing lint errors (`createEventRegistry` missing return
  type, `set-state-in-effect` in `ConnectionOverlay`). Left for a separate
  cleanup pass; out of scope here.
- **Type-check only, not build-coupled.** esbuild remains the bundler, so a
  type error in `src/web` fails `typecheck`/`build` but a developer running
  `build:web` in isolation would still emit. Acceptable — `build` runs
  `typecheck` first.

### Relationship to other ADRs

Independent of, but discovered alongside,
[ADR-007](adr-007_remote-mockup-http-transport.md) (remote mockup transport):
the mockup crash was the symptom that exposed this blind spot. Does not
supersede any prior ADR.
