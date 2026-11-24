# Remote access — transport + auth, as built

Part of [architecture/](README.md). **Status:** as-built record of the remote
**transport and authentication** layer — the HTTP+WS listener, the wire frames, the auth
modes, E2E encryption, the scoped URL tokens and the tunnel/TLS front ends. This is what
carries sync; it is not where sync is designed.

**The sync architecture lives in [sync-core.md](sync-core.md)** (canonical state, the
emission funnel, the shared reducer, replication, queue, terminal, headless), with the
per-channel classification in [sync-channels.md](sync-channels.md) and the auth _policy_
model — capabilities, step-up, grant decay, audit — in [security.md](security.md).

This file used to be the "as built" counterweight to sync-core.md's target design, and
carried a defect ledger from the 2026-08-13 sync-drift review. **SyncCore phases 0-4 are
landed, and every defect in that ledger is closed** (each is recorded with its closing
stage in sync-core.md — the snapshot watermark race, drop-before-mount, the privileged
desktop renderer in both halves, opt-in fan-out, queue ghosts, and the RPC-not-events
gap). What is left here is the part the rebuild did not change.

## Components

| Piece             | File                                                                            | Role                                                                                                                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remote server     | `src/core/services/remote-server.ts`                                            | HTTP + WS listener; auth (ADR-039/042), E2E (tunnel), mockup/sent-file routes (ADR-007/043); serves the web client bundle                                                                                                                                                                            |
| Dispatcher        | `src/core/services/remote-dispatcher.ts`                                        | Routes WS `invoke` frames to the same handler functions as desktop IPC. What a remote client may reach is decided by CAPABILITY GRANTS in the command registry (`ipc/command-registry.ts`), not by the old `BLOCKED` denylist                                                                        |
| WS broadcaster    | inside `remote-server.ts`                                                       | A plain funnel SUBSCRIBER: `addSyncSubscriber((seq, channel, args) => broadcast(...))`, registered on `start()` and dropped on `stop()`. It broadcasts the ring's own seq and never re-numbers                                                                                                       |
| Desktop transport | `src/main/services/sync-port.ts` + `src/renderer/src/sync/desktop-transport.ts` | The desktop renderer is client #1 over a `MessagePortMain` pair, speaking the same frames as a WS client. One channel per renderer LOAD; the subscriber is registered only once the first `sync` has been answered, in the same tick                                                                 |
| Web client        | `src/web/` (`connection.ts`, `api-adapter.ts`, `main.tsx`)                      | Dynamically imports the renderer's own `App`/stores. `api-adapter` builds its pass-through `ClaudeAPI` members from `shared/api-invoke-table.ts` (the table the preload uses) and hand-writes only what is web-specific; both clients subscribe to events through `core/shared/sync/client-registry` |
| Auth              | `src/core/services/remote-auth.ts` + `remote-server.ts`                         | Password + passkey admission, origin classification, throttling, constant-time compares, step-up proofs (ADR-056)                                                                                                                                                                                    |
| Tunnel + TLS      | `src/core/services/tunnel-manager.ts`, `tailscale-manager.ts`                   | cloudflared quick tunnel (mandatory E2E) and `tailscale serve` on a pinned HTTPS port (ADR-042)                                                                                                                                                                                                      |

## Wire protocol (`src/shared/remote-protocol.ts`)

Four frame families, and the same four carry BOTH transports (WebSocket for the web
client, `MessagePort` for the desktop renderer — no auth frames on the port, because the
port IS the trust; `invoke-chunk`, below, is a WS-only slice of an `invoke`):

