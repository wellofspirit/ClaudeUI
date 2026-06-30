/**
 * OpencodeAuthProvider — EngineAuthProvider implementation for the 'opencode' engine.
 *
 * probe() merges:
 *   - GET /config/providers  → configured vendors (authState:'authenticated')
 *   - GET /provider/auth     → the auth-option catalog (unconfigured = 'unauthenticated')
 *
 * Auth operations run against a transient server (acquire/release PERSISTED_SESSIONS_DIR)
 * exactly like model-discovery does — auth is global to opencode, not per-session.
 *
 * After any mutation (setVendorApiKey / oauthCallback / removeVendorAuth), the model
 * discovery cache is invalidated so newly-authed vendors appear in the model picker.
 *
 * Degrades to {} on any failure — opencode is optional.
 */

import { opencodeServerManager } from '../opencode/OpencodeServerManager'
import { OpencodeClient } from '../opencode/OpencodeClient'
import { PERSISTED_SESSIONS_DIR } from '../services/persisted-sessions-dir'
import { invalidateOpencodeModelCache } from '../opencode/model-discovery'
import { logger } from '../services/logger'
import type { VendorAuthMap, VendorAuthOption, AccountRef, AuthState } from '../../shared/types'
import type { EngineAuthProvider } from './EngineAuthProvider'

/** Free/bundled opencode providers that never require auth credentials. */
const FREE_VENDOR_IDS = new Set(['opencode', 'zen'])

export class OpencodeAuthProvider implements EngineAuthProvider {
  /**
   * Cached probe result. Warmed on the first probe() call and refreshed after
   * any mutation. Parallel to ClaudeAuthProvider.cachedAuthSource.
   */
  private cachedVendorMap: VendorAuthMap | null = null

  /**
   * Server ref held open across an OAuth flow (authorize → callback).
   *
   * Why: the loopback HTTP listener (e.g. localhost:1455) and the in-memory
   * PKCE verifier/state live INSIDE the opencode server process that handled
   * `oauth/authorize`. If we acquire+release per call, releasing after authorize
   * drops the last ref and KILLS that process — so the subsequent `oauth/callback`
   * spawns a fresh server with no pending flow and fails immediately with
   * `ProviderAuthOauthMissing`. Holding one extra ref keeps the authorize-time
   * server alive until the callback settles (or the flow is cancelled).
   *
   * `released` guards against double-release (idempotent teardown).
   */
  private oauthHold: { released: boolean } | null = null

  // -------------------------------------------------------------------------
  // EngineAuthProvider interface
  // -------------------------------------------------------------------------

  async probe(): Promise<VendorAuthMap> {
    if (this.cachedVendorMap) return this.cachedVendorMap
    const result = await this.fetchVendorMap()
    this.cachedVendorMap = result
    return result
  }

  /**
   * Fetch and merge /config/providers + /provider/auth into a VendorAuthMap.
   * Returns {} on any failure (opencode optional).
   */
  private async fetchVendorMap(): Promise<VendorAuthMap> {
    try {
      const conn = await opencodeServerManager.acquire(PERSISTED_SESSIONS_DIR)
      const client = new OpencodeClient(conn.baseUrl, conn.authHeader)
      try {
        const [configResp, authCatalog] = await Promise.all([
          client.getConfigProviders().catch(() => ({ providers: [] })),
          client.getProviderAuth().catch(() => ({} as Record<string, unknown[]>))
        ])

        const map: VendorAuthMap = {}

        // Mark configured providers as authenticated
        const configuredIds = new Set<string>()
        for (const p of configResp.providers ?? []) {
          configuredIds.add(p.id)
        }

        // Build the map from the auth catalog (the complete vendor set)
        for (const [vendorId, options] of Object.entries(authCatalog)) {
          const isConfigured = configuredIds.has(vendorId)
          const isFree = FREE_VENDOR_IDS.has(vendorId)

          let authState: AuthState
          if (isFree || isConfigured) {
            authState = 'authenticated'
          } else {
            authState = 'unauthenticated'
          }

          // billingType inference:
          // - free vendors (opencode/zen): 'free'
          // - configured-with-oauth: 'subscription' (heuristic: if vendor has oauth options)
          // - configured-with-api-key: 'apiKey'
          // - unconfigured: 'unknown'
          let billingType: 'subscription' | 'apiKey' | 'free' | 'unknown'
          if (isFree) {
            billingType = 'free'
          } else if (!isConfigured) {
            billingType = 'unknown'
          } else {
            // Check what type of auth options the vendor has to infer billing
            const opts = options as Array<{ type: string }>
            const hasOauth = opts.some((o) => o.type === 'oauth')
            const hasApi = opts.some((o) => o.type === 'api')
            if (hasOauth && !hasApi) {
              billingType = 'subscription'
            } else {
              billingType = 'apiKey'
            }
          }

          map[vendorId] = { authState, billingType }
        }

        // Add any configured providers not in the auth catalog (e.g. custom)
        for (const p of configResp.providers ?? []) {
          if (!map[p.id]) {
            map[p.id] = { authState: 'authenticated', billingType: 'unknown' }
          }
        }

        return map
      } finally {
        opencodeServerManager.release(PERSISTED_SESSIONS_DIR)
      }
    } catch (err) {
      logger.warn(
        'OpencodeAuth',
        `probe() failed (opencode optional): ${err instanceof Error ? err.message : String(err)}`
      )
      return {}
    }
  }

