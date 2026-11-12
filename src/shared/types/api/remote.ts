import type {
  NetworkInterfaceInfo,
  RemoteAuthPolicy,
  RemoteConfig,
  RemoteStatus,
  RemoteStatusView,
  StepUpTier,
  TailscaleDetection
} from '../remote'

export interface RemoteAPI {
  getNetworkInterfaces(): Promise<NetworkInterfaceInfo[]>
  startRemoteServer(opts?: {
    port?: number
    host?: string
    tunnel?: boolean
  }): Promise<{ port: number; lanUrl: string }>
  stopRemoteServer(): Promise<void>
  getRemoteStatus(): Promise<RemoteStatus>
  onRemoteStatus(cb: (status: RemoteStatus) => void): () => void
  /**
   * The REDACTED status (`remote:status-view`), on BOTH transports.
   *
   * `getRemoteStatus` above is host-anchor only — `RemoteStatus.lanUrl` /
   * `tunnelUrl` carry channel keys, so it has no remote registration and the web
   * adapter answers it with an all-null stub. This is the half a connected
   * client may see: running state, port, who is connected, tunnel state, auth
   * methods, the last listen error and a redacted `tls`
   * ({@link RemoteStatusView}).
   *
   * There is no event twin. `remote:status` is host-local by classification, so
   * the web view POLLS this while it is on screen; the desktop keeps its push
   * subscription and its full-fat read.
   */
  getRemoteStatusView(): Promise<RemoteStatusView>
  /**
   * The persisted remote-server config as a UI may see it (fixed port, bind
   * host, autostart, TLS, auth surface, ADR-054 tier + dials, password status;
   * never salt/hash/KDF params).
   *
   * TWO transports, ONE shape (ADR-054 series 2). On the desktop this is
   * `remote:get-config`, the host anchor's own read. On the WEB client it is
   * `authcfg:get` — the read half of decision 6, `admin`-gated and free of any
   * freshness demand, because a settings pane must be able to render the tier
   * before it asks anyone to prove presence in order to change it. Both answer
   * with the same sanitized object (`services/remote-config-view.ts`), which is
   * what lets the settings components be shared and branch only on WRITES.
   */
  getRemoteConfig(): Promise<RemoteConfig>
  /**
   * Partial update of the persisted config; returns the fresh sanitized config.
   *
   * HOST ANCHOR ONLY (ADR-054 decision 6): this is the writer that can reach the
   * `off` master switch, so it has no remote registration at all and REJECTS on
   * the web client. Web settings writes go through the `authcfg:*` verbs below,
   * which are the routine subset — the `off` switch is not among them.
   */
  setRemoteConfig(partial: {
    port?: number
    bindHost?: string | null
    autostart?: boolean
    tlsMode?: number
    tlsHttpsPort?: number
    allowTerminal?: boolean
    shellGrantIdleMinutes?: number
    /** ADR-064: the remote-IDE master switch. */
    allowIde?: boolean
    /**
     * ADR-064: the VS Code CLI override. `null` clears it (back to detection).
     * A non-absolute path REJECTS the whole write — the host spawns whatever
     * this names, so it is host-anchor only and validated at the anchor.
     */
    ideCliPath?: string | null
    /** `null` restores AUTO. Host-anchor only by construction (ADR-054 dec. 6). */
    authPolicy?: RemoteAuthPolicy | null
    passwordBreakGlass?: boolean
    /** ADR-054's second axis. */
    stepUpTier?: StepUpTier
    /** Strong-tier idle window for non-shell mutations, 1–1440 minutes. */
    stepUpMutationIdleMinutes?: number
    /** Strong-tier absolute session lifetime, 1–168 hours. */
    sessionMaxAgeHours?: number
    /** Audit-log retention window, ≥30 days. */
    auditRetentionDays?: number
  }): Promise<RemoteConfig>
  /**
   * ADR-054 §6 — the ROUTINE remote-access settings, reachable from a web client
   * inside an open **settings-editing session**: one deliberate step-up carrying
   * `intent: 'settings'` unlocks the editor for five minutes, and every mutation
   * here demands it. A locked editor answers the typed
   * `needs-settings-session`, which the web transport deliberately does NOT cure
   * ambiently — unlocking is the operator pressing Edit, not a retry. The passkey
   * management writes (`webauthnRename`, `webauthnRevoke`,
   * `webauthnMintEnrollToken`) demand the same session and answer the same code.
   *
   * Registered on BOTH transports so the capability/kind declaration is a single
   * reviewed fact. The desktop connection is exempt — it IS the host anchor, so
   * its editor needs no ceremony and has no TTL — and its pane saves through
   * `setRemoteConfig` regardless, which is the only writer of the `off` switch.
   *
   * SAVE: the whole edited set as one batch. Validated together and written
   * once, so a refused field changes nothing; one audit row carrying the diff;
   * one 4009 re-admission sweep (except the actor, which re-snapshots in place).
   * A patch that changes nothing is a success that writes no row and drops
   * nobody. `'off'` as an auth mode is refused with
   * `auth-off-is-host-anchor-only`.
   */
  authcfgApply(patch: {
    /** `null` restores AUTO. `'off'` is refused — host anchor only. */
    authMode?: RemoteAuthPolicy | null
    stepUpTier?: StepUpTier
    /** 1–1440. */
    stepUpMutationIdleMinutes?: number
    /** 1–168 (the one-week `setTimeout` ceiling). */
    sessionMaxAgeHours?: number
    /** The TERMINAL's own act window, 1–1440 (ADR-052's `shell` grant decay). */
    shellGrantIdleMinutes?: number
    /** ≥30 — the audit floor is a refusal here, not a silent clamp. */
    auditRetentionDays?: number
    /** The admission toggle — an auth-surface member, so it sweeps too. */
    passwordBreakGlass?: boolean
  }): Promise<{ ok: true; config: RemoteConfig }>
  /**
   * Close the editor: Save, Cancel, and pane unmount all call it, so the bounded
   * mode ends on the operator's action rather than only on its TTL. Idempotent —
   * calling it with no session open is a no-op success.
   */
  authcfgEnd(): Promise<{ ok: true }>
  /**
   * The LAN channel link — `http://<ip>:<port>/#k=<key>` (ADR-056 item C).
   *
   * SETTINGS-SESSION GATED, unlike its namespace sibling `authcfg:get`: it
   * returns a channel SECRET, so the "the pane's default state is the read"
   * exemption explicitly does not apply. The desktop connection is exempt like
   * everywhere else — it is the host anchor.
   *
   * Throws `lan-link-unavailable` when the running server serves no non-loopback
   * bind (stopped, or `tailscale serve` mode, which binds loopback only).
   */
  authcfgLanLink(): Promise<{ url: string }>
  /**
   * Rotate the persistent LAN channel key and return the NEW link.
   *
   * Never strands anybody: established E2E channels survive (the key is consumed
   * at handshake only, and each connection derives its own session keys at
   * activation), so nobody is disconnected — only NEW handshakes need the new
   * key. Audited as a settings change, with no 4009 sweep, because the admission
   * rules for existing identities did not move.
   */
  authcfgRotateLanKey(): Promise<{ url: string }>
  /**
   * Rotate the break-glass password. Session-gated like the rest of the area.
   *
   * NOTE for web callers: this disconnects every socket that authenticated with
   * the OLD password — which can include the caller. A password-authenticated
   * actor is closed with 4008 BEFORE the invoke response is sent, so close-4008
   * is that flow's success signal; a passkey-authenticated actor gets the normal
   * response.
   */
  authcfgSetPassword(password: string): Promise<{ ok: true }>
  /**
   * Re-run `tailscale serve` enablement for the running server with
   * `force: true` — it CLAIMS the pinned HTTPS port, overwriting whatever
   * handler currently holds it (ADR-042). The user's deliberate "my bookmark
   * wins" action, surfaced by the serve-failure banner. Main-only (in
   * `RemoteDispatcher.BLOCKED`): a remote client must never mutate the serve
   * config of the server it is connected through.
   */
  forceReserve(): Promise<void>
  /** Provision a new remote-access password. Throws (min length 12) on validation failure. */
  setRemotePassword(password: string): Promise<void>
  /** Clear the remote-access password credential. */
  clearRemotePassword(): Promise<void>
  /**
   * Probe the local Tailscale installation (Phase 3 TLS mode). The result is
   * designed to be user-facing: the failure variants carry an actionable
   * `message` the Settings UI renders verbatim. Main-only — in
   * `RemoteDispatcher.BLOCKED`, because it discloses the node's DNS name and
   * the owner's login.
   */
  detectTailscale(): Promise<TailscaleDetection>
}