- `invoke` / `invoke-response` — client actions, RPC mirroring `ipcRenderer.invoke`.
  The web client's one fire-and-forget diagnostic rides it too: `sync:report-timing` (a `chat`
  query, remote-only) reports the cost of applying a `sync-full` into the host log — see
  [security.md](security.md) §Capability grants.
  `invoke-progress {id, done, total, phase}` (ADR-102) rides alongside for a `withProgress`
  channel: sent only to the requesting socket, throttled to 4/s, ending with one `phase:'sending'`
  frame just before the response; each frame slides the web client's 30 s invoke timeout. The
  desktop renderer gets the same reports over the host-local `invoke:with-progress` /
  `invoke:progress` IPC pair, because its invokes ride `ipcRenderer.invoke`, not the port.
  The `withProgress` channels today are `session:load-history` (optional 4th wire arg
  `{deferStatusLine: true}` skips the cost pass), `session:load-status-line` (the status line
  that pass would have returned, same `fs-read` capability) and `session:load-subagent-history`
  (reports nothing itself; the transport's `sending` frame is what re-arms the web timeout).
  `invoke-chunk {id, index, count, data, channel?}` (WS-only, client → host) carries ONE invoke
  too large for a frame: the host's `ws` `maxPayload` is 4 MiB for every frame (a pre-auth
  amplification bound), and under E2E an attachment's bytes are base64'd twice (~1.78x). The web
  client sends an invoke whose JSON exceeds `INVOKE_CHUNK_CHARS` (512 Ki chars) as paced slices of
  that exact JSON, one upload at a time, only to a host whose `auth-response` advertised
  `invokeChunks {maxChars}`; an older host gets single frames and a too-large request is refused
  client-side with a clear error instead of a frame that closes the socket. The host reassembles
  POST-AUTH ONLY and hands the parsed request to the ordinary `handleInvoke`, so step-up, the
  capability check and the audit row are exactly those of a single frame; the reassembled
  `channel` must equal the one chunk 0 named. Chunk 0's `channel` exists so the host can refuse up
  front what the invoke path would refuse anyway (a pure pre-check: unregistered channel, the
  terminal/IDE toggles, the step-up table — no window refresh, no revoke), and a socket without the
  base remote surface (enroll-only) cannot start a transfer. Limits: 48 Mi chars per request, 2
  transfers per socket, 256 Mi chars across all sockets (summed from the live client records on
  every chunk, never counted), 60 s idle (swept on the ping tick). Every refusal of a chunk with a usable id answers
  `invoke-response {ok:false}` for the id and leaves the socket open. The client paces on
  `bufferedAmount`, arms the 30 s invoke timeout only once the upload has drained, and closes the
  socket on a 30 s stall (a half-open link). `sendPrompt` reports the upload as client-side
  progress (`phase:'uploading'`), which drives the input box's per-attachment rings.
- `event {seq, channel, args}` — server pushes. The seq is the ring's, assigned once.
- `sync {lastSeq, epoch, chunked?}` → `sync-catchup {events}` or `sync-full {state}` — the
  reconnect protocol. The snapshot is canonical state in the main process
  (`SyncCore.getSnapshot()`), serialized in the same synchronous tick its `seq` is read.
  The full/catchup branching lives in `src/core/shared/sync/sync-decision.ts` so the two
  transports cannot answer one `sync` differently. `chunked: true` (the web client always
  sends it) asks for a FULL answer as `sync-full-chunk {index, count, totalChars, data}`
  frames — slices of the exact JSON of the `sync-full` that would otherwise have gone as
  one frame, so the joined text parsed IS that message. A browser WebSocket delivers whole
  messages only, so this is what lets the phone's "Syncing state..." overlay draw a real
  progress bar (ADR-102 amendment). `count`/`totalChars` repeat on every chunk, the client
  finishes at `index === count - 1`, and a catchup is unaffected. An old tab that omits
  the field gets the single `sync-full` — the only skew direction, since the host serves
  this bundle (ADR-060/099).
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
- `GET /mockup/<token>/<id>/<b64cwd>/…` — mockup preview HTML and assets, behind a
  separate low-privilege token (ADR-007) handed to the client over the authenticated
  channel. The token is a path segment, so the mockup's relative asset URLs carry it.
- `GET /sent-file?session=&path=&token=[&inline=1]` — files delivered by `SendUserFile`
  (ADR-043), behind a third scoped token. The path must match an entry in that session's
  `sentFiles` **read from canonical state in-process** — no renderer round-trip, so a
  busy or absent window cannot break or widen it.
- `GET /media-file?job=&token=` — the saved image or video of a media job
  (`generate_image` / `generate_video`), by **job id**, behind the same scoped file token as
  `/sent-file`. It serves only the file the media ledger (`media_job`) names for that id, and only
  while it is still a regular file inside the roots of the session that made it
  (`src/core/services/media-files.ts`); an unknown id, an unfinished job or a path outside the roots is
  a plain 404, a bad token 403, GET/HEAD only, one HTTP Range (a `<video>` seeks).
- `GET /remote/auth-info` — which auth methods this server accepts, plus the salt/KDF
  params a password proof needs. GET-only.
- `GET /vscode/enter?it=` — spends a one-time IDE entry token (ADR-064) minted by
  `ide:mint-entry`, sets `claudeui-ide=<32-byte id>; HttpOnly; SameSite=Strict; Path=/vscode`
  (+ `Secure` behind `tailscale serve`) and 302s into the workbench. Detail-free 403 on
  anything else; the origin is re-checked here, not only at mint.
