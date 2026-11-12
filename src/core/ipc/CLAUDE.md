# src/core/ipc

The invoke surface: one command registry served to the desktop renderer (`ipcMain`) and to the remote/web client (WebSocket), Electron-free. ADR-052, ADR-056, ADR-058, ADR-102.

## What lives here

- `command-registry.ts`: `CommandRegistry`, `CAPABILITIES`, the grant sets, `PINNED_CAPABILITIES`; `dispatch` is the one capability check and audit point for both transports.
- `*-commands.ts` (most of them): a family factory returning registrations with no transport; both registrars spread it, so capability and kind are declared once.
- `session.ipc.ts`: the desktop registrar (`registerSessionIpc`, `handleIpc`), plus desktop-only channels and the boot watchers. `remote-handlers.ts`: the remote registrar (`registerRemoteHandlers`, `handleRemote`).
- Name trap: the WebSocket server and dispatcher are `src/core/services/remote-server.ts` and `src/core/services/remote-dispatcher.ts`, not here; the `ipcMain` binder is `src/main/ipc/desktop-transport.ts`.
- `authcfg-commands.ts`, `webauthn-commands.ts` (bodies only; registered per transport in `authcfg.ipc.ts`, `webauthn.ipc.ts` and inline in `remote-handlers.ts`) and `terminal.ipc.ts` (desktop; remote is inline).
- `handlers-core.ts`: shared handler functions that the families import (send, delete, history, blob, trust); `create-session.ts`: the one `session:create` body; `approval-response.ts`: `answerApproval`.
- `safe-handler.ts`: `safeHandler` (the `{ ok, data, error }` envelope) and `envelopeFor(transport)`; `wire-args.ts`: `opt`, which turns a JSON `null` argument back into `undefined`.

## Recipes

**A new invoke command both transports serve** (exemplar: `src/core/ipc/voice-pack-commands.ts`)

1. `src/shared/types/api/*.ts` (the `*API` interface for the domain, or `ClaudeAPI` in `src/shared/types/claude-api.ts`): add the method. Result type carries no `ok` key. [compiler]
2. `src/core/ipc/*-commands.ts`: add an entry to the family's factory with `channel`, `capability`, `kind`, `handler`. A body that is long or shared goes in `src/core/ipc/handlers-core.ts`. [test: `remote-channel-parity.test.ts` once step 8 lists the member: every table invoke must be declared for both transports]
3. A new family file: spread it in `registerSessionIpc` (`handleIpc`) and `registerRemoteHandlers` (`handleRemote`). [test: `remote-handlers.ipc.test.ts` for the remote spread, after step 10; nothing for the desktop spread: the parity spec reads the family file, not the registrars, so a missed spread fails at call time]
4. A new family file is found by its name: `remote-channel-parity.test.ts` reads every `src/core/ipc/*-commands.ts`, so keep the suffix. [nothing]
5. Capability: pick from `CAPABILITIES` in `command-registry.ts`. `chat`, `session-config`, `config`, `git`, `fs-read` are the base remote grants (`AUTH_OFF_GRANTS`); `shell`, `ide`, `admin`, `enroll`, `host` are granted separately (`docs/architecture/security.md`, "Capability grants"). `kind: 'command'` is audited, `'query'` is not.
6. A channel outside the base set: add it to `PINNED_CAPABILITIES`. [nothing: unpinned, a later edit can relabel it into a grantable capability unnoticed]
7. A channel outside the base set that the web client invokes: add it to `UNGRANTED_AT_CONNECT_REMOTE_CHANNELS` in `remote-channel-parity.test.ts`. [test: `remote-channel-parity.test.ts`]
8. `src/shared/api-invoke-table.ts`: add the member to `API_INVOKES` (`DESKTOP_INVOKES` if desktop-only; the preload, web adapter and test helper build from it); `mode: 'unwrap'` iff the handler answers the `safeHandler` envelope. [compiler] for the member, [nothing] for `mode`
9. A member that differs per client stays hand-written in `src/preload/index.ts` and `src/web/api-adapter.ts` instead of the table. [compiler]
10. Regenerate the remote surface dump and commit it: `UPDATE_REMOTE_SURFACE=1 bunx vitest run src/core/ipc/__tests__/remote-handlers.ipc.test.ts -t "checked-in dump"` rewrites `src/core/ipc/__tests__/remote-surface.jsonl`. The new line in the diff is what a reviewer reads; never hand-edit the file. [test: `remote-handlers.ipc.test.ts`, "the remote surface equals the checked-in dump"]
11. A channel registered for remote whose capability is outside the base set also needs a line in `NOT_GRANTED_AT_CONNECT` in that spec. [test: `remote-handlers.ipc.test.ts`]
12. `src/test/helpers/boot-test-app.ts`: stub the member only if a harness test calls a channel the harness has no handler for. [nothing]

## Invariants

- Registration is fail-closed: reachable iff registered for that transport and the capability is in the connection's grants; a missing or unknown capability throws (`CommandRegistry.register`, `dispatch` in `command-registry.ts`).
- Both transports must declare the same capability, kind, `sessionIdArg`, `withConnection` and `withProgress` for one channel, or the second `register` throws (`command-registry.ts`).
- A result type must not carry an `ok` key: `unwrapEnvelope` in `src/shared/api-invoke-table.ts` returns `.data` for any object with `ok`, and `outcomeOf` in `command-registry.ts` audits it as the outcome.
- Wire args are JSON: an omitted optional arrives as `null`, so normalise with `opt` (`wire-args.ts`); a connection or progress reporter is prepended, never appended (`dispatch`).
- The `remote:*` mutations, `window:*` and `log-viewer:*` have no remote registration; `remote-handlers.ipc.test.ts` pins their absence.
- Only the desktop wraps a handler in `safeHandler`; a shared family wraps the enveloped ones with `envelopeFor(transport)` (`safe-handler.ts`).

## Fast test

- `bunx vitest run src/core/ipc/__tests__/remote-channel-parity.test.ts src/core/ipc/__tests__/command-registry.test.ts`
- `bunx vitest run src/core/ipc/__tests__/remote-handlers.ipc.test.ts -t "remote surface parity"`
- `bunx vitest run src/shared/__tests__/api-invoke-table.test.ts src/web/__tests__/api-adapter.test.ts`
- `bunx vitest run src/core/ipc/__tests__/session.ipc.test.ts` for desktop-side behaviour; the per-family specs are `src/core/ipc/__tests__/<family>-commands.test.ts`.
