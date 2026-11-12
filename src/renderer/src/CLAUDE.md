# src/renderer/src

The React UI. The desktop window and the web client (`src/web`) both run it, so it talks to the host only through `window.api`. ADR-027, ADR-051, ADR-093.

## What lives here

- `components/`: one folder per component, a container plus a pure `View.tsx` where split; tests in each `__tests__/`.
- `stores/session-store.ts`: the one Zustand store. Regions by symbol: `PerSessionState`, `EMPTY_SESSION_STATE`, `SessionState` (signatures), the `create()` body (bodies). It re-exports `AppSettings` and `DEFAULT_SETTINGS` from `src/shared/app-settings.ts`, the schema core reads too.
- `stores/replica.ts`, `stores/sealed-fields.ts`: the store is a replica of host state; the replica fold is the only writer of sealed fields. `sync/` holds only the desktop transport, not the replica.
- `hooks/useClaudeEvents.ts`: the event listener hub; host events reach the store through the replica, this file runs the side effects.
- `lib/`, `utils/`: plain TypeScript helpers (`lib/session-history-load.ts` loads transcripts).
- Neighbours: `src/web/` (web shell, `src/web/api-adapter.ts`), `src/preload/index.ts` (desktop bridge), `src/shared/window-api.d.ts` (types `window.api` as `ClaudeAPI`).

## Recipes

**A persisted app setting with its Settings control** (row exemplar: `START_IN_WORKTREE` in `src/renderer/src/components/SettingsDialog/settings-pages.tsx`; its key `startInWorktree` is the step 2 kind, `agentModelTierColors` the step 1 kind)

1. `src/shared/app-settings.ts`, `AppSettings`: add the key, required, and its default in `DEFAULT_SETTINGS` [compiler: a required key forces the default]. That default is the only one: the store merges it and core resolves through it.
2. Optional with no default only when unset is its own state (Reset then deletes the key); a resolver in `src/shared/` then owns what unset means, as `sessionToolsEnabled` does [nothing].
3. `src/renderer/src/components/SettingsDialog/settings-pages.tsx`: new `SettingItem` const, add it to `PAGE_LOCAL_ITEMS`, place it in a `PAGES` group; the newest app settings use this, `SECTIONS` in `settings-sections.tsx` is the older home [test: settings-pages.unit.test.tsx].
4. `src/renderer/src/components/SettingsDialog/__tests__/settings-pages.unit.test.tsx`: add the key to the pinned `PAGE_LOCAL_ITEMS` list [test: settings-pages.unit.test.tsx].
5. A new group, not just a row, also changes the group-id lists in `src/renderer/src/components/SettingsDialog/__tests__/SettingsDialogView.component.test.tsx` [test: SettingsDialogView.component.test.tsx].
6. Renderer consumer: a `useSessionStore` selector on `settings` [nothing]. Search, the phone settings view and sync to other clients need no step.
7. If `src/core` must honour it: read `appSetting('<key>')` from `src/core/services/app-settings.ts`. It is typed and returns the saved value or the default from step 1. A direct `loadSettings()` or canonical-state read fails [test: app-settings-readers.test.ts].
8. If core must act when it changes (a timer, a level, a cache): add the effect to `applySettings` in `src/core/services/app-settings-apply.ts`. It runs at boot and after every change, whether a client saved or `settings.json` changed on disk [nothing: without it the new value is seen only where step 7 reads it].
9. `saveUiSettings` in `src/core/ipc/handlers-core.ts` drops `sandbox`, `proxy`, `anthropicEndpoint` and `modelOverride` (engine and vendor owned, `docs/architecture/persistence.md`); a key with those names is lost on save.

**A component test with two-tier test ids** (copy the closest exemplar's structure; files are `*.component.test.tsx` in `__tests__/`)

1. Settings row: `src/renderer/src/components/SettingsDialog/__tests__/StartInWorktreeSetting.component.test.tsx` (renders the row through `pageOf`, no store).
2. Chat card with store state: `src/renderer/src/components/chat/__tests__/TaskCard.component.test.tsx` (`bootTestApp` from `src/test/helpers/boot-test-app.ts`, `seed` and `emitSync` from `src/test/helpers/replica-seed.ts`).
3. Store action: `src/renderer/src/stores/__tests__/session-store-actions.component.test.ts`; stage session state with `seedSession` or `seed`, not `setState` on a sealed field.
4. Pure view, props in and DOM out: `src/renderer/src/components/MockupPanel/__tests__/View.unit.test.tsx`.
5. Geometry (wrapping, overflow, tap size, zoom) jsdom cannot see: `src/renderer/src/components/chat/__tests__/TaskCardLayout.browser.test.tsx`, real Chromium.
6. Ids (ADR-027): `data-testid="<ComponentName>"` on the outermost element; interactive parts `<ComponentName>.<part>` in camelCase. `src/renderer/src/components/chat/ChatPanel/ContextPressureBanner.tsx` stamps both; query by id before any screenshot.

## Invariants

- Sealed fields are written only by the replica; a component or store action writing one is a lint error: `eslint.config.mjs` (`no-restricted-syntax`), pinned by `src/renderer/src/stores/__tests__/sealed-fields.unit.test.ts`.
- A sealed field staged with `setState` in a test is reverted by the next projection unless `mirrorStoreIntoReplica` (`src/test/helpers/replica-seed.ts`) is called right after; it copies every sealed field into the replica and is a bridge for old fixtures, not a pattern.
- View-only per-session fields live on `PerSessionState` in the one `sessions` record; they survive projection and rekey in `src/renderer/src/stores/replica.ts`. Never a second store.
- A new per-session field must be considered for the hand-written reset list in `clearConversation` (`src/renderer/src/stores/session-store.ts`) [nothing forces it].
- No viewport units (`vh`, `vw`, `dvh`, `h-screen`, ...) in components: the app renders under CSS `zoom`; `ZOOM_TRAP` in `eslint.config.mjs` (ADR-093).
- Nothing here imports Electron; host access is `window.api` only, and every feature must work in `src/web`. No lint rule enforces the import ban in this directory.

## Fast test

- `bunx vitest run <spec> --project '!browser'` (`*.unit.test.*` run in `unit`, `*.component.test.*` in `component`); `bun run test:browser` for `*.browser.test.tsx`; `bun run typecheck:web`.
- `bunx vitest run src/renderer/src/components/SettingsDialog/__tests__/settings-pages.unit.test.tsx src/renderer/src/stores/__tests__/sealed-fields.unit.test.ts`