- `/vscode` + `/vscode/*` (all methods **and the WS upgrade**) — reverse-proxied to the
  host's own `serve-web` child on 127.0.0.1, behind that cookie. The client's `Host` is
  forwarded **unchanged** (the workbench embeds it as its `remoteAuthority`) and upstream's
  status/headers pass through verbatim — no `securityHeaders`, no CSP of ours — with ONE
  exception: the workbench ROOT document of a session that named a `themeKind` at mint is
  buffered and its construction-options meta tag rewritten so the IDE opens in the client's
  colour scheme (ADR-064 amendment; fail-open to the untouched bytes on any surprise). Our
  `claudeui-ide` cookie and the hop-by-hop headers are stripped on the way out; a refused
  upstream connection answers our own auto-refresh 503. The route arm sits **above** the
  static branch, whose `endsWith('.js')` catch-all would otherwise hijack every workbench
  bundle. The `wss` is `noServer` since this route exists: one hand-routed `'upgrade'`
  handler runs the funnel/Host/Origin gates and then routes `/vscode/*` here and everything
  else into the control plane.

## What stays through the migration

The transport hardening was unaffected by the SyncCore rebuild and carries forward
unchanged: Host allowlist, per-IP throttling, funnel reject (ADR-039), the pinned
tailscale HTTPS port and its serve reconciliation (ADR-042), E2E itself (AES-256-GCM

- HKDF, replay guard, per-connection session keys derived at activation), and the
  scoped mockup/sent-file tokens (ADR-007/043).

**What ADR-056 moved, stated against that list.** The METHODS narrowed to password

- passkey (+ the enrollment link): the bearer token is gone and ambient tailnet
  identity is a username hint rather than an admission. E2E widened from
  tunnel-only to tunnel + LAN, on a persistent per-install key for the latter. And
  the two throttle budgets collapsed into ONE, in code and not merely in practice:
  the loose 10-per-60 s token budget is deleted, and every credential failure —
  password proof, passkey assertion, enrollment link, and a **channel-key
  activation whose first encrypted frame does not decrypt** — spends the strict
  5-per-5-minutes budget. The constant-time compare, the XFF keying behind serve,
  and the "refuse at connection time, before the frame" placement are untouched.

The auth _policy_ layer on top of it is **built** and documented in
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

One ADDITIVE field followed it: `auth-response.webauthnCapableOrigin?: true`, present
exactly when `resolveWebauthnOrigin(Host, tlsServe)` returned an RP ID for that socket.
It is the server's own origin verdict, echoed because the client cannot compute it — a
browser can only observe "am I a secure context", which the Cloudflare tunnel passes
while its RP ID is an ephemeral name the next link does not share. ABSENT rather than
`false`, so a SERVER that predates the field reads as "not capable" and the client
withholds an enrollment offer instead of inventing one — presence is the whole test, and
that is the safe direction to be wrong in. It is a UI signal and never an authorization one (see
security.md §Enrollment & recovery).

**One thing phase 4d added to this layer's contract:** the listener no longer depends on
a window existing. Core boots — including this server and its autostart — before any
window decision, and `CLAUDEUI_NO_WINDOW=1` runs it with no window at all
(`src/main/boot-core.ts`; smoke test `src/e2e/flows/windowless-boot.e2e.test.ts`). The
one host-local thing the server still does with a window, when there is one, is push
`remote:status` to it. **And since S3 the listener has a second host entirely:**
`claudeui-server` (`src/server`) boots the same `src/core` service graph with no Electron
present at all and starts this listener from its own arguments — see
[sync-core.md](sync-core.md) §Topology.

## `claudeui-server`: the monitor, versions and self-update

`claudeui-server serve` (the default command) does not run the server itself: it starts a
small **monitor** (`src/server/monitor.ts`) that opens no database and boots no service, and
runs the real server as its child, `serve --worker` plus the same flags. The monitor is
what makes a relaunch or an update from the web client possible: the worker asks for a
restart by exiting with code **75**, and the monitor starts a worker again. Every other
exit passes through — the monitor exits with the worker's code (and re-raises a signal
that killed it), so a supervisor sees the server's own outcome. More than 3 restarts
within 60 s with no worker reporting healthy in between end the monitor with exit 1 (a
healthy worker resets the count). `--disable-auth` reaches the first worker only: the
policy it sets is persisted, and a worker restarted later must not undo a change made in
Settings since; `--port`, `--bind` and `--tls` reach every worker. `--no-monitor` runs the
server in-process, as before: relaunch and self-update are then unavailable, and updates
are only announced. `show-link`, `set-password` and `voice-worker` never start a monitor.

**Layout.** The folder you installed is the root; the monitor always runs from it and is
replaced only by a reinstall.

```
<root>/claudeui-server[.exe]     the monitor, and the flat install's worker
<root>/claudeui-install.json     the server install marker (kind: server)
<root>/versions/<v>/             one whole server folder per staged release
<root>/current                   the version the monitor runs; absent → the flat install
<root>/pending                   a worker's update request { token, from, to }
```

