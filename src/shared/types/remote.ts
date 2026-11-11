export interface NetworkInterfaceInfo {
  name: string // e.g. "Wi-Fi", "Ethernet", "Tailscale"
  address: string // e.g. "192.168.1.100"
  priority: number // lower = more preferred (1 = LAN, 9 = CGNAT/VPN)
}

/** Sanitized remote-server config — NEVER carries password_salt/password_hash/kdf_params. */
export interface RemoteConfig {
  port: number
  bindHost: string | null
  autostart: boolean
  tlsMode: number
  /**
   * Pinned `tailscale serve` HTTPS port (ADR-042), 1–65535, default 443. The
   * ONLY port TLS mode will bind — there is no fallback walk. The last-serve
   * cleanup record (`last_serve_*`) is deliberately NOT exposed: it is internal
   * bookkeeping for the startup reconciliation.
   */
  tlsHttpsPort: number
  /**
   * Desktop-side master switch for remote terminals (ADR-052 decision 6), OFF
   * by default. It lives in `remote_config` — NOT in UISettings — because
   * `config:save-settings` is remotely reachable, and a settings-blob flag
   * would let a remote client arm its own `shell` capability.
   */
  allowTerminal: boolean
  /** Idle window before a stepped-up `shell` grant decays, in minutes. */
  shellGrantIdleMinutes: number
  /**
   * Host-side master switch for the remote IDE (ADR-064), OFF by default. Its
   * own toggle rather than a rider on {@link RemoteConfig.allowTerminal}: a
   * remote VS Code is shell-EQUIVALENT but not a pty, and an operator must be
   * able to want one without the other.
   */
  allowIde: boolean
  /**
   * Optional path to the VS Code CLI the host spawns (`code-tunnel(.exe)` /
   * `code`), or null to auto-detect. Host-anchored like the toggle, and for a
   * sharper reason: the host EXECUTES this path, so a remotely writable copy
   * would be remote code execution by config write.
   */
  ideCliPath: string | null
  /**
   * Stored auth policy, or `null` for AUTO (≥1 credential ⇒ `passkey-always`,
   * else `password`). Same table + same desktop-only write path as
   * {@link RemoteConfig.allowTerminal}, and for the same reason: a remotely
   * writable policy would let a client downgrade its own authentication.
   */
  authPolicy: RemoteAuthPolicy | null
  /** What AUTO resolves to right now, given the enrolled-credential count. */
  effectiveAuthPolicy: RemoteAuthPolicy
  /** Number of enrolled WebAuthn credentials (what AUTO resolves against). */
  credentialCount: number
  /** Break-glass password enabled (default true); the `passkey-only` toggle clears it. */
  passwordBreakGlass: boolean
  /**
   * Stored step-up tier (ADR-054). The SECOND axis: `authPolicy` governs the
   * login ceremony, this governs post-login freshness. Never null — an
   * unrecognised stored value reads as `medium`.
   */
  stepUpTier: StepUpTier
  /**
   * What the tier resolves to right now. Auth-mode `off` FORCES tier `off`
   * (ADR-054 decision 3): you cannot demand a ceremony from an identity that was
   * never established. Exposed alongside the raw value for the same reason
   * {@link RemoteConfig.effectiveAuthPolicy} is — a settings UI must not
   * re-derive the rule and drift from the enforced one.
   */
  effectiveStepUpTier: StepUpTier
  /** Idle window for the strong tier's NON-shell mutation grant, in minutes. */
  stepUpMutationIdleMinutes: number
  /** Strong-tier absolute session lifetime, in hours (close 4010 at expiry). */
  sessionMaxAgeHours: number
  /** Audit-log retention window in days, floor 30 (clamped at READ). */
  auditRetentionDays: number
  passwordSet: boolean
  passwordUpdatedAt: number | null
}

