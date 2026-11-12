# Remote access and its security

Governs: `src/core/services/remote-server.ts`, `src/core/services/auth-policy.ts`, `src/core/services/step-up-tier.ts`, `src/core/services/webauthn-service.ts`, `src/core/services/remote-auth.ts`, `src/core/services/tailscale-manager.ts`, `src/core/services/vscode-web-service.ts`, `src/core/ipc/command-registry.ts`, `src/core/ipc/authcfg-commands.ts`, `src/core/ipc/webauthn-commands.ts`, `src/core/ipc/ide-commands.ts`, `src/core/ipc/remote-view-commands.ts`, `src/core/boot/host-anchor.ts`, `src/shared/remote-protocol.ts`, `src/shared/e2e-crypto.ts`, `src/shared/mockup-url.ts`, `src/main/services/mockup-protocol.ts`, `src/web/`, `src/renderer/src/components/RemoteAccessModal/`, `src/renderer/src/components/SettingsDialog/`

Who may reach the host over the network, by which factor, holding what, for how long, and what stays refused
remotely: the admission model, the transport hardening, the capability grants, step-up freshness, passkeys and
their resumption token, the remote IDE, the remote directory browser and mockup previews on the web client. The
as-built mechanics are `docs/architecture/security.md` (the model) and `docs/architecture/remote.md` (transport
and wire). Neighbours: remote vendor OAuth by paste-back is ADR-057 (`auth-and-accounts.md`); the sync wire, the
volatile lane and the remote re-sync merge are ADR-041, ADR-051 and ADR-055 (`sync-core.md`); `claudeui-server`
and the two hosts are ADR-058 and the one UI bundle is ADR-099 (`core-and-hosts.md`); the mobile surface pattern
is ADR-048 (`ui.md`) and the mobile terminal is ADR-060 (`terminals-and-worktrees.md`).

## The link is the channel, never the identity (ADR-056)

**A URL proves nothing about who holds it. Identity is a passkey or a password.** A URL fragment may carry a
channel key (`#k=`), which opens an encrypted pipe and buys nothing else. What a connection may do is decided by
the credential it presents inside that pipe. The one exception is the enrollment link: single-use, short TTL,
`enroll` and nothing else.

- **Tailnet HTTPS (`tailscale serve`):** TLS, no fragment secret at all. Identity: passkey ceremony per policy;
  break-glass password.
- **Cloudflared tunnel:** E2E with an ephemeral key (dies with the tunnel). Identity: password required, inside
  the ciphertext.
- **LAN direct:** E2E with a persistent, rotatable, DB-stored key. Identity: password required, inside the
  ciphertext.
- **localhost dev:** no channel needed (local, secure context). Identity as on the tailnet.
- **Desktop renderer (MessagePort):** the port is the trust; no identity (`method: 'host'`).

Rules that follow:

- **The token and ambient tailnet admission are gone.** There is no `#t=`, no `token` method, no unsolicited
  accept from the serve headers. The tailnet login survives only as a username hint: `/remote/auth-info` echoes
  it, and it labels a password connection so `RemoteStatus.clientLogins` and every audit row name who it was.
  `?intent=enroll` is inert (the race it broke cannot happen) and the client still sends it. No compatibility
  lane: bundles ship with the server, so a stale cached bundle gets typed refusals, not crashes.
- **The handshake order inverts on E2E origins.** `e2e-activate` first, proving the channel key; the `auth`
  frame and every answer, refusals included, travel inside the ciphertext. Tailnet and localhost keep auth
  first, no E2E. A plaintext socket on an E2E origin is refused (close 4004): the same rule, not an extra one.
  Under policy `off` the E2E channel is still required on those origins (it is confidentiality, not auth).
