# src/core/shared/sync

The state and wire contract that the host core, the desktop renderer and the web client all import: channel classes, the reducer, canonical state, snapshot conversion. ADR-051, ADR-087.

## What lives here

- `channels.ts`: `CHANNEL_SPECS`, the class, ring and canonical flags of every event channel; `channelSpec` is what the host funnel asks.
- `events.ts`: `SyncEventMap`, the typed listener shapes for channels a client subscribes to (host-local channels are absent).
- `state.ts`: `CanonicalSessionState`, `emptySession`, `fromSnapshot`, `toSnapshot`. The wire type `PerSessionSnapshot` is in `src/shared/remote-protocol.ts`.
- `reducer.ts`: `applyEvent`, the one fold both the host and every client run; `item-stream.ts`: the volatile item lane; `sync-client.ts`, `client-registry.ts`: the client side of the protocol.
- Name traps: the replica and the seal are in `src/renderer/src/stores/` (`replica.ts`, `sealed-fields.ts`), not in `src/renderer/src/sync/` (only `desktop-transport.ts`).
- Not here: `src/core/sync/sync-core.ts` and `event-ring.ts` (the host fan-out, ring and snapshot), `src/core/services/sync-host.ts` (`emitEvent`) and `sync-seed.ts`, `src/main/services/sync-port.ts` (the renderer port).

## Recipes

**A new push event that becomes synced per-session state** (exemplar: `session:slash-commands`)

1. `src/shared/remote-protocol.ts`, `PerSessionSnapshot`: add the field, optional for older hosts. [nothing]
2. `src/core/shared/sync/state.ts`: `CanonicalSessionState`, `emptySession`, `fromSnapshot` with a default, `toSnapshot`. The first three are [compiler]; `toSnapshot` is [nothing: skipping it loses the field on every full sync].
3. `src/core/shared/sync/channels.ts`, `CHANNEL_SPECS`: classify the channel (`replicated`, `ring: true`, `canonical: true`, `why`). [test: `sync-funnel-guard.test.ts` for a literal emit site; otherwise the emit is refused at runtime]
4. `src/core/shared/sync/reducer.ts`, `applyEvent`: add a `case` (via `withSession`). [nothing: the `default` branch returns state unchanged]
5. `src/core/shared/sync/reducer.ts`, `session:conversation-cleared`: carry the field across if it is not conversation state. [nothing: the clear resets it to the empty value]
6. The emit site: `emitEvent` for host code, `BaseSession.send` in `src/core/providers/BaseSession.ts` for sessions; the first argument is the routing id. [nothing]
7. `src/renderer/src/stores/session-store.ts`: `PerSessionState` and `EMPTY_SESSION_STATE`. [compiler]
8. `src/renderer/src/stores/replica.ts`, `projectSession`: copy the field. [nothing: the store never shows it]
9. `src/renderer/src/stores/sealed-fields.ts`: `SEALED_SESSION_FIELDS` and `SEALED_SESSION_FIELD_SOURCE`, and the two per-session regexes in `eslint.config.mjs` (`no-restricted-syntax`). [test: `sealed-fields.unit.test.ts`]
10. `src/core/shared/sync/events.ts`, `SyncEventMap`: only when a component subscribes to the channel. [compiler at the subscriber]
11. `src/core/sync/__tests__/snapshot-invariant.unit.test.ts`: add one event to `EXTRA_EVENTS`; this is what exposes a `toSnapshot` or `fromSnapshot` omission. [nothing]
12. `src/test/helpers/replica-seed.ts`: add the field to `mirrorStoreIntoReplica` (a hand-listed copy of the store), and a `seed` wrapper if tests drive the event. [nothing: tests that stage the field with `setState` lose it on the next projection]
13. `docs/architecture/sync-channels.md`: add the table row. [nothing]

**A field on an existing synced slice**: steps 1, 2, 4 (edit the existing `case`), 5, 7, 8, 9 and 12 remain; 11 only if the event is not already in `EXTRA_EVENTS`; 3, 6, 10 do not.

## Invariants

- A channel with no `CHANNEL_SPECS` entry is refused at emit (`SyncCore.process` in `src/core/sync/sync-core.ts` calls `channelSpec`).
- Canonical state and the snapshot are one shape: a field missing from `toSnapshot` is lost on resync, and one missing from `projectSession` never renders.
- A sealed field has one writer, `src/renderer/src/stores/replica.ts`; components and actions never `set` it (`SEALED_SESSION_FIELDS`, enforced by lint and `sealed-fields.unit.test.ts`).
- Electron-free: `src/core/**` may not import Electron (`eslint.config.mjs`); `src/web/connection.ts` and the renderer import this directory, so keep Node-only APIs out (not lint-enforced).
- `session:auth-required` must be emitted before the `session:status` that leaves `running`: `applyEvent` attaches `retryPrompt` only while canonical status is `running`.
- A reducer branch that changes nothing returns the same state object, because `replica.ts` diffs the projection by identity (`provider:auth-resolved` in `reducer.ts`).

## Fast test

- `bunx vitest run src/core/shared/sync/__tests__/reducer.unit.test.ts` (and `reducer-golden.unit.test.ts` for replay fixtures)
- `bunx vitest run src/core/sync/__tests__/snapshot-invariant.unit.test.ts`
- `bunx vitest run src/core/ipc/__tests__/sync-funnel-guard.test.ts`
- `bunx vitest run src/renderer/src/stores/__tests__/sealed-fields.unit.test.ts src/renderer/src/stores/__tests__/replica.unit.test.ts`
- `bunx vitest run src/e2e/flows/sync-hydration-parity.e2e.test.ts` for canonical versus replica parity.
