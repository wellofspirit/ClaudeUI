# src/core/shared/sync

The state and wire contract that the host core, the desktop renderer and the web client all import: channel classes, the typed event map, the reducer, canonical state, snapshot conversion. ADR-051, ADR-087.

## What lives here

- `channels.ts`: `CHANNEL_SPECS`, the class and canonical flag of every event channel, with the reason; `channelSpec` is what the host funnel asks. Two tables: the sync table (replicated and volatile channels, keyed by exactly the keys of `EmitEventMap`) and the host-local table. This is the only table of channels; `docs/architecture/sync-channels.md` explains the rules and points here.
- `events.ts`: `SyncEventMap`, the args of every channel a client subscribes to; `EmitEventMap` adds the emit-only channels. `emitEvent`, `BaseSession.send` and the reducer's handlers are all typed from it. Host-local channels are absent: they are sent to the owning window directly.
- `state.ts`: `CanonicalSessionState`, `emptySession`, `SESSION_FIELDS` (the per-session field list, read from `emptySession`), `fromSnapshot`, `toSnapshot`. The wire type `PerSessionSnapshot` is in `src/shared/remote-protocol.ts`.
- `reducer.ts`: `applyEvent`, the one fold both the host and every client run, as one handler per folded channel; `item-stream.ts`: the volatile item lane; `sync-client.ts`, `client-registry.ts`: the client side of the protocol.
- Name traps: the replica and the seal are in `src/renderer/src/stores/` (`replica.ts`, `sealed-fields.ts`), not in `src/renderer/src/sync/` (only `desktop-transport.ts`).
- Not here: `src/core/sync/sync-core.ts` and `event-ring.ts` (the host fan-out, ring and snapshot), `src/core/services/sync-host.ts` (`emitEvent`) and `sync-seed.ts`, `src/main/services/sync-port.ts` (the renderer port).

## Recipes

**A new push event that becomes synced per-session state** (exemplar: `session:slash-commands`)

1. `src/shared/remote-protocol.ts`, `PerSessionSnapshot`: add the field, optional for older hosts. [compiler: `fromSnapshot` reads every canonical field off the wire type]
2. `src/core/shared/sync/state.ts`: `CanonicalSessionState` and `emptySession`. [compiler] `toSnapshot` and `fromSnapshot` copy every field of `emptySession`; only a field whose wire form differs from its canonical form gets a line there, beside the existing exceptions.
3. `src/core/shared/sync/events.ts`, `SyncEventMap`: the channel and its args. [compiler: steps 4, 5 and 7 are typed from it]
4. `src/core/shared/sync/channels.ts`, the sync table: class `replicated`, `canonical: true`, and the reason. [compiler: the table must have exactly the event map's keys]
5. `src/core/shared/sync/reducer.ts`: a handler in the map (via `withSession`). Its args arrive typed from the map as untrusted input: guard what it reads. [compiler: a canonical row must have a handler, and only a canonical row may]
6. `src/core/shared/sync/reducer.ts`, the `session:conversation-cleared` handler: carry the field across if it is not conversation state. [nothing: the clear resets it to the empty value]
7. The emit site: `emitEvent` for host code, `BaseSession.send` in `src/core/providers/BaseSession.ts` for sessions (it supplies the routing id). [compiler for the channel and the payload; nothing forces the emit to exist]
8. `src/renderer/src/stores/session-store.ts`: `PerSessionState` and `EMPTY_SESSION_STATE`. [compiler: `projectSession` in `src/renderer/src/stores/replica.ts` needs a store field for every canonical field]
9. `src/core/sync/__tests__/snapshot-invariant.unit.test.ts`: one event in `EXTRA_EVENTS`. [test: the pool must hold an event for every folded channel]

No step for `projectSession`, the sealed-field list, the lint selectors in `eslint.config.mjs` or `mirrorStoreIntoReplica`: they follow `SESSION_FIELDS`. Add a `seed` wrapper in `src/test/helpers/replica-seed.ts` only if tests drive the event.

**A field on an existing synced slice**: steps 1, 2, 5 (edit the existing handler), 6 and 8.

**A push event with no snapshot field** (a nudge or a toast): steps 3, 4 (`canonical: false`) and 7, then a listener in `src/renderer/src/hooks/useClaudeEvents.ts`.

## Invariants

- A channel with no `CHANNEL_SPECS` entry is refused at emit (`SyncCore.process` in `src/core/sync/sync-core.ts` calls `channelSpec`). `emitEvent` and `BaseSession.send` only take a typed channel; `SyncCore.emit` stays untyped, for tests that feed it malformed input.
- Whether a channel rings follows from its class (`ringsEvents` in `channels.ts`): replicated rings, volatile and host-local never do.
- Reducer payloads are untrusted: an older host or a fixture can omit any field, so every handler keeps its runtime guards even where the type would let it skip them.
- A per-session field with its own wire or store form is a named exception in `toSnapshot`, `fromSnapshot` (`state.ts`) or `projectSession` (`replica.ts`); the same names are restated in `eslint.config.mjs`, and `sealed-fields.unit.test.ts` pins the two together.
- The serialized snapshot's key order is the order of `emptySession`; `toSnapshot` copies by that list, never by spreading the entry, so a stray key on a seeded entry cannot reach the wire.
- A sealed field has one writer, `src/renderer/src/stores/replica.ts`; components and actions never `set` it (`SEALED_SESSION_FIELDS`, enforced by lint and `sealed-fields.unit.test.ts`).
- Electron-free: `src/core/**` may not import Electron (`eslint.config.mjs`); `src/web/connection.ts` and the renderer import this directory, so keep Node-only APIs out (not lint-enforced).
- `session:auth-required` must be emitted before the `session:status` that leaves `running`: `applyEvent` attaches `retryPrompt` only while canonical status is `running`.
- A reducer handler that changes nothing returns the same state object, because `replica.ts` diffs the projection by identity (`provider:auth-resolved` in `reducer.ts`).

## Fast test

- `bunx vitest run src/core/shared/sync/__tests__/reducer.unit.test.ts` (and `reducer-golden.unit.test.ts` for replay fixtures, `reducer-coverage.unit.test.ts` for the handler set)
- `bunx vitest run src/core/shared/sync/__tests__/session-fields.unit.test.ts src/core/sync/__tests__/snapshot-invariant.unit.test.ts`
- `bunx vitest run src/core/ipc/__tests__/sync-funnel-guard.test.ts`
- `bunx vitest run src/renderer/src/stores/__tests__/sealed-fields.unit.test.ts src/renderer/src/stores/__tests__/replica.unit.test.ts src/renderer/src/stores/__tests__/replica-projection.unit.test.ts`
- `bunx vitest run src/e2e/flows/sync-hydration-parity.e2e.test.ts` for canonical versus replica parity.