  // -------------------------------------------------------------------------
  // Per-vendor auth methods (EngineAuthProvider extension — Phase 5c)
  // -------------------------------------------------------------------------

  async listVendorAuthOptions(): Promise<Record<string, VendorAuthOption[]>> {
    try {
      const conn = await opencodeServerManager.acquire(PERSISTED_SESSIONS_DIR)
      const client = new OpencodeClient(conn.baseUrl, conn.authHeader)
      try {
        const catalog = await client.getProviderAuth()
        // Cast the raw AuthOption[] to VendorAuthOption[] (shapes are compatible)
        return catalog as unknown as Record<string, VendorAuthOption[]>
      } finally {
        opencodeServerManager.release(PERSISTED_SESSIONS_DIR)
      }
    } catch (err) {
      logger.warn(
        'OpencodeAuth',
        `listVendorAuthOptions() failed: ${err instanceof Error ? err.message : String(err)}`
      )
      return {}
    }
  }

  async setVendorApiKey(vendorId: string, key: string): Promise<void> {
    const conn = await opencodeServerManager.acquire(PERSISTED_SESSIONS_DIR)
    const client = new OpencodeClient(conn.baseUrl, conn.authHeader)
    try {
      await client.setAuth(vendorId, { type: 'api', key })
      this.invalidateCache()
      invalidateOpencodeModelCache()
    } finally {
      opencodeServerManager.release(PERSISTED_SESSIONS_DIR)
    }
  }

  async oauthAuthorize(
    vendorId: string,
    method: number,
    inputs?: Record<string, string>
  ): Promise<{ url: string; method: 'auto' | 'code'; instructions: string }> {
    // Drop any stale hold from an abandoned prior flow, then acquire a ref we
    // intentionally do NOT release here — oauthCallback / cancelVendorOauth owns
    // its teardown. This keeps the authorize-time server (loopback + PKCE state)
    // alive until the flow completes.
    this.releaseOauthHold()
    const conn = await opencodeServerManager.acquire(PERSISTED_SESSIONS_DIR)
    this.oauthHold = { released: false }
    const client = new OpencodeClient(conn.baseUrl, conn.authHeader)
    try {
      return await client.oauthAuthorize(vendorId, method, inputs)
    } catch (err) {
      // authorize failed → no callback will come; release immediately.
      this.releaseOauthHold()
      throw err
    }
  }

  async oauthCallback(vendorId: string, method: number, code?: string): Promise<boolean> {
    // acquire() returns the SAME server the oauthAuthorize hold is keeping alive
    // (same PERSISTED_SESSIONS_DIR key), so the callback runs against the process
    // that owns the loopback + PKCE state. With no active hold (stale/duplicate
    // call) this spawns a fresh server with no pending flow — it fails with
    // ProviderAuthOauthMissing, the correct outcome for an orphan callback.
    const conn = await opencodeServerManager.acquire(PERSISTED_SESSIONS_DIR)
    const client = new OpencodeClient(conn.baseUrl, conn.authHeader)
    try {
      const result = await client.oauthCallback(vendorId, method, code)
      this.invalidateCache()
      invalidateOpencodeModelCache()
      return result
    } finally {
      // Release this call's ref, then the authorize-time hold (flow is over).
      opencodeServerManager.release(PERSISTED_SESSIONS_DIR)
      this.releaseOauthHold()
    }
  }

  /**
   * Abandon an in-flight OAuth flow: release the held server ref. If this drops
   * the last ref the process is killed, which makes any pending oauthCallback
   * long-poll reject (connection reset) instead of hanging forever.
   */
  async cancelVendorOauth(): Promise<void> {
    this.releaseOauthHold()
  }

  async removeVendorAuth(vendorId: string): Promise<void> {
    const conn = await opencodeServerManager.acquire(PERSISTED_SESSIONS_DIR)
    const client = new OpencodeClient(conn.baseUrl, conn.authHeader)
    try {
      await client.removeAuth(vendorId)
      this.invalidateCache()
      invalidateOpencodeModelCache()
    } finally {
      opencodeServerManager.release(PERSISTED_SESSIONS_DIR)
    }
  }

  // -------------------------------------------------------------------------
  // Helpers for OpencodeSession.status.account
  // -------------------------------------------------------------------------

  /**
   * Build an AccountRef for the given vendor from the cached probe.
   * Returns null if the probe hasn't run yet or the vendor isn't found.
   */
  buildAccountRef(vendorId: string): AccountRef | null {
    const entry = this.cachedVendorMap?.[vendorId]
    if (!entry) return null
    return {
      engineId: 'opencode',
      vendorId,
      billingType: entry.billingType,
      authState: entry.authState,
      label: entry.label
    }
  }

  /** Warm the probe cache eagerly (call at app start or on first opencode use). */
  async warmCache(): Promise<void> {
    if (!this.cachedVendorMap) {
      this.cachedVendorMap = await this.fetchVendorMap()
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private invalidateCache(): void {
    this.cachedVendorMap = null
  }

  /** Release the OAuth-flow server hold exactly once (idempotent). */
  private releaseOauthHold(): void {
    if (this.oauthHold && !this.oauthHold.released) {
      this.oauthHold.released = true
      opencodeServerManager.release(PERSISTED_SESSIONS_DIR)
    }
    this.oauthHold = null
  }
}

/** Singleton opencode auth provider. */
export const opencodeAuthProvider = new OpencodeAuthProvider()