`current` is used only when it names a release, `versions/<v>` is a valid server folder of
that version, and `<v>` is newer than the monitor's own build; otherwise the monitor removes
it and runs the flat install. So an install with no `versions/` adopts the layout on its
first update, and a reinstall of a newer release over the root wins over an older staged
one. Run from source (`bun src/server/main.ts`) the monitor always runs the same source.

**Updates** (the core service is `src/core/services/app-update.ts`; the server's half is
`src/server/worker-host.ts` and `src/server/server-versions.ts`). A verified release archive
is extracted into `versions/.partial-<v>-<t8>/` (which first gets a `.claudeui-staging` file
proving it is the stager's), its root folder stripped, the executables marked executable; it
must carry a server marker naming `<v>` and this platform's executable, and is then renamed
to `versions/<v>` (on Windows, retried for about 30 s while antivirus holds the new files;
after that the partial is left for the next staging, which sweeps leftover partials first). Applying writes `pending` and restarts
(exit 75). The monitor writes `current = <v>`, starts the new worker and waits up to 90 s
for its health record (`~/.claude/ui/relaunch/health/<key>.json`, written once its listener
is bound). Healthy: result `updated`, `pending` removed, and every release folder but the
running one and the previous one removed. Not healthy in time, or the worker exits first:
it is stopped by pid, `current` goes back to what ran before (removed for the flat install),
that worker starts again, result `rolled-back`. Results are
`~/.claude/ui/relaunch/server-<token>.result.json`, read back by `app:last-relaunch`. A
monitor stopped during that window leaves `current` and `pending` in place, and the next
start reopens the window; so does a rollback that cannot restore `current` (the monitor
keeps `pending`, and never applies that request again in the same run). The only recursive
delete is one gate (`removeServerVersionDir`): a direct child of `versions/` with our name,
a real directory (never a link), holding a server marker (or, for a `.partial-*`, the
stager's `.claudeui-staging` file), and not the version `current` or `pending` names.
Nothing at the root is ever deleted but `current` and `pending`. An update needs a
supervised worker, a compiled build, a writable root and a root marker (an install older
than the marker reinstalls once to enable updates).

**Running it under a supervisor.** The monitor is the service's main process; restarts for
updates happen inside it, so the supervisor only restarts on failure.

- **systemd:** `ExecStart=/opt/claudeui-server/claudeui-server --bind 0.0.0.0`,
  `Restart=on-failure`, `KillMode=mixed` (SIGTERM to the monitor, which forwards it to the
  worker), `TimeoutStopSec=15`. The service user must own the install folder for updates.
- **launchd:** a LaunchAgent/Daemon with `ProgramArguments` pointing at the root executable
  and `KeepAlive` → `SuccessfulExit = false`.
- **NSSM (Windows):** the application is the root `claudeui-server.exe`; keep the console
  stop method first (Ctrl+C reaches the worker on the shared console; the monitor waits 8 s
  for it, then ends it by pid) and give it at least 15 s before the next method.
- **Containers** (detected by `/.dockerenv`, `/run/.containerenv`,
  `KUBERNETES_SERVICE_HOST`, or docker/kubepods/containerd in `/proc/1/cgroup`): updates
  are announced, not installed. Update the image instead.
- **Windows Firewall:** an application rule is per executable path, and an updated worker
  runs from `versions\<v>\claudeui-server.exe`, so allow the **port** instead, e.g.
  `New-NetFirewallRule -DisplayName "ClaudeUI server" -Direction Inbound -Protocol TCP -LocalPort 8443 -Action Allow`.
- **macOS Application Firewall** (when it is on): it also approves executables one by one
  (by path and code signature), so an updated worker at `versions/<v>/claudeui-server` is a
  new application to it. Approve it
  (`sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add <path>`, then `--unblockapp <path>`),
  or leave the application firewall off for this host and filter the port with `pf`
  instead. The Updates panel shows a notice about both firewalls on macOS and Windows.

## Remote IDE: probed facts about `code serve-web` (ADR-064)

Probed against VS Code 1.135.0 (2026-08-31); the remote IDE design leans on these.

- The workbench bits cache under `~/.vscode/cli/serve-web/` (per commit, downloaded from Microsoft's update server on
  first run: a one-time outbound need per CLI version; air-gapped hosts must pre-seed it).
- `--server-data-dir` controls only the served profile (settings/extensions); we do not pass it, so the profile is
  shared with any manual `serve-web` use.
- Token behavior: HTTP requests without the token get 403; `?tkn=` answers 302 and exchanges into a `vscode-tkn`
  cookie (7 days, SameSite=Lax, deliberately not HttpOnly: the workbench JS reads it for its inner protocol
  handshake); cookie-only requests then succeed.