/**
 * One enrolled passkey, as shown in the management UI (ADR-052 / security.md
 * §Enrollment). Never carries the COSE public key — the list is a UI surface,
 * not a credential export.
 *
 * Declared HERE rather than next to the service that produces it because both
 * clients render it and `webauthn-service.ts` is main-only (it imports
 * `@simplewebauthn/server`). That module aliases its `WebauthnCredentialSummary`
 * to this type, so the row a client renders and the row the server maps cannot
 * drift.
 */
export interface WebauthnCredential {
  /** base64url credential id — also the rename/revoke key. */
  credId: string
  /** Operator-chosen label, or null when the device was never named. */
  nickname: string | null
  createdAt: number
  lastUsedAt: number | null
  /**
   * The authenticator says this credential is backed up / syncable (iCloud
   * Keychain, Google Password Manager). Surfaced because "synced across my
   * devices" and "lives only in this phone" are very different things to revoke.
   */
  backedUp: boolean
  transports: string[] | null
}

/**
 * A freshly minted one-time enrollment link (`webauthn:mint-enroll-token`).
 *
 * `url` is the whole product: `https://<tailnet-host>/remote#enroll=<token>`.
 * The hostname in it IS the RP ID the new credential will bind to, which is why
 * minting fails with `enroll-unavailable` while `tailscale serve` is down. Every
 * mint is SINGLE-USE — a UI must mint per action, never cache one.
 */
export interface WebauthnEnrollToken {
  token: string
  /** Epoch ms; the server drops the token at this point regardless. */
  expiresAt: number
  url: string
}

/**
 * States {@link TailscaleDetection} can report, and the value carried by
 * `RemoteStatus.tls.detection`. Declared here (not in the main-only
 * `tailscale-manager.ts`) because both the renderer and the web client need it;
 * `tailscale-manager.ts` imports it, so the two can never drift.
 */
export type RemoteTlsDetection =
  'ok' | 'not-installed' | 'daemon-down' | 'logged-out' | 'https-disabled' | 'no-operator' | 'error'

/** Outcome of probing the local `tailscale` CLI (`TailscaleManager.detect()`). */
export type TailscaleDetection =
  | {
      state: 'ok'
      binaryPath: string
      version: string
      /** `Self.DNSName` with the trailing dot stripped, e.g. `box.tailXXXX.ts.net`. */
      dnsName: string
      /** `CertDomains` from `status --json`; may legitimately be `[]` when the
       *  tailnet has the `https` node capability but no cert issued yet. */
      certDomains: string[]
      /**
       * Lowercased `LoginName` of the user who owns this node
       * (`User[Self.UserID].LoginName`), or null when it cannot be determined —
       * a tagged node, or a status payload with no matching `User` entry. Null
       * disables tailnet-identity auth entirely (fail closed): it is the ONLY
       * login the remote server will accept from a `Tailscale-User-Login`
       * header.
       */
      ownerLogin: string | null
    }
  | {
      state: Exclude<RemoteTlsDetection, 'ok'>
      /** Actionable, user-facing. Safe to render verbatim in the UI. */
      message: string
      binaryPath?: string
      /** Raw diagnostic (stderr tail / BackendState / parse error). Not for the UI. */
      detail?: string
    }

export type TunnelState =
  'stopped' | 'starting' | 'downloading' | 'connected' | 'error' | 'restarting'

