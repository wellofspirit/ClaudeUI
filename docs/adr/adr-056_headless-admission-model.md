# ADR-056 — The headless admission model: the link is the channel, never the identity

**Status:** **Implemented** (owner-ratified 2026-08-17 design session; landed as headless-arc series S1a). **Amended 2026-08-18** — the LAN channel falls back to pure-JS AES-GCM where a browser withholds Web Crypto; see [Amendment](#amendment--2026-08-18-the-lan-channel-needs-a-cipher-a-browser-will-actually-run) at the end. Normative as-built record: [security.md](../architecture/security.md); handshake/transport detail in [remote.md](../architecture/remote.md).
**Relates to:** ADR-042 (pinned HTTPS port — unchanged), ADR-051 (the command registry this rides on), ADR-055 (the no-compatibility-lane precedent).
**Supersedes in part:** ADR-039 — its **token mode** is retired outright, and its "confidentiality is delegated to the transport" caveat is narrowed by LAN E2E. Its transport hardening (Host allowlist, throttling, funnel reject, the identity-header trust predicate) carries forward unchanged, as does the tailnet-identity _evaluation_ — demoted to a username hint.
**Supersedes in part:** ADR-052 — its **`passkeyTailnetExempt`** setting and the ambient tailnet admission it exempted from, its `legacy` policy mode, and the grant carve-out that withheld `enroll` from a password login. Its passkey layer, `enroll` capability, enrollment flow and audit contract stand.
**Cross-reference:** ADR-054 — the **host anchor is unchanged**. Auth-DISABLING operations stay host-anchor only (desktop renderer, or the server's own console/config on a headless box), `remote:set-config` keeps its structural no-remote-registration guarantee, and the settings-editing session is untouched. This ADR only changes _who gets in and holding what_, plus which key their channel uses.

## Context

The headless target forced a question the desktop deployment let us dodge: **what, exactly, does a URL prove?**

As built, a `/remote` link could carry a 256-bit access token in its fragment, and holding it authenticated the socket. That made a bookmark a credential. Alongside it, `tailscale serve` supplied an _ambient_ admission — the owner's own browser was authenticated from the upgrade headers, before any client frame — which made a network fact stand in for a person. Both were reasonable for "scan a QR from the couch". Neither survives contact with a box that has no desktop to anchor the first device to, and both had already produced real defects:

- `grantsFor` and `ceremonyRequiredForAuth` were two functions restating one admission rule for the `token` / `tailnet-identity` arms. They drifted within a week, and the result was a connection the server ACCEPTED and then refused on every single invoke.
- The ambient accept raced the enrollment link at exactly the origin where enrollment must happen, so the first device could never spend its token. That needed a whole flag (`?intent=enroll`) to break.
- Plain LAN was plaintext, so the password proof's confidentiality rested on "the user's own network" — which is the one origin the operator is least able to reason about.
- `legacy` as a policy mode named "the as-built ADR-039 stack", i.e. exactly the two things above.

The owner's ruling collapses all of it into one sentence.

## Decision

### 1. The rule

**The link is the channel, never the identity — identity is a passkey or a password.**

A URL fragment may carry a **channel key** (`#k=`), which opens an encrypted pipe and buys nothing else. What a connection may DO is decided by the credential it presents inside that pipe. The enrollment link is the one exception, and it is bounded to match: single-use, short TTL, `enroll` and nothing else.

| Origin                            | Channel                                        | Identity                                          |
| --------------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| Tailnet HTTPS (`tailscale serve`) | TLS; **no fragment secret at all**             | Passkey ceremony per policy; break-glass password |
| Cloudflared tunnel                | E2E, **ephemeral** key (dies with the tunnel)  | Password **required**, inside the ciphertext      |
| LAN direct                        | E2E, **persistent** key (DB-stored, rotatable) | Password **required**, inside the ciphertext      |
| localhost dev                     | none needed (local + secure context)           | As tailnet                                        |
| Desktop renderer (MessagePort)    | the port IS the trust                          | none                                              |

### 2. The handshake ORDER inverts on E2E origins

`e2e-activate` first, proving possession of the channel key; the `auth` frame travels inside the ciphertext, and so does every server answer including refusals. Tailnet and localhost are unchanged (auth frame first, no E2E).

Consequences, all deliberate:

- **A plaintext socket on a LAN origin is refused** (close 4004). This is the same rule rather than an extra one: on an E2E origin nothing is read in the clear, so a plaintext first frame is a socket that never proved the channel.
- **A channel with no identity is refused with a typed `password-required`**, rendered as _"provision a password on the host to use this link"_. It spends no failure budget — nothing the caller did was wrong. Starting a tunnel with no password provisioned stays allowed; the status surface carries the same warning.
- **The ack is the client's proof its key was right.** A stale `#k=` decrypts nothing, so the client sends no credential and the socket dies on the pre-auth clock. (The web client times its own activation out at 10 s and says the link is out of date, rather than looping a backoff.)
- **A wrong key spends the per-IP failure budget.** The wrong-key client is observable server-side — its first encrypted frame fails to decrypt on a pre-auth socket — and that is where the charge lands. The charge bounds online probing and socket churn — against 256 bits an offline oracle is academic either way, but `#k=` must not be the one secret whose online probing is free. The budget is now **single**: with the token retired, everything that can fail (password proof, passkey assertion, enrollment link, channel activation) is either user-chosen or worth guessing, so the strict 5-per-5-minutes budget applies to all of it, and the loose token budget is deleted rather than left unreachable.
- **The expected key is read AT ACTIVATION, never at socket-open.** The pre-auth window is up to 10 s, so a snapshot would let a socket opened just before a rotation activate against the retired key.

**One origin classifier, three consumers.** `classifyConnectionOrigin` decides the E2E requirement, the auth requirements, and the username hint. A second copy would be a plaintext side door.

**The `Host` header is not one of its inputs, and that is directional.** Every value it reads is the socket PEER, a header the ADR-039 trust predicate has already vouched for, or this server's own run state. `Host` is attacker-controlled, so it may only ever UPGRADE what a connection must present (it still selects the WebAuthn origin, where being wrong costs a ceremony that cannot succeed), never downgrade it. Order: funnel → **non-loopback peer ⇒ LAN** → then, for the loopback peers that both trusted proxies produce: trusted serve identity headers ⇒ `tailnet-serve` (TLS, no E2E owed) → this run holds a tunnel key ⇒ `tunnel` (E2E required) → else `localhost`.

The tunnel arm is deliberately unconditional on the run state rather than on which host was asked for: while a tunnel is up we cannot distinguish a cloudflared forward from a genuine local process, so both owe the channel. **Localhost development therefore uses the tunnel link for as long as the tunnel runs** — which is exactly what the pre-ADR-056 server did, and it is the safe direction of the ambiguity.

### 3. The token and ambient tailnet admission are retired

`#t=` is gone; `WsAuthRequest.token` and `'token'` in `auth-response.method` are gone with it. The unsolicited `tailnet-identity` accept is gone. What survives of the tailnet login is the **username hint**: `/remote/auth-info` still echoes it back to the caller who already proved it, and a password connection on a serve-proxied socket still carries it as its LABEL, so `RemoteStatus.clientLogins` and every audit row still name who it was.

`?intent=enroll` becomes inert — the race it broke cannot happen without an ambient accept — and the client keeps sending it, because it costs nothing and keeps the enrollment URL byte-identical.

**No compatibility lane** (owner ruling, ADR-055 precedent): desktop and web bundles ship with the server, so a stale cached bundle gets typed refusals, not crashes.

### 4. The grant collapse — three outcomes, keyed on the method alone

| Method                    | Bundle                                                                    |
| ------------------------- | ------------------------------------------------------------------------- |
| `webauthn`, `password`    | `FULL_REMOTE_GRANTS` (base five + `admin` + `enroll`), under every policy |
| `enroll-token`            | `ENROLL_ONLY_GRANTS`                                                      |
| `none` (only under `off`) | `AUTH_OFF_GRANTS` (base five; never `admin`/`enroll`)                     |

`PASSKEY_REMOTE_GRANTS` → `FULL_REMOTE_GRANTS`, `LEGACY_REMOTE_GRANTS` → `AUTH_OFF_GRANTS`; the members are unchanged. The auth-off set stays without `admin`/`enroll`, so enrolling a credential while authentication is disabled is impossible and the settings session stays unreachable.

**The policy is no longer an input**, which is the fix: the two arms that re-decided admission inside `grantsFor` are gone, so `EMPTY_GRANTS` — a connection the server accepted that holds nothing — is not a state that can be spelled. Admission is decided once, at the handshake.

**The password now gets `enroll`.** Withholding it was already theatre once the same connection held `admin`: `webauthn:mint-enroll-token` is an `admin` verb, so an admin-holding password client could always mint its own enrollment link and use it. The property that actually protects a fresh install — _the first device requires the anchor_ — survives via the **policy default** rather than grant surgery: with zero credentials **and** no password provisioned, nothing can connect except an enrollment link, and `/remote/auth-info` legitimately advertises an empty method list. A password that exists was provisioned by somebody already on the host.

**Policy modes.** `legacy` is retired; the surviving stored values are NULL (AUTO), `passkey-always` and `off`. AUTO resolves: ≥1 credential ⇒ `passkey-always`, else `password` — an **effective-only** value the operator cannot pin, because pinning it would mean "keep accepting a password after I enrol a passkey", which is what `passwordBreakGlass` already says.

### 5. The persistent LAN channel key

A 32-byte hex key in `remote_config.lan_e2e_key`, generated lazily on the first start that serves a non-loopback bind. Persistent because a LAN bookmark must survive a restart to be a bookmark at all (unlike the tunnel key, whose hostname is ephemeral too); rotatable because a persistent secret with no replacement is one leak from permanent. It is a secret and never appears in `sanitizedRemoteConfig` / `authcfg:get`.

Two verbs, on BOTH transports (a headless box has no desktop pane to read a link from), both **settings-session gated**:

- `authcfg:lan-link` — `query`, `admin`. A `query` would classify `read` and be free like `authcfg:get`, so its membership of `AUTHCFG_CHANNELS` _is_ the gate: what gates a verb in this namespace is what it DISCLOSES, not its kind. Returns the full link, with ip:port from live listener state.
- `authcfg:rotate-lan-key` — `command`, `admin`. Returns the NEW link, so the actor's UI renders it immediately.

**The never-strand contract, ratified.** `E2ECrypto.init` derives a connection's AES key at `e2e-activate` and never re-reads the stored value, so **established channels survive a rotation, nobody is disconnected, and only NEW handshakes need the new key.** It audits as `auth:settings-change` with **no 4009 sweep** — the admission rules for existing identities did not move, and sweeping would disconnect every live client to tell them something that does not apply to them. The recovery anchor for someone holding the retired link is the host: the desktop pane, or the console on a headless box. Neither verb joins `authcfg:apply`'s batch, on the same reasoning as `authcfg:set-password`: a channel key is not a config field.

### 6. Capability reclassifications

- `session:delete-session` / `session:delete-project`: `config` → **`chat`**, in both registrars. This closes the review sync-core.md §Follow-ons asked for. Deleting a session removes CONVERSATIONS — the material `chat` already governs — and labelling it configuration had put a destructive verb in the bundle a client holds for saving UI preferences.
- **`admin` shrinks to EXACTLY the session-security area**: `authcfg:*` + `webauthn:*` (plus their host-anchor twin `remote:*`). `shared-provider:` writes, `auth:*`, `account:*`, `vendor-auth:*` and `usage:refresh-prices` declare `config`. That is a rename, not a widening — they are desktop-only by their REGISTRATION, which is where the guarantee always lived — and it removes them from `PINNED_CAPABILITIES`, because `config` is grantable and the pin table's one invariant is that every entry names a capability the base set does not hold. (`log-viewer:*` and `automation:*` keep their forward pins: they are registered nowhere yet, and whether the S1b port exposes them is that series' decision, so the fail-closed placeholder stays.)

### 7. Migration v13

`UPDATE remote_config SET auth_policy = NULL WHERE auth_policy = 'legacy'` — back to AUTO, which resolves to `passkey-always` or `password` on the credential count: exactly the two things `legacy` stood in for on either side of that line. `off` and `passkey-always` are untouched; no migration may ever set or clear the master switch. Adds the nullable `lan_e2e_key`. `passkey_tailnet_exempt` is **not dropped** — its meaning is retired and nothing reads or writes it, but a dead column costs nothing while `DROP COLUMN` would break an older binary that still names it in its INSERT, and the downgrade guard is a proceed-read-forward path rather than a refusal.

## Consequences

- **The LAN's WS lane stops being plaintext — and only that lane.** The password proof, the snapshot and the session traffic are no longer readable by a passive LAN observer. The HTTP surface of that origin (`/remote` bundle, `/assets/*`, `/remote/auth-info` with its salt+KDF, `/mockup/*`, `/sent-file`) is **still plain HTTP**, so an ACTIVE on-path attacker can rewrite the bundle and have it hand over both the `#k=` fragment and the typed password. E2E cannot help when the attacker supplied the code performing it. This is an **accepted risk, not a fix** — closing it needs TLS on the LAN listener, which is a certificate story ClaudeUI does not have. LAN stays the weakest origin and `tailscale serve` stays the recommended one; the channel key is an improvement on a bearer token in the same fragment, not a substitute for TLS. (security.md §What LAN E2E does and does not cover.)
- **A fresh install admits nobody**, which is what makes the headless bootstrap chain's first step real rather than a convenience. The console-printed enrollment URL is the only way in.
- **One rule replaces four special cases.** The `?intent=enroll` race, the tunnel's "password refused at initial auth", the exemption toggle, and the grant carve-out were all consequences of links carrying authority; they dissolve together rather than each needing its own answer.
- **The throttle budgets collapse in code.** The token budget is deleted; one 5-per-5-minutes per-key budget covers every credential failure, and E2E-activation failures (wrong channel key, repeat activation, malformed plaintext where a channel was owed) spend it too.
- **Breaking wire change, deliberately.** See §3. `RemoteStatus.token` and `start()`'s `token` are gone; `lanUrl` / `tunnelUrl` carry `#k=`.
- **The operator surface LANDED as the "Access links" card** (headless-arc series S1a-UI, after the owner-approved mockup round). It replaced the modal's single share URL — which had to pick one origin and so could not state the rule at all — with one ROW PER ORIGIN, each naming its channel and the identity still owed inside it, plus the in-place rotate confirm, the shared "these origins need a password" warning, and the passkey-less first-device case (with zero credentials and serve up, the share action mints an ENROLLMENT link instead of handing out a URL that dead-ends). It renders in `RemoteAccessModal`, reads `status.lanUrl` on the host anchor and `authcfg:lan-link` on the web, and renders the typed `needs-settings-session` as a locked row rather than curing it.
- **`getStatus().lanUrl` suppresses the LAN link NARROWLY while a tunnel runs**, because the obvious rule would hide a link that works. `classifyConnectionOrigin` takes its non-loopback-peer arm BEFORE its `tunnelActive` arm, so: LAN bind without a tunnel and LAN bind WITH one both keep a working `#k=` link (those peers classify `lan`); only the loopback-bound run is dead, because its link carries no fragment while a loopback peer classifies `tunnel` and owes a channel — §2's documented cost of the unconditional tunnel arm. Only that third case is nulled, and the row says why.

## Rejected alternatives

- **Keep the token as a second factor alongside the channel key.** Two secrets in one fragment, neither of which is a person — it would have preserved the bookmark-is-a-credential property under a longer name.
- **Drop the LAN key and require the tailnet for everything.** Simplest, and the owner declined it: `tailscale serve` is not always up, and the LAN address is the fallback an operator reaches for precisely when something is wrong.
- **An ephemeral LAN key, like the tunnel's.** A bookmark that dies at every restart is not a bookmark; rotation gives back the property the ephemerality was protecting.
- **Sweep live clients (4009) on a LAN-key rotation.** Rejected as actively wrong: it would disconnect everybody to announce a change that does not apply to them, and it would make an operator rotating from their phone disconnect their own phone.
- **A compatibility lane for `#t=` bundles.** Declined per ADR-055: bundles ship with the server, and a lane would keep the retired admission path alive in code for a client that cannot exist.

## Amendment — 2026-08-18: the LAN channel needs a cipher a browser will actually run

Found by owner live-test from a real phone, one day after the arc landed:
**tunnel + password worked, LAN + password did not.** Typing the password
returned _"This link is not valid — get a new one from the host."_ — and, worse
than the failure, that copy is an instruction, so the next thing the owner did
was rotate a key that was never the problem.

### The finding

`SubtleCrypto` is exposed **only in a secure context**. `https://…` and
`http://localhost` are secure; `http://192.168.x.x:<port>` — the LAN link this
ADR mints — is not. So on that origin `window.isSecureContext` is `false` and
`crypto.subtle` is `undefined`, while `crypto.getRandomValues` remains (it is
not gated). `E2ECrypto` was built entirely on `subtle`, and §1 makes the E2E
channel **mandatory** on `lan` — so the channel could not be opened **by any
browser at all**. The LAN row was dead on arrival, and the desktop card was
advertising it as bookmarkable.

Two things hid it. The tunnel is HTTPS, so the origin the owner tested first was
a secure context and worked. And every automated layer ran in **Node**, which has
`crypto.subtle` unconditionally — including `lan-channel-admission.e2e.test.ts`,
which drives the real server over a real `lan`-classified socket and passes,
because its CLIENT is `ws-test-client.ts` rather than the bundle a phone runs.
A green suite and a broken phone were both telling the truth.

### The ruling (owner, 2026-08-18): a pure-JS fallback, Web Crypto still primary

`E2ECrypto` picks its implementation once, in `init()`:

- `crypto.subtle` present ⇒ **unchanged** — HKDF-SHA256 + AES-256-GCM via Web
  Crypto, with the key held as a non-extractable `CryptoKey`. Every desktop, every
  server, every HTTPS origin keeps exactly the code it had.
- `crypto.subtle` absent ⇒ the same two primitives in pure JS: `hkdf(sha256, …)`
  from `@noble/hashes` and `gcm()` from **`@noble/ciphers`** (new dependency,
  2.3.0). The derived 32 bytes are held raw, because noble takes raw bytes.

**No protocol change.** HKDF is RFC 5869 on both sides over the same salt/info,
and AES-GCM appends its 16-byte tag in both, so the wire format
`base64(nonce[12] ‖ AES-GCM(seq[4] ‖ json))` is byte-identical and the two
implementations interoperate in either direction. That is not incidental: **every
LAN session is a mixed pair**, because the server always has Web Crypto. It is
pinned as such — `e2e-crypto.test.ts` encrypts with one and decrypts with the
other, and `lan-web-client-login.e2e.test.ts` runs the whole sign-in with the
client's `subtle` removed against a Node server that still has it.

### Why this and not the alternatives

- **Same vendor, and it completes a story already begun.** `@noble/hashes` is
  already a direct dependency, and the password proof on this very origin is
  already pure-JS scrypt — because WebCrypto has no scrypt. The channel needing
  the same treatment for the same reason is consistent, not a new kind of risk.
- **TLS on the LAN listener** (self-signed, purely to earn secure-context) would
  have fixed it without a dependency, and was rejected for this round: a
  certificate lifecycle, a Host/WS-origin story and a per-phone trust prompt is a
  far larger change than a cipher swap, and it is the same "certificate story
  ClaudeUI does not have" the Consequences section already declines.
- **Dropping E2E on LAN** was never on the table: it is §1's rule.

### Cost, accepted

The fallback is AES in JavaScript, so LAN frames on a phone cost more CPU than
they would through Web Crypto. Measured (review round, 2026-08-18): ~17 µs per
256 B frame and ~69 µs per 4 KB frame — the band the chatty lanes (PTY batches,
stream deltas) actually live in — versus ~1 ms per 64 KB and ~14 ms for a 1 MB
`sync-full`. At small sizes the sync noble call actually beats the async
`subtle` round trip, and the asymmetry runs the right way regardless: the
SERVER always has Web Crypto, so only the phone pays, and only on this origin.
Accepted rather than mitigated; if it ever bites, the cure is the TLS story
above, not a second cipher.

The security posture is otherwise **unchanged** — same algorithm, same key
derivation, same replay counter, same accepted risk about the plain-HTTP surface
of that origin (Consequences, first bullet). The one genuine regression against
the Web Crypto path is that the fallback holds the derived key as raw bytes
instead of a non-extractable `CryptoKey`; on a context with no `subtle` there is
no non-extractable anything to hold, and the alternative is no channel.

### Interim fixes, superseded by this amendment

Between the live-test and the ruling, the client was made to _diagnose_ the dead
end honestly rather than blame the link (a bootstrap refusal before the password
form, a typed `WebCryptoUnavailableError`, and a caveat on the desktop LAN row).
All of that is **reverted**: the link works, so a warning about it would be the
new lie. What survives is `webCryptoAvailable()` — now the branch predicate —
and the typed error, demoted to an invariant guard for `subtle` disappearing
mid-session, which no reachable path produces.