- **A channel with no identity is refused with a typed `password-required`** ("provision a password on the host
  to use this link"). It spends no failure budget. Starting a tunnel with no password provisioned stays allowed;
  the status surface carries the same warning.
- **A stale `#k=` decrypts nothing**, so the client sends no credential and the socket dies on the pre-auth
  clock (10 s; the web client times activation out and says the link is out of date). **A wrong key spends the
  per-IP failure budget** (the wrong-key client is observable server-side): `#k=` must not be the one secret
  whose online probing is free. The expected key is read at activation, never at socket open, so a socket opened
  just before a rotation cannot activate against the retired key.
- **One origin classifier, three consumers.** `classifyConnectionOrigin` decides the E2E requirement, the auth
  requirements and the username hint; a second copy would be a plaintext side door. `Host` is never an input to
  it: `Host` is attacker-controlled, so it may only upgrade what a connection must present (it still selects the
  WebAuthn origin), never downgrade it. Order: funnel (refuse) -> non-loopback peer is `lan` -> then for
  loopback peers: trusted serve identity headers mean `tailnet-serve`; else this run holds a tunnel key means
  `tunnel` (E2E required); else `localhost`. (A comment in `remote-server.ts` cites this as `ADR-056 §52`; it
  means this section's handshake and classifier rules, ADR-056 §2.)
- **Accepted cost of the unconditional tunnel arm:** while a tunnel runs, a genuine localhost browser classifies
  `tunnel` and must use the tunnel link, because a cloudflared forward and a local process are the same socket.
  So `getStatus().lanUrl` is nulled in exactly one case: a loopback-bind run with a tunnel up (its link has no
  fragment and would be refused 4004). A LAN bind keeps a working link with or without a tunnel.
- **The LAN's WS lane stops being plaintext, and only that lane.** The `/remote` bundle, `/assets/*`,
  `/remote/auth-info`, `/mockup/*` and `/sent-file` on a LAN origin are still plain HTTP, so an active on-path
  attacker can rewrite the bundle and take both the `#k=` fragment and the typed password. Accepted, not fixed:
  closing it needs TLS on the LAN listener, which is a certificate story the product does not have. LAN is the
  weakest origin; `tailscale serve` is the recommended one.
- **A fresh install admits nobody.** With zero credentials and no password provisioned, nothing connects except
  an enrollment link, and `/remote/auth-info` advertises no admitting method. The console-printed enrollment URL
  is the only way in; this is what makes the headless bootstrap a real bootstrap.

### §grant The grant collapse: three outcomes keyed on the method alone

- `webauthn`, `webauthn-resumed`, `password`: `FULL_REMOTE_GRANTS`, the base five (`chat`, `session-config`,
  `config`, `git`, `fs-read`) plus `admin` and `enroll`, under every policy.
- `enroll-token`: `ENROLL_ONLY_GRANTS`, `enroll` and nothing else, never widened by a successful registration.
- `none` (only under policy `off`): `AUTH_OFF_GRANTS`, the base five, never `admin`/`enroll`.

The policy is not an input to `grantsFor`; admission is decided once, at the handshake, so a connection the
server accepted but then refuses on every invoke cannot be spelled. `AUTH_OFF_GRANTS` lacks `admin`/`enroll` so
that enrolling a credential while authentication is off is impossible and the settings session stays
unreachable. The password carries `enroll`: withholding it was theatre once it held `admin` (`webauthn:mint-
enroll-token` is an `admin` verb). The "first device requires the host anchor" property lives in the policy
default (a fresh install admits nobody), not in grant surgery.

**Policy modes.** Stored `remote_config.auth_policy` is NULL (AUTO), `passkey-always` or `off`. AUTO resolves
per connection: at least one enrolled credential means `passkey-always`, else `password`. `password` is
effective-only, never pinned, because pinning it would mean "keep accepting a password after I enrol a passkey",
which `passwordBreakGlass` already says. `legacy` and `passkey-for-grants` no longer exist; stored values
migrated to AUTO. `passkey_tailnet_exempt` is a dead column kept so an older binary's INSERT still works; nothing
reads it.

### The persistent LAN channel key

A 32-byte hex key in `remote_config.lan_e2e_key`, generated lazily on the first start that serves a non-loopback
bind (loopback-only runs mint none). Persistent so a LAN bookmark survives restarts; rotatable so it is not one
leak from permanent. It is a secret: never in `sanitizedRemoteConfig` / `authcfg:get`. Two verbs on both
transports (a headless box has no desktop pane), both gated by a live settings session: `authcfg:lan-link`
(`query`, `admin`; membership of `AUTHCFG_CHANNELS` is the gate, because what gates a verb in that namespace is
what it discloses, not its kind) and `authcfg:rotate-lan-key` (`command`, `admin`; returns the new link).

**Rotation never strands.** `E2ECrypto.init` derives a connection's AES key at `e2e-activate` and never re-reads
the stored value, so established channels survive a rotation, nobody is disconnected, and only new handshakes
need the new key. It audits as `auth:settings-change` with no 4009 sweep (sweeping would disconnect everyone,
including the operator's own phone, to announce a change that does not apply to them). The recovery anchor for
someone holding the retired link is the host (desktop pane or console). Neither verb joins `authcfg:apply`'s
batch: a channel key is not a config field.

### Capability reclassifications

- `session:delete-session` / `session:delete-project` declare `chat`, not `config`: deleting a session removes
  conversations, the material `chat` governs, and must not sit in the bundle held for saving UI preferences.
- **`admin` is exactly the session-security area:** `authcfg:*` and `webauthn:*` (plus their host-anchor twin
  `remote:*`). Vendor/credential channels (`shared-provider:` writes, `auth:*`, `account:*`, `vendor-auth:*`,
  `usage:refresh-prices`) declare `config`: a rename, not a widening, since they are desktop-only by
  registration, which is where the guarantee always lived. `PINNED_CAPABILITIES` holds only entries naming a
  capability the base set does not hold.

### amendment 2026-08-18 — the LAN channel runs a cipher a browser will run

This amendment (2026-08-18) is cited as "ADR-056 amendment (2026-08-18)" in places. `crypto.subtle` exists only in a secure context, and `http://<lan-ip>` is not one, so the E2E channel that this
ADR makes mandatory on LAN was unopenable from any browser. `E2ECrypto` picks its implementation once in
`init()`: `crypto.subtle` present means HKDF-SHA256 + AES-256-GCM through Web Crypto (non-extractable key),
unchanged everywhere else; absent means the same two primitives in pure JS (`@noble/hashes`, `@noble/ciphers`).
The wire format is byte-identical (`base64(nonce[12] || AES-GCM(seq[4] || json))`), and every LAN session is a
mixed pair because the server always has Web Crypto; the two must interoperate in both directions and tests pin
that. Accepted costs: AES in JS costs a phone CPU on this origin only, and the fallback holds the derived key as
raw bytes rather than a `CryptoKey`. Rejected: dropping the LAN key and requiring the tailnet for everything (the LAN address is the fallback an operator
reaches for when something is wrong), self-signed TLS on the LAN listener (certificate lifecycle, trust
prompts) and dropping E2E on LAN. If the cost ever bites, the cure is TLS, not a second cipher. Tests that run in
Node cannot catch a missing `subtle`; the web-client login test removes `subtle` from the client to cover it.

## Transport hardening and the password scheme (ADR-039)

Everything here is authoritative and still in force; ADR-056 removed the token mode and demoted tailnet identity
but left these untouched.

- **Host allowlist** on every HTTP route and the WS upgrade. `Origin === Host` stops only a cross-origin page; a
  DNS-rebinding attacker satisfies it. So `Host` is pinned to values actually served: loopback/`localhost`, this
  machine's non-internal IPv4s, the pinned bind host, the OS hostname (and `.local`), the live tunnel hostname,
  and in TLS mode the exact ts.net `dnsName`. A port must be the bound port or the serve HTTPS port. No
  `*.ts.net` suffix match.
- **A failed credential never falls through to another method:** each assertion, password and enrollment-token
  outcome is answered and the handshake returns; no mode is downgraded into another on a failed attempt. The only
  fall-through is a refused resumption token (ADR-063).
- **One throttle budget:** 5 failures per 5 minutes per key, covering password proof, passkey assertion,
  enrollment link and channel-key activation failures; over budget refuses up front (close 4006, `auth-info` 429).
  Behind serve every peer is `127.0.0.1`, so the key comes from the first `X-Forwarded-For` element, but only when
  the serve-proxied predicate holds; anywhere else XFF is attacker-chosen and ignored. The budget is in memory and
  resets on restart (accepted: the password has a 12-character floor and scrypt makes each online guess costly).
- **Funnel is rejected unconditionally** (HTTP 403 and upgrade refusal) on any request carrying
  `Tailscale-Funnel-Request`: the product never enables Funnel, so its presence is unexpected public exposure.
- **Identity-header trust predicate** (reused by the origin classifier, not reimplemented): TLS mode active for
  this run, socket peer loopback, no Funnel header, `Tailscale-Headers-Info` present (serve sets it exactly when
  it set the identity trio), and only then a `Tailscale-User-Login`. It yields a hint, never an admission. The
  node owner's login is the one string compared (case-insensitive); a tagged node has no owner login and the
  hint turns off, failing closed. Accepted residual: in TLS mode any local process can forge the header on the
  loopback port, which is why the header can never admit anyone.
- **Password is "Option A", deliberately.** The browser derives `H = scrypt(NFC(password), salt, 32, {N:32768,
r:8, p:1})` from the params `/remote/auth-info` advertises and sends `hex(H)` as `pwProof`; the server compares
  `sha256(H)` to the stored hash in constant time. `H` is a replayable bearer proof; accepted because the stored
  value is grind-resistant at rest and, since ADR-056, every origin that carries a password also carries a
  confidential channel (TLS or E2E). Rejected: challenge-response (the server would hold a password-equivalent
  secret at rest) and a PAKE (a new crypto dependency in a phone-facing bundle for a transport that is already
  encrypted).
- **TLS mode binds the HTTP/WS server to `127.0.0.1` only** (the identity-header predicate and its accepted
  residual depend on that). **TLS mode and the Cloudflare tunnel are mutually exclusive per run;** when both are requested the tunnel wins
  and the status reports TLS as off. `RemoteStatus` never crosses the WS (see the host anchor below).
- **Serve teardown:** `stop()` best-effort issues `serve --https=<ourPort> off`; `tailscale serve reset` is never
  issued (it would wipe entries the app did not create). Enabling TLS mode is gated in Settings on a live
  `detect()` probe plus one confirm, because `tailscale serve` on a certs-disabled tailnet silently no-ops.
- **Autostart resilience:** at login the Tailscale daemon may not be up. A failed autostart keeps the
  loopback-only listener, reports the reason in `RemoteStatus.tls.detectionMessage`, and retries 5 times at 15 s
  for plausibly transient failures only (daemon down, unknown status, CLI exec failure). States needing a human
  (not installed, logged out, certs disabled, no operator) are reported once. A manual start fails fast and tears
  the listener down.

## The tailnet HTTPS port is pinned and its serve entry reconciled (ADR-042)

**Decision 1.** The HTTPS port is configuration, not a search: `remote_config.tls_https_port` (default 443) is the
only port `enableServe` binds. A foreign occupant makes it throw `TailscaleServeError('port-occupied')` naming the
occupant; the old 443/8443/10000 fallback walk is gone because silent port drift breaks the one thing TLS mode is
for, a stable bookmark. Any uint16 is accepted (443, 8443 and 10000 remain the Funnel-compatible triple the UI
mentions).

**Decision 2.** A serve failure surfaces app-level through `RemoteStatus.tls.serveError {reason, message}` in a
desktop-only banner with a **Force re-serve** action: the desktop-only `remote:force-reserve` re-runs enablement
with `force: true`, overwriting whatever handler holds the pinned port. It is deliberately destructive to the
occupant, says so, and is never reachable from a remote client.

**Decision 3.** Cleanup is a persisted contract reconciled at startup. On serve success the app persists
`last_serve_https_port` and `last_serve_local_port`; a confirmed `disableServe` clears them. On every startup,
before autostart (`reconcileServeRecord`), if the live serve config shows that HTTPS port proxying to
`127.0.0.1:<recorded local port>`, the entry is provably ours and is removed with a targeted
`serve --https=<port> off`. The same record feeds the `ours` classification in `getServeStatus`, so a stale own
entry can never again look foreign. This one mechanism covers graceful quit races, crashes and force-kills.
Quit-time teardown stays fire-and-forget: making it await delays every quit and still cannot cover a force-kill.
Accepted: after a force-kill the dead entry lingers until the next launch. Two instances pinning one port conflict
visibly (banner plus force-steal) instead of drifting. Rejected: fixing only `ours` detection (keeps silent
drift for foreign occupancy) and probing dead loopback targets (could clobber another app's restarting entry).

## Passkeys, capability grants, decay, the no-auth switch and the terminal (ADR-052)

**Decision 1. WebAuthn passkeys are the primary factor.** Enclave-held keys, `userVerification: required`,
server-side single-use challenges (about 2 minutes), so an assertion cannot be silently replayed; that is what
makes decay prove human presence. One fixed user handle plus discoverable credentials (no username step). Public
keys live in `webauthn_credential`; the `backedUp` flag is surfaced because revoking a synced credential removes
it everywhere it syncs. The RP ID comes from the `Host` the allowlist validated, never from anything the client
asserts, and exactly two origins qualify (`resolveWebauthnOrigin`): the tailnet DNS name and `localhost`. The
Cloudflare tunnel is HTTPS but its hostname is ephemeral, so no passkey there; a machine or tailnet rename
requires re-enrollment (accepted). Sign counters are recorded, never enforced (`counter: 0` is fed to
`@simplewebauthn/server`): synced passkeys legitimately report 0 forever and enforcement would lock out the
credentials this design is built around. Implemented with `@simplewebauthn/*`, never hand-rolled COSE.

**Decision 2.** The password stays as break-glass, enabled by default (`passwordBreakGlass`), with a "passkey
only" toggle. The toggle applies only where a passkey is possible: on LAN and tunnel, `passwordAuthAllowed` /
`passwordStepUpAllowed` ignore it, because honouring it would leave those origins with no admission credential
and is how people lock themselves out. Its cached proof authenticates the browser, not provably the human; that
is accepted for break-glass only.

**Decision 3. Policy modes** are the three in ADR-056 above plus the master switch. **`off` disables all
authentication** and requires: explicit host-anchor opt-in with a typed confirmation (`disable remote
authentication`), a persistent non-dismissible warning banner on the desktop settings surface and on every
connected web client (keyed on `auth-response.authDisabled`, set on every accept while the effective policy is
`off`, not on `method === 'none'`), audit rows on enable and disable, and a startup log warning. It is never
reachable from a remote client: `remote:set-config` has no remote registration at all, which is the structural
reason (a passkey connection does hold `admin`). Auth-mode `off` forces step-up tier `off`. An auth-surface
change (policy, effective policy, break-glass, tier, the timing dials, including the AUTO flips from enrolling
the first or revoking the last credential) appends one `auth:policy-change` audit row and drops every live client
with close code 4009, sparing the actor, who is re-snapshotted in place. 4009 means "the rules moved, reconnect
and re-decide", never a credential rejection. Other close codes a client must not misread: 4010 (strong-tier
session expired), 4008 (the password this socket used was rotated; for the actor of `authcfg:set-password` it is
a success signal), 4006 (throttled; stop retrying), 4004 (E2E activation required or unavailable).

**Decision 4. Capability grants, fail-closed.** Every command declares one capability: `chat`, `session-config`,
`config`, `git`, `fs-read`, `shell`, `ide`, `admin`, `enroll`, `host` (desktop shell only). A command with no
declaration does not register, which inverts the old denylist's failure mode ("forgot to block it" meant
exposed). Reachability over a transport is "registered for that transport AND the capability is in the
connection's grants"; a channel with no remote registration is unreachable by structure. Each channel is declared
once and both registrars spread the same declaration, so the transports cannot drift (`remote-channel-parity`
test). Host-physical verbs (`session:pick-folder`, `app:open-in-vscode`, `window:*`) declare `host` and have no
remote registration. `enroll` exists to be separable from `admin`: a one-time link can register a credential and
reach nothing else. Every connection carries an identity (`method`, `label`, connect time) attached to each
command, feeding the audit log and per-client subscriptions. The sweep that registered most of the config surface
remotely is deliberate: everything is changeable from the remote UI except host-physical verbs; `log-viewer:*`
stays pinned `admin` and unregistered (window chrome).

**Decision 5. Grant decay, `shell` only** (and `ide`, below): idle means no shell-bearing acts for
`shellGrantIdleMinutes` (default 10); expiry means the next act answers `needs-step-up` and a fresh ceremony is
required. It applies in `passkey-always` mode too (a passkey at connect is not the evidence a passkey ten minutes
in is). Step-up is passkey-first, with the password as fallback where passkeys are unavailable or break-glass is
on. The challenge is bound to its own `step-up` kind (a handshake challenge cannot be replayed into a grant) and
both factors spend the same failure budget. Enforced server-side; client caching is irrelevant. (ADR-054
narrowed what decay gates and what feeds it.)

**Decision 6. The terminal is unblocked** behind three gates: the host-anchored "Allow remote terminal" toggle
(`remote_config`, off by default; written only through `remote:set-config`), the `shell` grant, and step-up.
Multi-attach makes any remote shell observable from the desktop. The audit records terminal lifecycle metadata,
never keystrokes or PTY content (they capture secrets); voice follows the same rule (who opened a microphone,
never audio or transcript). The toggle withdraws the SHELL, not the ceremony: with the toggle off the step-up
still runs (it is the only way to satisfy the settings gate on every tier and the strong tier's mutation window,
and the terminal ships off) and arming withholds `shell` while recording the presence proof; every terminal verb
stays refused by the transport gate and the service-layer backstop. Terminal slot indexes are bounded
(`MAX_POOL_INDEX`, 64): the index is attacker-controlled data on a granted socket and claiming a slot pads the
pool. `terminal:pool` declares `shell` (an inventory of live shells), while `terminal:availability` is answerable
without the grant. This supersedes the audit-era `terminal:*` denylist and ADR-048's decline of mobile terminals.

**Decision 7.** The audit log is append-only SQLite: commands with identity, auth events (master-switch flips
prominently), terminal sessions. Mutating commands audit; queries do not. The `capability` column of `auth:*`
rows names the capability the event is about, not one held at the time.

**§Enrollment.** The first device requires the host anchor, by construction: with zero credentials and no
password nothing connects, so the first passkey comes from the desktop's QR or copied link or the console-printed
URL on a headless first boot. More devices: "Add device" from any `admin`-capable client mints a one-time token
(single-use, 10-minute TTL, in memory so a restart invalidates it); from a remote client that takes a live
settings-editing session (ADR-054 §6). Minting requires `tailscale serve` to be up
and fails with `enroll-unavailable` otherwise: the URL's hostname is the RP ID the credential binds to, so
enrollment always happens at the tailnet origin. A `#enroll=` link yields an `enroll`-only socket; after
`webauthn:register-verify` the client runs the assertion on the same socket and is upgraded in place to
`webauthn` (same connection id, one audit thread). A failed upgrade keeps the socket: the token is spent, so
reconnecting would present a burned credential; the retry re-runs the assertion only. Inline self-enroll works
from any password connection on an origin that can bind WebAuthn; the offer is gated by the server's
`auth-response.webauthnCapableOrigin` (present exactly when an RP ID resolved), a UI signal and never an
authorization one. The desktop renderer never runs a ceremony. Revoking the last credential is refused
(`last-credential-lockout`) only when the policy is explicitly `passkey-always` and no usable password exists.
Recovery from lost passkeys is a console re-mint or the break-glass password; there is deliberately no
network-reachable recovery, because that would be a network-reachable bypass.

## Step-up tiers, the host anchor and the settings-editing session (ADR-054)

Two independent axes, both persisted in `remote_config`: the **auth mode** (the login ceremony, above) and the
**step-up tier** `stepUpTier` (`strong` / `medium` default / `off`: post-login freshness). Login auth and
presence freshness are never one knob.

**Decision 1. The tiers.** `strong`: reads and the sync stream are free; every mutating command needs a presence
proof inside its idle window (shell acts `shellGrantIdleMinutes`, default 10; all other mutations
`stepUpMutationIdleMinutes`, default 60); the session has an absolute max-age `sessionMaxAgeHours` (default 4,
max 168), at which the socket is cut with 4010, stream included. `medium`: step-up gates exactly the terminal and
the remote-settings surface; everything else rides connection auth. `off`: nothing is gated post-login (except
the settings surface, below). "Mutating" is the registry's declared `kind` (`command` mutates, `query` reads), so
`kind` declarations are security-load-bearing and pinned by tests; mislabeling a mutating verb `query` is a
security bug. `classifyDispatch` (`step-up-tier.ts`) is the single classification source for the transport gate,
the terminal service backstop and the tests.

**Decision 2. Arm-on-auth.** A login that is a presence proof arms the grants its tier would later gate: only a
passkey ceremony (handshake assertion or the enroll-to-webauthn upgrade; the arm site keys on `method ===
'webauthn'` exactly). The password never arms at login (its proof is client-cacheable), and neither does
`webauthn-resumed`; both meet the step-up as their first presence proof, and the password remains a valid step-up
factor. Two guards: a narrow-grant (`enroll`-only) socket is never widened by arming or a completed step-up
(keyed on the grant set via `holdsBaseRemoteSurface`); and the tier-`off` waiver confers the `shell` capability
without writing windows, so it cannot buy the settings gate, and flipping the tier back off `off` undoes it.

**Decision 3. Auth-mode `off` implies tier `off`**, flat, with no origin carve-outs: a ceremony cannot be
demanded from an identity never established. **Ordering, ratified:** the settings verbs demand a fresh presence
proof on every tier, `off` included, so Decision 6 outranks the literal "nothing is gated" of Decision 3. The
transport checks freshness before capability, so a connection under auth-mode `off` (which never holds `admin`)
meets `needs-settings-session` first and `Permission denied` only after unlocking; both walls hold.

**Decision 4. The shell read/act split (in `medium` and `strong`).** Reads stay free after decay: an attached
view keeps streaming, `terminal:pool`, `attach`/`detach` and `resize` (display geometry, read-class) cost
nothing. Acts demand freshness: `terminal:create`, `terminal:write` and the `term-input` frame, `terminal:kill`,
`terminal:kill-by-cwd`. First access ever still costs one arming proof per connection (scrollback is sensitive).
Only acting refreshes a window, and only on an already-armed connection (a refresh extends a proof, never
creates one); reads, queries and engine-driven writes slide nothing, because the terminal panel re-asks
`terminal:pool` on every focus and a refreshing read would renew a grant forever. The split is an explicit verb
set (`SHELL_READ_VERBS`), not derived from `kind`: `terminal:attach` stays a `command` so lifecycle audits, and
relabeling it a query would drop it from the audit log. An unclassified `shell` verb fails closed as an act. The
server refuses a stale `term-input` frame silently (an error would be an oracle); the client holds the first
keystroke and drops it rather than replay it at a shell whose state moved. The UI's tab close is an act-class
`terminal:kill`; a read-only surface falls back to detach.

**Decision 5. Audit v12 and retention.** Auth rows carry explicit intent in a nullable `detail` column (command
rows leave it NULL). Retention is a uniform moving purge, `auditRetentionDays` default 365, floor 30, clamped on
read and write, run on DB open and on a timer; auth rows purge on the same window as command rows (an
auth-rows-forever exception was declined). The floor stops a session from erasing the trail of its own
investigation. Channels: `auth:webauthn-assert`, `auth:enroll-token`, `auth:policy-change`,
`auth:settings-change` (a settings write that is not an admission-rule change: no 4009), `auth:session-expired`,
`auth:settings-session` (an editor opened or explicitly ended; a TTL expiry writes nothing), `auth:resume`.

### §6 The host anchor and the settings-editing session

**Decision 6.** "Desktop-only" meant "requires being on the host"; the headless deployment forces naming it.

- **Auth-disabling operations are host-anchor only, forever:** the `off` master switch and anything else that
  disables authentication, via the desktop renderer or the server's own console/config. Never the web, even
  behind a fresh ceremony: a stolen stepped-up session must not turn auth off. No password step-up reaches it
  either; the line is which operation, not which factor.
- **Structural guard:** every `remote:*` mutation (`start`, `stop`, `set-config`, `set-password`,
  `clear-password`, `force-reserve`, `tailscale-detect`, `interfaces`) is raw host-anchor wiring with no
  registration on either transport; a remote client cannot stop the listener it is talking through or swap its
  transport. Clearing the break-glass password and the transport settings (port, bind host, serve, the terminal
  toggle, the IDE toggle) sit on the same side. The one `remote:*` channel a remote client reaches is
  `remote:status-view`, a redacted read (an explicit field pick, no URL or key; `config`, `query`) so the web
  view can list connected clients; `remote-handlers.ipc.test.ts` pins the absence of every mutation.
- **Routine remote-access settings are web-reachable inside a settings-editing session:** step-up tier, the
  timing dials, break-glass toggle, auth-mode changes among the non-`off` modes, password rotation, audit
  retention. These are the `authcfg:*` verbs, and this makes headless administrable without SSH. Passkey
  management is in the same class: `webauthn:rename`, `webauthn:revoke` and `webauthn:mint-enroll-token` demand
  a live settings-editing session on every tier (`PASSKEY_ADMIN_CHANNELS` in `step-up-tier.ts`, classified
  `authcfg`), and their bodies assert it again. `webauthn:credentials` is a free `admin` read, like
  `authcfg:get`: it is the pane's default state and discloses no secret. The enrollment ceremony verbs
  (`webauthn:register-options`, `webauthn:register-verify`, capability `enroll`) are not in the class, since an
  enrollment-link socket can never open a session. (2026-11-12: passkey management joined the settings session;
  until then the three verbs were classified by `kind` as ordinary mutations.) The `authcfg:*` verbs live in
  their own namespace; the `off` writer stays out of it (`authcfg:apply` refuses `off` with
  `auth-off-is-host-anchor-only`).
- **A password step-up may administer the settings area** (ratified): the break-glass password already carries
  `admin` + `enroll`, and a passkey-only settings area would be unreachable from the LAN and tunnel transports an
  operator falls back to when something is wrong.
- **Headless bootstrap chain:** (1) first boot prints a one-time enrollment URL at the tailnet HTTPS name;
  (2) the first passkey signs the device in, and opening the settings editor costs one deliberate unlock;
  (3) `authcfg:*` then covers day-to-day administration, including `authcfg:set-password`; (4) password-only
  headless is provisioned through the host's own CLI (`claudeui-server set-password`, secret from stdin, never
  argv or env); (5) all passkeys lost means a console re-mint, never a network recovery.
- **The read verb:** `authcfg:get` (`query`, `admin`, no freshness) answers the same sanitized object as
  `remote:get-config` (one sanitizer, `remote-config-view.ts`): a pane cannot administer what it cannot render,
  and a ceremony in front of its own explanation helps nobody.

**amendment (2026-08-16): a bounded settings session replaced the ambient mutation window for this area.** The
pane is read-only by default. "Edit settings" runs the step-up ceremony with `intent: 'settings'`; on success the
server marks that connection as holding a live settings session, TTL 5 minutes (`SETTINGS_SESSION_TTL_MS`).
It is server-side connection state, not a wire token (the connection is already authenticated; a bearer string
adds leakable surface without adding proof), and the intent selects a consequence of a proof verified either way.
Rules: every `authcfg` mutation requires the live session, on every tier; nothing refreshes it (a sliding one
would be the ambient authority again); every `authcfg` settings change is gated regardless of direction, tier
upgrades included; `authcfg:apply` is the editor's Save as one validated batch, one audit row carrying the diff
and one 4009 sweep (except-actor); Save, Cancel, pane close, disconnect or TTL expiry revokes it, checked lazily
at dispatch. `authcfg:end` and `authcfg:get` are free (gating a revocation is backwards), and a locked editor
answers the typed `needs-settings-session`, which the web client must never cure ambiently (a stale pane must not
raise a biometric prompt nobody asked for; the generic step-up gate never retries it, the security editor
re-locks and lets the operator press Edit, and the passkey pane answers the operator's own write press with its
own labelled unlock prompt and retries that one action once).
`authcfg:set-password` is gated but outside the batch (write-only, its 4008 semantics differ). The desktop pane
has the same states but unlocks without ceremony or TTL (host anchor); the `off` switch and its typed confirm
stay desktop-only inside edit mode. A session that lapses mid-edit re-locks and keeps the draft. Every
registered `authcfg:*` channel is in exactly one classifier set (`AUTHCFG_CHANNELS` gated or
`AUTHCFG_FREE_CHANNELS` free), pinned by test. The mutation-window check for this class is retired.

### §7 Benign ambient cache writes (amendment, 2026-08-28)

A third exception to "`kind` decides what is mutating", after the shell split and `authcfg`: an explicit named
set `BENIGN_CACHE_WRITE_CHANNELS` (today `config:save-slash-commands`), classified `read` above the `kind` line
but below the `ide`/`shell` arms (so no member can buy a shell or IDE verb out of fail-closed). The trigger was an
unrequested biometric prompt on a session spawn: an engine-announced cache write with no user gesture behind it
trains operators to dismiss ceremonies. A channel joins only by a decision recorded in this section, and only if
all three hold: a fixed host path the caller cannot influence, self-healing content (ordinary use overwrites it
wholesale), and a cosmetic blast radius (nothing executes off it). Capability (`config`) and the audit row are unchanged, which is why the
exemption is a step-up table entry and not a `kind: 'query'` relabel (queries skip the audit row). Because the
class is `read`, these writes refresh nothing: an engine-driven write is not presence.

## A reconnect is not a re-authentication: the passkey resumption token (ADR-063)

Identity is per WebSocket, and mobile tab lifecycles kill sockets constantly; a password client replays its
cached proof silently while a passkey client had nothing to replay. After every accepted WebAuthn assertion
(handshake and enroll-to-webauthn upgrade) the server mints a **resumption token**: 32 random bytes, returned once
on `auth-response`, held in `sessionStorage` (`resume-cache.ts`), accepted on a later handshake as a login. It
authenticates the browser, never the human, exactly like the cached password proof.

- **Mint only on a real ceremony;** a resume does not re-mint, so a token's age is always the time since the last
  biometric (a sliding token would be ambient forever-auth). Multiple devices hold independent tokens.
- **Store:** in memory in `webauthn-service.ts`, `sha256(token)` to `{credId, webauthnOrigin, mintedAt}`, capped at
  64 (oldest evicted), pruned lazily. Nothing persists: a host restart logs every passkey device out once, which
  is visible and adds no stored secret class. **TTL 24 hours, a constant** (not a dial). **Multi-use** within the
  TTL: rotate-on-use buys theft detection at the price of a lost-ack race on exactly the flaky reconnects this
  exists for. **Origin-bound:** verified only on the origin that minted it, so it can only exist on a
  WebAuthn-capable origin.
- **Accept** as method `webauthn-resumed`: `FULL_REMOTE_GRANTS` (the bundle the cached password proof already
  has, so nothing widens), attributed to the bound credential's label, and never armed: terminal acts, the
  settings session and strong-tier mutation windows still demand a live ceremony.
- **Refusal falls through as bare auth** (`passkey-required` on the same socket under `passkey-always`): no new
  error code and no failure-budget spend (a 256-bit token is not brute-forceable, and routine invalidations must
  not throttle a legitimate phone). The refusal is audited as `auth:resume`, reason class only, never the token.
- **There is deliberately no `localStorage` "stay signed in".**

**§Invalidation.** A token dies with its TTL; its bound credential (revoking a passkey sweeps its tokens); a
policy flip to `off` (nothing minted before that flip survives it); and a host restart. An ordinary 4009
auth-surface change does not invalidate: the fresh handshake presents the token and the rules in force judge it.

**Amendment to ADR-054's strong tier.** `sessionMaxAgeHours` is measured from the last ceremony, not from connect.
Under `strong` a resume is accepted only while `now - mintedAt < sessionMaxAgeHours`, and the resumed
connection's max-age cut is armed from `mintedAt`; otherwise cut-and-resume would make max-age decorative.
Deferred deliberately: a TTL dial, a `localStorage` opt-in, step-up ceremonies refreshing the mint.

## The remote IDE is the host's own VS Code behind a gate (ADR-064)

The TopBar's VS Code button is real on the web by spawning the user's installed VS Code CLI (`serve-web`) and
reverse-proxying it under `/vscode`. Nothing is bundled or downloaded by the product; the user installs and
licenses VS Code. The remote IDE is shell-equivalent and is treated as such: its own opt-in toggle, ceremony-gated
minting, audited spawn/mint/exit/invalidation, and revoke-in-place on toggle-off.

### §1 Delivery: spawn the user's CLI, never bundle

`VscodeWebService` (built in `core-services.ts`'s remote-access block so both hosts get it) spawns `serve-web`
bound to `127.0.0.1` with a per-spawn random `--connection-token`, `--server-base-path /vscode`,
`--disable-telemetry`, `--accept-server-license-terms` and `--port 0` (port parsed from stdout). One instance per
host, workspaces per tab via `?folder=`. Lazy spawn on first mint; reaped by `killProcessTree` after 30 minutes
with no live proxied socket or request, on toggle-off and on shutdown (a parent-only kill orphans the inner
server, which keeps the port); unexpected death shows an error and the next mint respawns. Detection order:
host-anchored override path, then `code-tunnel(.exe)` near `PATH`'s `code`, then well-known install paths, then
the POSIX `code` CLI; a candidate is valid iff `<candidate> serve-web --help` exits 0 (5 s). On Windows only
`.exe` candidates are auto-probed (running the Electron `Code.exe` would open a GUI; `code.cmd` is a batch
wrapper unusable with `shell: false` spawns); an explicit override is trusted as given. **The operator flipping
the toggle on is the acceptance of the VS Code Server license terms**, so the settings copy links them.

### §2 Admission: two independent gates, ours first

serve-web's own token cannot be the admission secret: the workbench needs it client-side, and its WS upgrade is
not token-gated at the HTTP layer (probed: `101` with no credentials). Gate 1 is ours, on every request and every
upgrade under `/vscode/*`: `ide:mint-entry` returns `/vscode/enter?it=<one-time token>` (single-use, 60 s,
constant-time compare); the entry route exchanges it for an in-memory cookie session (`claudeui-ide`, 32 random
bytes, `HttpOnly; SameSite=Strict; Path=/vscode`, `Secure` behind `tailscale serve`) and redirects into the
workbench. Anything else under the prefix without a valid session is refused 403 with no detail. Sessions: 24 h
absolute cap, at most 16, cleared by toggle-off, by every 4008/4009 sweep and on server stop; clearing also
destroys live proxied sockets, because our gate runs only at request and upgrade time. Gate 2 is serve-web's
token, exposed only to browsers that passed gate 1. The listener's pre-route gates (Funnel refusal, Host
allowlist) cover `/vscode/*`; the route arm sits above the static-asset branch (whose `.js` catch-all would hijack
workbench bundles). The `wss` is `noServer` with a hand-routed upgrade handler (control plane through the
existing gates; `/vscode/*` through the IDE session gate; anything else destroyed).

### §3 Origin policy: tailnet and localhost only, one place to widen

The IDE's traffic is ordinary browser fetch/WS and cannot ride the E2E envelope, so over the tunnel source and
shell traffic would reach Cloudflare's edge in plaintext (the exposure ADR-039 refused), and plain-HTTP LAN
cannot boot the workbench (no secure context, no service worker). `ideOriginPolicy` allows
`IDE_ALLOWED_ORIGINS = ['tailnet-serve', 'localhost']`; it is consulted at mint, at `/vscode/enter` and in the
availability answer, and it is the one refusal no ceremony can cure (hence `IdeAvailability.originAllowed` is
separate from `allowed`). Widening later is that one const plus a recorded decision (a tunnel would need an
explicit accepted-risk banner). Tunnel and LAN users see the button explain itself rather than work.

### §4 Capability, ceremony, decay: the `shell` shape on its own toggle

New capability `ide`, in no static grant set: the step-up ceremony confers it iff `allow_ide` is on, and
toggle-off revokes it in place (`applyIdePolicy`: revoke grants, clear cookie sessions, destroy proxied sockets,
kill the child), deliberately not a 4009. `ide:availability` is `config`, a free query on both transports (asking
"may I?" must be answerable without the grant). `ide:mint-entry` is `ide`, `kind: 'command'` (auto-audited),
classified `shell-act` (an unclassified `ide` verb is an act), toggle re-checked at dispatch, pinned in
`PINNED_CAPABILITIES`. Decay applies to minting; a live IDE session is not cut by it (decay refuses new acts, it
does not sever what is attached). The typed `ide-unavailable` error carries its reason union in the availability
answer.

### §5 Persistence and surfaces

`remote_config` gains `allow_ide` (default 0) and `ide_cli_path`, both written only through the host-anchored
`remote:set-config`, never `settings.json`: `config:save-settings` is remotely reachable, and a remotely writable
path the host later spawns would be remote code execution by config write. Reads fail closed (`readIdePolicy`).
Desktop settings carry an "Allow VS Code on the web" toggle plus an optional CLI-path field; turning it on runs
the probe at once and shows the typed result. On the web, toggle off hides the button; on, the click runs the
step-up first when `needsStepUp`, then mints, then opens the entry URL in a tab. If the browser refuses the
post-ceremony open the UI says "unlocked, click again" and the second click takes the synchronous fast path.
Origin refused or probe failed opens an explanatory dialog with the typed reason (explain, do not stonewall).
Desktop button behaviour is unchanged (`vscode://` deep link, no host question asked).

**Accepted consequences.** No per-command audit of the IDE's content: edits and terminal use inside VS Code
bypass the registry (the keystroke precedent, widened to a full editing surface). `?folder=` is not a boundary:
an IDE session reaches whatever the host user can and bypasses any sync-layer redaction, which is why `ide` is
separate from `shell`. The serve-web child is a localhost HTTP server any local process can reach, bounded by the
loopback bind, the per-spawn token and its in-use lifetime. Server bits come from Microsoft's update channel,
cached per commit; an offline host fails with a typed reason.

**amendment (2026-08-31, live-test polish).** (1) The workbench opens in the client's colour scheme: mint carries
a derived `themeKind` (`dark`/`light`, cosmetic end to end, never a refused mint), and the proxy's one exception
to verbatim pass-through buffers the workbench root document of a themed session and rewrites its
`vscode-workbench-web-configuration` meta (`vscode-workbench-theme.ts`); every surprise fails open to the
untouched bytes, assets and unthemed sessions stay byte-identical, and an explicit in-workbench theme choice wins
on later loads. The interstitial pages wear the same scheme. (2) The ceremony runs before the tab opens, not in
a background tab behind a blank page; the invoke gate remains the backstop for the availability-to-mint decay
race.

Rejected: bundling `openvscode-server` or `code-server` (size, bump burden, degraded marketplace), VS Code Remote
Tunnels (identity moves to a Microsoft/GitHub account and transport to their relay; unintegrable with
passkeys, capabilities and audit), relying on serve-web's token as the gate (probed false), a Monaco in-app
editor (not VS Code; revisit only for a mobile quick-edit need).

## The remote directory browser lists any host directory (ADR-046)

On the web client `session:pick-folder` is permanently denied remotely (a native dialog would open on the host's
screen), so the folder pick is a host-backed browser over `file:list-dir`.

**Decision 1.** Web-only: when `window.api.platform === 'web'` "Browse path..." opens a host-backed browser
(today `DirectoryBrowserDialog`: a centered modal with a RECENT/PLACES rail and a browse pane, and below 768 px a
full-screen two-view drill-in, forked in JS on `useIsMobile`). The desktop keeps the native dialog. Rail clicks
only navigate; confirm re-validates against the host (`listDir(path).resolvedPath` non-empty means the directory
exists on the HOST), and only a path the host resolved reaches `onConfirm`. Programmatic input focus is
desktop-only (it raises the phone keyboard on every tap). `listDirEntries('')` answers the host's home directory.

**Decision 2.** `file:list-dir` keeps its unconfined posture (declared `fs-read`, hides dotfiles and build/VCS
noise); no path containment was added. An authenticated remote client can already start a session in an arbitrary
cwd and run full `git:*` mutations, so a listing is strictly weaker than what it already holds, and confining it
would break browsing to a brand-new directory, the feature's purpose. **If the remote trust model ever weakens
(scoped or guest credentials), containment must be revisited here first**; `isPathInside` in
`path-containment.ts` is the ready primitive. `file:list-places` (`{home, hostname, drives}`) is registered under
the same `fs-read` capability: strictly weaker reads, best-effort (an undetermined field comes back empty and the
rail hides it). Dot-directories stay hidden, so a dot-named project root must be typed.

**Decision 3.** The browser is the reusable primitive for any surface that needs a host directory on web
(AutomationConfig's cwd field uses it, passing `initialPath`); `useDirSuggestions` holds the shared path
mechanics for the desktop and mobile entry inputs. Rejected: free-text cwd only (typo-prone, no host
validation), un-denying `session:pick-folder` remotely (nonsensical), confining `file:list-dir` to known roots.

## Mockup previews on the web client run in an opaque-origin sandbox behind their own token (ADR-007)

The desktop serves mockups through a privileged `mockup-asset://` scheme with a sub-origin per mockup, which does
not exist in a browser. The remote server serves them over its own HTTP listener at
`/mockup/<token>/<id>/<b64cwd>/...`, reusing the desktop serving core in `src/main/services/mockup-protocol.ts`
(id regex, base64url cwd decode, cwd absoluteness, path traversal, extension allow-list, serve-time bridge and
CSP) so there is one set of security checks. The token is a path segment, not a query parameter, because relative
asset URLs drop the query. The platform split is `ClaudeAPI.getMockupPreviewUrl`.

- **Isolation is the sandbox.** The web iframe is sandboxed `allow-scripts` without `allow-same-origin`, giving
  the mockup an opaque origin so its scripts (the CSP allows inline and eval for the Tailwind CDN) cannot read
  the web client's storage or `window.api`. The postMessage contract on web is: reload target `'*'`, expected
  `event.origin` `'null'`; desktop keeps `allow-same-origin` with the per-mockup sub-origin. The bridge's primary
  trust check is `event.source`; inside the mockup the reload listener trusts `ev.source === window.parent` only
  (a `file://` parent, the packaged desktop renderer, arrives as origin `"null"`).
- **A separate mockup-scoped token, never the control-plane credential.** The per-start random `mockupToken` is
  delivered to the client inside `sync-full` over the authenticated WS, never in the served HTML, and is compared
  in constant time. The iframe URL is readable by the mockup's own scripts, so a hostile mockup can leak at most
  the token, which reads extension-allow-listed files under `.claude/ui/mockups/<id>/` and grants nothing on the
  control plane. A host with no mockup server (headless) answers 404.
- **Accepted:** `localStorage`/`sessionStorage` in a mockup throws on web (the alternative defeats the
  isolation); the CSP self-source is derived per request from `x-forwarded-proto` plus `Host` and could block a
  mockup's own script/style if a proxy omits it. Rejected: HttpOnly cookie auth (browser-specific behaviour for a
  sandboxed iframe), `srcdoc` (relative assets break), and hiding the preview on web.