/**
 * Auth methods the remote server ADVERTISES or ACCEPTS (ADR-056 collapsed the
 * two lists into one union with one asymmetric member — see below).
 *
 * - `'password'` — the scrypt proof derived from the user's persisted
 *   credential. Since ADR-056 it is the ONLY credential a non-WebAuthn origin
 *   (LAN, tunnel) can present, and it always travels inside E2E there.
 * - `'webauthn'` — a completed passkey assertion: the only method that proves a
 *   HUMAN rather than a cached client secret.
 * - `'webauthn-resumed'` (ADR-063) — a RESUMPTION TOKEN minted by an earlier
 *   assertion and replayed on a later handshake. It is the passkey's analogue of
 *   the cached password proof and carries the same trust reading: it
 *   authenticates the BROWSER, never the human. Same grant bundle as
 *   `'webauthn'`, attributed to the same credential's label, and it ARMS
 *   NOTHING — a terminal act, a settings session and the strong tier's mutation
 *   window still demand a live ceremony.
 * - `'enroll-token'` — the one-time minted enrollment link, which authenticates
 *   a socket that may do nothing but register a credential.
 * - `'none'` — the `off` policy mode, where authentication is disabled outright.
 * - `'tailnet-identity'` — ADVERTISEMENT ONLY since ADR-056. It appears in
 *   `RemoteAuthInfo.methods` / `RemoteStatus.authMethods` to say "this server
 *   recognises your tailnet login and will use it as the username hint", and it
 *   is never an `auth-response.method`: ambient network identity stopped being
 *   an admission credential when the link stopped being an identity.
 *
 * `'token'` is GONE (ADR-056): the per-start bearer token in the URL fragment
 * was a link that carried authority, which is exactly what that ADR retires.
 */
export type RemoteAuthMethod =
  'password' | 'tailnet-identity' | 'webauthn' | 'webauthn-resumed' | 'enroll-token' | 'none'

/**
 * Remote authentication POLICY (ADR-052 decision 3, ADR-056 §grant collapse /
 * security.md §"Policy modes"). Persisted in `remote_config.auth_policy`, where
 * **NULL means auto**: ≥1 enrolled credential resolves to `passkey-always`,
 * otherwise `password`. An explicitly stored value always wins.
 *
 * - `passkey-always` — every connection arriving on a WebAuthn-capable origin
 *   must complete the assertion ceremony (break-glass password aside).
 * - `password` — no ceremony is owed; admission is a break-glass password (or
 *   an enrollment link). It is what AUTO resolves to with nothing enrolled, and
 *   it is **effective-only**: the operator cannot pin it, because pinning it
 *   would mean "keep accepting a password after I enrol a passkey", which is
 *   what `passwordBreakGlass` already says.
 * - `off` — MASTER SWITCH: all authentication disabled. HOST-ANCHOR only to set
 *   (ADR-054 decision 6), audited on every change, and warned about at startup.
 *
 * ADR-054 removed `passkey-for-grants`; ADR-056 removed `legacy`, whose meaning
 * ("the as-built ADR-039 stack") died with the token and the ambient tailnet
 * admission it named. Migration v13 rewrites stored `legacy` rows to NULL,
 * i.e. back to AUTO — which resolves to `passkey-always` or `password`
 * depending on whether a credential exists, and is what `legacy` was standing
 * in for on either side of that line.
 */
export type RemoteAuthPolicy = 'passkey-always' | 'password' | 'off'

/**
 * Post-login presence-freshness tier (ADR-054 decision 1). Persisted in
 * `remote_config.step_up_tier`; default (and fail-parse) is `medium`.
 *
 * - `strong` — reads and the sync stream are free; every MUTATING command needs
 *   a presence proof no older than its idle window (shell acts 10 min, all
 *   other mutations 60 min), and the session has an absolute max-age after
 *   which the socket is cut (close 4010) and a full ceremony is owed.
 * - `medium` — the shipped ADR-052 behavior, named: step-up gates exactly the
 *   terminal (with the read/act split) and the remote-settings surface.
 *   Everything else rides connection auth for the connection's lifetime.
 * - `off` — nothing is gated post-login; the session lives until disconnect.
 *   Auth-mode `off` forces this tier flat.
 */
export type StepUpTier = 'strong' | 'medium' | 'off'

/**
 * Why a `tailscale serve` mutation failed. Declared here (not in the main-only
 * `tailscale-manager.ts`) because it travels to the renderer inside
 * {@link RemoteTlsStatus.serveError}; `tailscale-manager.ts` imports it as its
 * `ServeFailureReason`, so the two can never drift.
 */
