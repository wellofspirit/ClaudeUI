# Remote access — transport + auth, as built

Part of [architecture/](README.md). **Status:** as-built record of the remote
**transport and authentication** layer — the HTTP+WS listener, the wire frames, the auth
modes, E2E encryption, the scoped URL tokens and the tunnel/TLS front ends. This is what
carries sync; it is not where sync is designed.

**The sync architecture lives in [sync-core.md](sync-core.md)** (canonical state, the
emission funnel, the shared reducer, replication, queue, terminal, headless), with the
per-channel classification in [sync-channels.md](sync-channels.md) and the auth *policy*
model — capabilities, step-up, grant decay, audit — in [security.md](security.md).

This file used to be the "as built" counterweight to sync-core.md's target design, and
carried a defect ledger from the 2026-08-13 sync-drift review. **SyncCore phases 0-4 are
landed, and every defect in that ledger is closed** (each is recorded with its closing
stage in sync-core.md — the snapshot watermark race, drop-before-mount, the privileged
desktop renderer in both halves, opt-in fan-out, queue ghosts, and the RPC-not-events
gap). What is left here is the part the rebuild did not change.

## Components

| Piece | File | Role |
| ----- | ---- | ---- |
| Remote server | `src/main/services/remote-server.ts` | HTTP + WS listener; auth (ADR-039/042), E2E (tunnel), mockup/sent-file routes (ADR-007/043); serves the web client bundle |
| Dispatcher | `src/main/services/remote-dispatcher.ts` | Routes WS `invoke` frames to the same handler functions as desktop IPC. What a remote client may reach is decided by CAPABILITY GRANTS in the command registry (`ipc/command-registry.ts`), not by the old `BLOCKED` denylist |
| WS broadcaster | inside `remote-server.ts` | A plain funnel SUBSCRIBER: `addSyncSubscriber((seq, channel, args) => broadcast(...))`, registered on `start()` and dropped on `stop()`. It broadcasts the ring's own seq and never re-numbers |
| Desktop transport | `src/main/services/sync-port.ts` + `src/renderer/src/sync/desktop-transport.ts` | The desktop renderer is client #1 over a `MessagePortMain` pair, speaking the same frames as a WS client. One channel per renderer LOAD; the subscriber is registered only once the first `sync` has been answered, in the same tick |
| Web client | `src/web/` (`connection.ts`, `api-adapter.ts`, `main.tsx`) | Dynamically imports the renderer's own `App`/stores. `api-adapter` is a hand-maintained `ClaudeAPI` mirror (typechecked per ADR-008) for the **invoke** surface only; both clients subscribe to events through `shared/sync/client-registry` |
| Auth | `src/main/services/remote-auth.ts` + `remote-server.ts` | Token / password / tailnet-identity modes, throttling, constant-time compares, step-up proofs |
| Tunnel + TLS | `src/main/services/tunnel-manager.ts`, `tailscale-manager.ts` | cloudflared quick tunnel (mandatory E2E) and `tailscale serve` on a pinned HTTPS port (ADR-042) |

## Wire protocol (`src/shared/remote-protocol.ts`)

Four frame families, and the same four carry BOTH transports (WebSocket for the web
client, `MessagePort` for the desktop renderer — no auth frames on the port, because the
port IS the trust):

- `invoke` / `invoke-response` — client actions, RPC mirroring `ipcRenderer.invoke`.
- `event {seq, channel, args}` — server pushes. The seq is the ring's, assigned once.
- `sync {lastSeq, epoch}` → `sync-catchup {events}` or `sync-full {state}` — the
  reconnect protocol. The snapshot is canonical state in the main process
  (`SyncCore.getSnapshot()`), serialized in the same synchronous tick its `seq` is read.
  The full/catchup branching lives in `shared/sync/sync-decision.ts` so the two
  transports cannot answer one `sync` differently.
- `auth` / `auth-response`, `e2e-activate` / `e2e-ack`, `ping` / `pong` — WS-only
  handshake and liveness.

WS-only additions to a `sync-full` answer (`mockupToken`, `fileToken`) stay in
`remote-server`: they exist to build URLs a browser will fetch, which a MessagePort
client never needs.

## HTTP routes

- `GET /remote` — the web client bundle. The WS token rides the URL **fragment** (never
  a query param, so it stays out of server logs and `Referer`).
- `GET /mockup?...&token=` — mockup preview assets, behind a separate low-privilege
  token (ADR-007) handed to the client over the authenticated channel.
- `GET /sent-file?session=&path=&token=[&inline=1]` — files delivered by `SendUserFile`
  (ADR-043), behind a third scoped token. The path must match an entry in that session's
  `sentFiles` **read from canonical state in-process** — no renderer round-trip, so a
  busy or absent window cannot break or widen it.
- `GET /remote/auth-info` — which auth methods this server accepts, plus the salt/KDF
  params a password proof needs. GET-only.

## What stays through the migration

The transport/auth hardening was unaffected by the SyncCore rebuild and carries forward
unchanged: token/password/tailnet-identity modes, Host allowlist, per-IP throttling with
separate token and password budgets, funnel reject (ADR-039), the pinned tailscale HTTPS
port and its serve reconciliation (ADR-042), tunnel E2E (AES-256-GCM + HKDF, replay
guard), and the scoped mockup/sent-file tokens (ADR-007/043).

The auth *policy* layer on top of it is **built** and documented in
[security.md](security.md) / ADR-052: capability grants, passkeys and the policy modes,
the `shell` step-up ceremony, idle grant decay, and the append-only audit log. What it
adds to THIS layer's contract is three WS frame pairs (`auth-webauthn-start` /
`-challenge` / `-finish`, `step-up-challenge-request` / `step-up-challenge`, and the
`enrollToken` field on the existing `auth` frame — all additive, so an older cached
bundle's frames stay byte-compatible), the optional `webauthn` block on
`GET /remote/auth-info`, and close code **4009** for "the auth surface changed, reconnect
and re-authenticate". ADR-054 adds one more close code to this layer — **4010**, "the
strong tier reached this session's absolute max-age; the stream is cut, reconnect and
expect a ceremony" — plus the `authcfg:*` command namespace (a `query` read and four
`admin` writes), which is ordinary invoke traffic and needs nothing new on the wire.
Everything about what any of those mean lives in security.md, not here.

**One thing phase 4d added to this layer's contract:** the listener no longer depends on
a window existing. Core boots — including this server and its autostart — before any
window decision, and `CLAUDEUI_NO_WINDOW=1` runs it with no window at all
(`src/main/boot-core.ts`; smoke test `src/e2e/flows/windowless-boot.e2e.test.ts`). The
one host-local thing the server still does with a window, when there is one, is push
`remote:status` to it.
