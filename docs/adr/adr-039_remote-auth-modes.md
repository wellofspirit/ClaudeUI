# ADR-039 — Remote-access auth modes: token, password, and tailnet identity

**Status:** Accepted — serve port selection and teardown amended by ADR-042 (pinned HTTPS port,
persisted-record startup reconciliation; the 443→8443→10000 candidate walk is retired).
Auth **methods & policy superseded in part by ADR-052** (WebAuthn passkeys primary, capability
grants with decay, policy modes incl. audited no-auth switch — `docs/architecture/security.md`);
the transport hardening here (Host allowlist, throttling, funnel reject, identity-header trust
predicate) carries forward unchanged and remains authoritative.
**Relates to:** ADR-007 (two settings stores — remote config lives in the operational DB, not
UISettings), ADR-027 (`data-testid` conventions for the Settings/modal surfaces), ADR-030
(capability honesty — the status must not claim a path that does not work), ADR-042

## Context

`/remote` started as a single-mode surface: `start()` minted a random 256-bit token, the URL carried
it in the fragment, and a QR scan was the only way in. That is fine for "scan and drive from the
couch" but not for the two things users actually asked for — a **bookmark-able** URL, and a server
that **autostarts on a fixed port**. A standing endpoint with a standing credential changes the
threat model: the token no longer rotates per session, the address is predictable, and DNS rebinding
becomes worth defending against.

## Decision

Three auth methods, all advertised through one derivation (`RemoteServer.authMethods()`, mirrored by
`GET /remote/auth-info`), never falling through from one to another on a failure.

### 1. Token (unchanged)

Per-start `randomBytes(32)`, delivered in the URL **fragment** so it never appears in a request line
(and therefore never in a tunnel/CDN access log). Still the only method on the Cloudflare-tunnel
path, because tunnel mode is E2E-encrypted with a key that rides the same fragment.

### 2. Password — Option A, deliberately

The browser derives `H = scrypt(NFC(password), salt, 32, {N:32768, r:8, p:1})` from the salt/params
`/remote/auth-info` advertises and sends `hex(H)` as `pwProof`; the server compares `sha256(H)`
against the stored hash in constant time.

`H` is therefore a **replayable bearer proof**: anyone who observes one handshake can reuse it. We
accept that, with eyes open:

- Storing `sha256(H)` (not `H`) is grind-resistant at rest — DB theft does not yield a credential
  that can be replayed elsewhere, and scrypt already dominates the cost of a dictionary attack.