export type RemoteServeFailureReason =
  /** `detect()` did not return `ok` (Tailscale missing / logged out / certs off / …). */
  | 'not-ready'
  /** The PINNED HTTPS port is held by a serve config that is not ours (ADR-042). */
  | 'port-occupied'
  /** The CLI exited non-zero (or timed out). */
  | 'exec-failed'
  /** The CLI exited 0 but the config did not actually land. */
  | 'verify-failed'

/**
 * `tailscale serve` state for the running server (Phase 3). All-null fields
 * with a non-null object mean "TLS mode is on but serve is not up yet" — read
 * `serveError` / `detectionMessage` for why.
 */
export interface RemoteTlsStatus {
  /** Mirrors the `tls_mode` the server was STARTED with: 1 = tailscale-serve. */
  mode: number
  /**
   * The HTTPS port serve is CONFIRMED listening on, null until up. Since
   * ADR-042 this is always {@link RemoteTlsStatus.pinnedHttpsPort} when
   * non-null — there is no candidate walk any more.
   */
  httpsPort: number | null
  /**
   * The pinned HTTPS port this run will bind (`remote_config.tls_https_port`,
   * default 443). Known even while serve is down, which is exactly when the UI
   * needs to name the port that failed.
   */
  pinnedHttpsPort: number
  /**
   * The most recent `tailscale serve` failure while TLS mode was requested, or
   * null when serve is healthy. Rendered by the app-level serve banner; the
   * `reason` decides whether "Force re-serve" can plausibly fix it
   * (`port-occupied` → yes, by overwriting the occupant).
   */
  serveError: { reason: RemoteServeFailureReason; message: string } | null
  /** `https://<dnsName>[:port]` — the URL to hand the user. Replaces `lanUrl`. */
  url: string | null
  /** Last `detect()` state, so the UI can distinguish "not installed" from "certs off". */
  detection: RemoteTlsDetection | null
  /**
   * Most recent actionable TLS failure message — either the detection message
   * or the `tailscale serve` failure — renderable verbatim. Null while serve is
   * healthy.
   */
  detectionMessage: string | null
}

export interface RemoteStatus {
  running: boolean
  port: number | null
  /**
   * `http://<lan-ip>:<port>/remote#k=<channel key>` while the server serves a
   * non-loopback bind, else null.
   *
   * The fragment carries the PERSISTENT LAN channel key (ADR-056 item C), never
   * an access token: it opens the encrypted channel, and the identity inside it
   * is still a password. It is a secret, which is why `remote:status` has no
   * remote registration and this field never crosses the WS — the web-reachable
   * equivalent is `authcfg:lan-link`, behind a settings-editing session.
   */
  lanUrl: string | null
  /** Same shape over the tunnel, with the EPHEMERAL tunnel key that dies with it. */
  tunnelUrl: string | null
  tunnelState: TunnelState | null
  tunnelError: string | null
  connectedClients: number
  clientIps: string[]
  /**
   * Tailnet logins of the connected clients, parallel to `clientIps`. A `null`
   * entry means the server has no username hint for that client (a password
   * login off the tailnet, an enrollment link).
   */
  clientLogins: (string | null)[]
  /** `tailscale serve` state, or null when the running server is not in TLS mode. */
  tls: RemoteTlsStatus | null
  /** Message from the most recent failed `start()` listen attempt (e.g.
   *  EADDRINUSE), or null if the last start succeeded / no start has failed
   *  since the last stop(). Surfaces autostart failures, which are otherwise
   *  invisible (no modal open to report them to). */
  lastError: string | null
  /** Methods this running server advertises: `'password'` when a credential is
   *  provisioned, plus `'tailnet-identity'` when `tailscale serve` is up and the
   *  node owner's login is known — a username HINT, not an admission credential
   *  (ADR-056). Empty when not running. Derived exactly the same way as
   *  `/remote/auth-info`'s `methods`. */
  authMethods: RemoteAuthMethod[]
}

