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
| Auth | `src/main/services/remote-auth.ts` + `remote-server.ts` | Password + passkey admission, origin classification, throttling, constant-time compares, step-up proofs (ADR-056) |
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

### Handshake ORDER (ADR-056)

The frames are unchanged; which one comes first is not, and it now depends on the
connection's ORIGIN (`classifyConnectionOrigin` — one classifier, see
[security.md](security.md) §Origin classification):

- **Tunnel and LAN** — `e2e-activate` FIRST, carrying nothing: the server
  activates against the key it selected for that origin (ephemeral for the
  tunnel, the persistent `lan_e2e_key` for the LAN) and answers with an
  `e2e-ack` that is **the first encrypted frame**. Only then does the client send
  `auth`, inside the ciphertext, carrying a password proof or an enrollment
  token — and every server answer from there on, refusals included, is ciphertext
  too. A socket that sends anything else first is closed **4004**; that single
  rule is also the plaintext-on-LAN refusal, because on those origins nothing is
  ever read in the clear.
- **Tailnet HTTPS and localhost** — unchanged: `auth` is the first frame and
  there is no E2E, because `tailscale serve` already terminates TLS and localhost
  is local.

Two consequences for this layer. The ack doubles as the client's proof that its
key was right — a stale `#k=` decrypts nothing, so the client sends no credential
and the socket dies on the pre-auth deadline (the web client times its own
activation out at 10 s and says the link is out of date rather than looping).
And `auth-response` is no longer necessarily plaintext, so a refusal must be
flushed before the close: the server orders the two explicitly.

WS-only additions to a `sync-full` answer (`mockupToken`, `fileToken`) stay in
`remote-server`: they exist to build URLs a browser will fetch, which a MessagePort
client never needs.

## HTTP routes

- `GET /remote` — the web client bundle. What rides the URL **fragment** (never a
  query param, so it stays out of server logs and `Referer`) is the **channel
  key** `#k=` on a tunnel or LAN address, or `#enroll=` for a one-time enrollment
  link. The `#t=` access token is retired (ADR-056): a link opens a channel, it
  does not authenticate. The tailnet URL carries no fragment secret at all.
- `GET /mockup?...&token=` — mockup preview assets, behind a separate low-privilege
  token (ADR-007) handed to the client over the authenticated channel.
- `GET /sent-file?session=&path=&token=[&inline=1]` — files delivered by `SendUserFile`
  (ADR-043), behind a third scoped token. The path must match an entry in that session's
  `sentFiles` **read from canonical state in-process** — no renderer round-trip, so a
  busy or absent window cannot break or widen it.
- `GET /remote/auth-info` — which auth methods this server accepts, plus the salt/KDF
  params a password proof needs. GET-only.

## What stays through the migration

The transport hardening was unaffected by the SyncCore rebuild and carries forward
unchanged: Host allowlist, per-IP throttling, funnel reject (ADR-039), the pinned
tailscale HTTPS port and its serve reconciliation (ADR-042), E2E itself (AES-256-GCM
+ HKDF, replay guard, per-connection session keys derived at activation), and the
scoped mockup/sent-file tokens (ADR-007/043).

**What ADR-056 moved, stated against that list.** The METHODS narrowed to password
+ passkey (+ the enrollment link): the bearer token is gone and ambient tailnet
identity is a username hint rather than an admission. E2E widened from
tunnel-only to tunnel + LAN, on a persistent per-install key for the latter. And
the two throttle budgets collapsed into ONE, in code and not merely in practice:
the loose 10-per-60 s token budget is deleted, and every credential failure —
password proof, passkey assertion, enrollment link, and a **channel-key
activation whose first encrypted frame does not decrypt** — spends the strict
5-per-5-minutes budget. The constant-time compare, the XFF keying behind serve,
and the "refuse at connection time, before the frame" placement are untouched.

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
expect a ceremony" — plus the `authcfg:*` command namespace (a `query` read, two gated
`admin` writes and a free `admin` close), which is ordinary invoke traffic. The
only wire change it needed is an additive optional `intent` on the existing
`step-up` frame, which asks the server to open a bounded settings-editing session
on the connection the ceremony just ran on.

ADR-056 is the first of these that is NOT purely additive, deliberately (owner
ruling, ADR-055 precedent — bundles ship with the server, so a stale cached one
gets typed refusals rather than a crash). Against this layer's contract it:
removes the `token` field from the `auth` frame and `'token'` from
`auth-response.method`; makes `auth-response` and every handshake refusal
CIPHERTEXT on an E2E origin; adds the typed `password-required` error and the
`lan-link-unavailable` invoke error; and puts **4004** to a second use — "this
origin must open an E2E channel first". `RemoteStatus` loses `token` and its
`lanUrl` / `tunnelUrl` carry `#k=` instead of `#t=`. Two invoke channels join the
`authcfg:*` namespace (`lan-link`, `rotate-lan-key`), which is ordinary traffic.
Everything about what any of those mean lives in security.md, not here.

**One thing phase 4d added to this layer's contract:** the listener no longer depends on
a window existing. Core boots — including this server and its autostart — before any
window decision, and `CLAUDEUI_NO_WINDOW=1` runs it with no window at all
(`src/main/boot-core.ts`; smoke test `src/e2e/flows/windowless-boot.e2e.test.ts`). The
one host-local thing the server still does with a window, when there is one, is push
`remote:status` to it.
