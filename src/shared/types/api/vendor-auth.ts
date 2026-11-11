import type { EngineId } from '../engine'
import type {
  VendorAuthMap,
  VendorAuthOption,
  VendorDeviceCodeStart,
  VendorDeviceCodeStatus
} from '../auth'

/** Engine-routed per-vendor auth API (opencode's multi-vendor auth model). */
export interface VendorAuthAPI {
  /** Probe all vendors for a given engine. */
  vendorAuthProbe(engineId: EngineId): Promise<VendorAuthMap>
  /** List per-vendor auth options (GET /provider/auth). */
  vendorAuthListOptions(engineId: EngineId): Promise<Record<string, VendorAuthOption[]>>
  /**
   * Which vendor ids have stored credentials in the engine's own auth store
   * (read-only file peek — ids + credential kind only, never key material).
   */
  vendorAuthListKeys(engineId: EngineId): Promise<Record<string, 'api' | 'oauth'>>
  /** Set an API key for a vendor. */
  vendorAuthSetKey(engineId: EngineId, vendorId: string, key: string): Promise<void>
  /** Start an OAuth flow for a vendor. Returns the URL to open + instructions. */
  vendorAuthOauthAuthorize(
    engineId: EngineId,
    vendorId: string,
    method: number,
    inputs?: Record<string, string>
  ): Promise<{ url: string; method: 'auto' | 'code'; instructions: string }>
  /**
   * Start a DEVICE-CODE sign-in for a vendor (ADR-068 §3, Slice 7 — ChatGPT via
   * pi's `openai-codex` today). This ALSO starts the host-side wait; the caller
   * follows it with {@link vendorAuthDeviceCodeStatus}, never with a long
   * `vendorAuthOauthCallback` invoke.
   */
  vendorAuthDeviceCodeStart(engineId: EngineId, vendorId: string): Promise<VendorDeviceCodeStart>
  /**
   * How the started device-code sign-in is going. Polled; never carries a token.
   * See {@link VendorDeviceCodeStatus} for why the wait is not one long invoke.
   */
  vendorAuthDeviceCodeStatus(engineId: EngineId): Promise<VendorDeviceCodeStatus>
  /** Submit the OAuth code (paste-code flow). Omit code for auto/loopback flow. */
  vendorAuthOauthCallback(
    engineId: EngineId,
    vendorId: string,
    method: number,
    code?: string
  ): Promise<boolean>
  /** Remove auth credentials for a vendor. */
  vendorAuthRemove(engineId: EngineId, vendorId: string): Promise<void>
  /**
   * Abandon an in-flight vendor OAuth flow, releasing resources held open across
   * the authorize → callback handshake (e.g. the loopback-hosting server). Safe
   * to call with no active flow.
   */
  vendorAuthOauthCancel(engineId: EngineId): Promise<void>
}