/**
 * The redacted half of {@link RemoteTlsStatus} — what `remote:status-view`
 * carries about `tailscale serve` (owner ruling, 2026-08-28).
 *
 * Four fields, and the three that are MISSING are the point:
 *
 *  - `url` — `https://<dnsName>[:port]`, i.e. the node's tailnet DNS name. It is
 *    no key, but it is the same disclosure `remote:tailscale-detect` is kept
 *    desktop-only for ("it discloses the node's DNS name and the owner's login",
 *    `core/boot/host-anchor.ts`), and a client on the LAN or the tunnel does not
 *    otherwise learn the tailnet name.
 *  - `serveError` / `detectionMessage` — FREE TEXT composed from the Tailscale
 *    CLI's own output. The `not-ready` serve failure copies `detection.message`
 *    verbatim, and that message embeds `status.AuthURL` on a logged-out node —
 *    a device-authorization URL, which is capability-bearing. `detection` says
 *    the same thing as a CLOSED union, into which nothing can be interpolated.
 *
 * The three kept are stable numbers/enums the web client can already read as
 * CONFIG through `authcfg:get` (`tlsMode`, `tlsHttpsPort`), plus the live-port
 * confirmation of the same pin.
 */
export interface RemoteTlsStatusView {
  /** Mirrors {@link RemoteTlsStatus.mode} — 1 = tailscale-serve. */
  mode: number
  /** The HTTPS port serve is CONFIRMED listening on, null until up. */
  httpsPort: number | null
  /** The pinned HTTPS port this run binds (ADR-042); known even while serve is down. */
  pinnedHttpsPort: number
  /** Last `detect()` state — a closed union, never free text. */
  detection: RemoteTlsDetection | null
}

/**
 * The REDACTED, web-reachable view of {@link RemoteStatus} — what
 * `remote:status-view` answers (`capability: 'config'`, `kind: 'query'`, both
 * transports). Owner ruling, 2026-08-28: "a remote web view should be able to
 * see the connected clients. though they should not be able to disable the
 * remote mode themselves, as it will kill themselves."
 *
 * ## What it must never carry, and how that is enforced
 *
 * `lanUrl` and `tunnelUrl` carry the LAN channel key / the ephemeral tunnel key
 * in their fragments (ADR-056 item C) — secrets, which is why `remote:status`
 * has no remote registration at all. NOTHING derived from either may appear
 * here: not the URLs, not their host halves, not `tunnelError` (free text from
 * the tunnel provider, which names the tunnel hostname).
 *
 * The redaction is therefore an explicit FIELD PICK — `remoteStatusView()` in
 * `core/ipc/remote-view-commands.ts` names every field it copies — never a
 * spread-and-delete. A field added to `RemoteStatus` tomorrow does not appear
 * here by default, which is the only version of this rule that survives future
 * edits.
 *
 * ## What it deliberately DOES carry
 *
 * `clientIps` / `clientLogins` are the one genuinely new cross-client
 * disclosure: a connected client learns who else is connected. That is the
 * ruling — the operator's own devices, on the operator's own server — and it is
 * what makes the view worth having at all.
 *
 * ## What it is NOT
 *
 * A control surface. Every remote-server MUTATION (`remote:start` / `stop` /
 * `set-config` / `set-password` / `clear-password` / `force-reserve`) stays raw
 * `ipcMain.handle` on the host anchor with no registration on either the remote
 * OR the shared-declaration side, so a remote client cannot cut the connection
 * it is talking through. That is structural, not a UI courtesy.
 */
export interface RemoteStatusView {
  running: boolean
  port: number | null
  connectedClients: number
  clientIps: string[]
  /** Parallel to `clientIps`; `null` where the server has no username hint. */
  clientLogins: (string | null)[]
  tunnelState: TunnelState | null
  authMethods: RemoteAuthMethod[]
  /** Most recent failed `start()` listen attempt (e.g. EADDRINUSE), or null. */
  lastError: string | null
  /** {@link RemoteTlsStatusView} — null when the running server is not in TLS mode. */
  tls: RemoteTlsStatusView | null
}