- Confidentiality in transit is **delegated to the transport**: WireGuard on the tailnet, TLS on the
  tunnel, or the user's own trusted LAN. The Settings UI says so in as many words rather than
  implying privacy we do not provide (ADR-030's spirit applied to a security property).

Rejected alternatives:

- **Challenge-response (HMAC over a server nonce).** Replay-safe, but the server must then hold `H`
  itself — a password-equivalent secret at rest — to compute the expected MAC. That trades a
  transport-visible proof for a stealable one, and the DB is the easier target of the two.
- **A PAKE (SPAKE2/OPAQUE).** Correct answer in the abstract; wrong shape here. It means a new
  crypto dependency shipped into a phone-facing browser bundle for a feature whose transport is
  already encrypted in both supported remote modes.

Password auth is refused outright in tunnel mode: an E2E session needs the fragment key a password
client by definition does not have, so accepting it would authenticate a socket only to close it.

### 3. Tailnet identity (`tailscale serve`)

TLS mode binds the HTTP/WS server to **127.0.0.1 only** and puts `tailscale serve` in front of it
(`serve --bg --https=<port> http://127.0.0.1:<localPort>`), so a browser at
`https://<node>.<tailnet>.ts.net/remote` gets real TLS, no fragment, and no credential prompt.

Serve attaches `Tailscale-User-Login` to every proxied request, WS upgrades included, after
unconditionally deleting any inbound copy — so it cannot be smuggled _through_ the proxy. A socket is
authenticated as `'tailnet-identity'` only when **all** of these hold:

1. TLS mode is active and serve is confirmed up for this run;
2. the socket peer is loopback (`127.0.0.0/8`, `::1`, IPv4-mapped) — only our own proxy can be;
3. `Tailscale-Funnel-Request` is absent;
4. `Tailscale-Headers-Info` is present (serve sets it exactly when it set the identity trio);
5. `Tailscale-User-Login` equals the **node owner's** login, case-insensitively.

The allowlist is exactly one string — `User[Self.UserID].LoginName` from `tailscale status --json` —
because this is a multi-user corporate tailnet: "any tailnet member" would grant every colleague
access, and a **shared-in** external user arrives with a perfectly valid login from their own
tailnet. A tagged node yields no owner login (and gets no identity headers at all), which disables
identity auth entirely: **fail closed**.

On success the server does not wait for a client frame — there is nothing to send — and pushes an
**unsolicited** `auth-response {ok:true, method:'tailnet-identity', identity:{login}}` on
`connection`. A login that is _not_ the owner's is **not** a refusal: identity is a convenience layer
on top of the other methods, not a gate, so a colleague who knows the password still signs in on that
same socket. They only get an actionable error if they present nothing at all.

**Funnel is rejected unconditionally** — HTTP 403 and upgrade refusal — on any request carrying
`Tailscale-Funnel-Request`. We never enable Funnel, so its presence means unexpected public exposure,
and Funnel traffic carries no identity headers by design.

## Accepted residual risks

Both are consciously accepted rather than mitigated (the fixes were weighed and judged not worth
their cost for this threat model):

1. **Local-process identity forgery.** In TLS mode any process on this machine can reach the loopback
   port and forge the `Tailscale-User-Login` header, so TLS mode widens local trust from "the app's
   own user" to "any local process". This has no complete fix — Tailscale itself documents
   loopback-binding as the mitigation and treats same-device processes as residual, and `serve`
   cannot carry a backend secret. Every non-loopback path is still gated by the token or the password.
2. **Throttle budget resets on restart.** `failedAuth` (both the 10/60 s token budget and the
   5/5 min password budget) is in-memory and cleared by `stop()`, so an app restart hands an
   attacker a fresh brute-force budget. With autostart this happens routinely (login, crashes).
   Accepted because the password is user-chosen with a 12-char floor and scrypt makes each online
   guess expensive; persisting the counters to the DB is a clean future fix if a stronger stance is
   wanted.

## Supporting rules

- **Host allowlist** (every HTTP route + the WS upgrade). `Origin === Host` only stops a cross-origin
  page; it is satisfied by a rebinding attacker whose own domain resolves to this LAN IP. So `Host`
  is pinned to values we actually serve: loopback/`localhost`, this machine's non-internal IPv4s, the
  pinned bind host, the OS hostname (+`.local`), the live tunnel hostname, and — in TLS mode — the
  exact ts.net `dnsName` (serve forwards the browser's original `Host` verbatim, so without this
  entry TLS mode would 403 every request). A port component must be the port we bound **or** the
  serve HTTPS port. No `*.ts.net` suffix match: serve only ever presents our own SNI name, so a
  suffix rule would widen the allowlist to every node name in the tailnet for no reachable gain.
- **Throttle budgets.** 10 token failures/60 s and 5 password failures/5 min, tracked independently
  per key; either over budget refuses the connection up front (close 4006) and `auth-info` (429).
  Behind serve every peer is `127.0.0.1`, which would collapse the per-source budget into one global
  bucket (a one-line lockout DoS), so the key comes from the first `X-Forwarded-For` element — but
  **only** when the serve-proxied predicate (1–3 above) holds. Anywhere else XFF is attacker-chosen
  and ignored.
- **Mutual exclusion.** TLS mode and the Cloudflare tunnel cannot coexist in one run; when both are
  requested the **tunnel wins** and the status reports TLS as off rather than implying two transports.
- **Serve teardown.** `stop()` best-effort issues `serve --https=<ourPort> off` (fire-and-forget) and
  the Settings toggle-off disables it outright. `tailscale serve reset` is **never** issued — it would
  wipe serve entries we did not create. A `--bg` config is persisted per-profile and outlives the app,
  so a leftover entry pointing at our own port is treated as ours and reused on the next start.
- **Autostart resilience.** At login the Tailscale daemon may not be up yet, and a failed autostart
  has no modal to report to: it keeps the (loopback-only) listener, surfaces the reason in
  `RemoteStatus.tls.detectionMessage`, and retries 5× at 15 s for plausibly-transient failures only
  (`daemon-down`, unknown status read, CLI exec failure). States needing a human — not installed,
  logged out, certs disabled, no operator — are reported once and not retried. A **manual** start
  fails fast instead: the listener is torn down and the message lands in `lastError`.

## Consequences

- `RemoteStatus` gains `tls` and `clientLogins`; it never crosses the WS (no `remote:*` channel is
  registered on the dispatcher, and `remote:tailscale-detect` is in `BLOCKED`), guarded by a test.
- Enabling TLS mode is gated in Settings on a live `detect()` probe plus one confirm click, because
  `tailscale serve` on a certs-disabled tailnet silently no-ops (or blocks on an admin action) and
  would otherwise leave a server bound to loopback and reachable from nowhere.
- The three modes coexist on one port; a client picks with `/remote/auth-info` (identity → token →
  password), and no mode can be downgraded into another on a failed attempt.
