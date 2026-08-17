/**
 * The SANITIZED remote-server config, in one place (ADR-054 series 2).
 *
 * ## Why this is its own module
 *
 * There are now TWO readers of "the remote config as a UI may see it":
 *
 *  - the host anchor's `remote:get-config` (desktop renderer, boot-core), and
 *  - `authcfg:get` — the web-reachable READ that makes ADR-054 decision 6's
 *    "routine remote-access settings become web-reachable" actually usable. You
 *    cannot administer a surface you cannot render, and the settings pane has to
 *    show the tier, the dials and the credential count before it can write one.
 *
 * They must return the SAME object, because the settings components are shared
 * between the desktop renderer and the web bundle and branch only on transport
 * for WRITES. A second sanitizer would be a second place to forget a field —
 * the exact "two functions restating one rule" failure `step-up-tier.ts`'s
 * header was written about. It lives under `services/` rather than in
 * `boot-core.ts` so `ipc/authcfg-commands.ts` can import it without a cycle
 * (boot-core imports the ipc layer, never the other way round).
 *
 * ## What it must never carry
 *
 * `password_salt` / `password_hash` / `kdf_params` — only the derived
 * `passwordSet` boolean — and not `last_serve_*`, which is internal
 * reconciliation bookkeeping (ADR-042) rather than user-facing configuration.
 * That rule mattered when only the desktop could read this; it is load-bearing
 * now that a browser can.
 *
 * `lan_e2e_key` (ADR-056 item C) joins that list and is the sharpest case: it is
 * a live channel secret, and `authcfg:get` is the ONE verb in its namespace with
 * no session gate. The LAN link has its own verb — `authcfg:lan-link`, inside a
 * settings-editing session — precisely so this free read never carries it.
 */

import {
  DEFAULT_AUDIT_RETENTION_DAYS,
  DEFAULT_SHELL_GRANT_IDLE_MINUTES,
  DEFAULT_TLS_HTTPS_PORT,
  getRemoteConfig
} from './db'
import { readAuthPolicyContext, readEffectiveStepUpTier, resolveAuthPolicy } from './auth-policy'
import type { RemoteConfig } from '../../shared/types'

/**
 * Sanitized view of the persisted remote-server config. Defaults mirror the DB
 * column defaults so the shape is stable even before any row has been written.
 */
export function sanitizedRemoteConfig(): RemoteConfig {
  const config = getRemoteConfig()
  const policyCtx = readAuthPolicyContext()
  return {
    port: config?.port ?? 0,
    bindHost: config?.bindHost ?? null,
    autostart: config?.autostart ?? false,
    tlsMode: config?.tlsMode ?? 0,
    tlsHttpsPort: config?.tlsHttpsPort ?? DEFAULT_TLS_HTTPS_PORT,
    // NOT exposed: last_serve_https_port / last_serve_local_port. They are
    // internal bookkeeping for the startup serve reconciliation (ADR-042), not
    // user-facing configuration.
    allowTerminal: config?.allowTerminal ?? false,
    shellGrantIdleMinutes: config?.shellGrantIdleMinutes ?? DEFAULT_SHELL_GRANT_IDLE_MINUTES,
    // Both the RAW setting (null = auto) and what it resolves to right now: a
    // settings UI has to be able to say "Automatic (passkeys required)" without
    // re-deriving the rule, and re-deriving it in the renderer is exactly how
    // the displayed policy would drift from the enforced one.
    authPolicy: config?.authPolicy ?? null,
    effectiveAuthPolicy: resolveAuthPolicy(policyCtx),
    credentialCount: policyCtx.credentialCount,
    passwordBreakGlass: config?.passwordBreakGlass ?? true,
    // NOT exposed: lan_e2e_key. See the header — it is a channel secret and this
    // read is ungated.
    // ADR-054's second axis, raw + resolved for the same reason the policy is:
    // auth-mode `off` FORCES tier `off`, and re-deriving that in the renderer is
    // how a displayed tier drifts from the enforced one.
    stepUpTier: policyCtx.stepUpTier,
    effectiveStepUpTier: readEffectiveStepUpTier(policyCtx),
    stepUpMutationIdleMinutes: policyCtx.stepUpMutationIdleMinutes,
    sessionMaxAgeHours: policyCtx.sessionMaxAgeHours,
    auditRetentionDays: config?.auditRetentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS,
    passwordSet: config?.passwordHash != null,
    passwordUpdatedAt: config?.passwordUpdatedAt ?? null
  }
}
