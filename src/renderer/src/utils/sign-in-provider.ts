/**
 * Which sign-in a picker group (or a composer's selected engine) depends on —
 * ADR-068 §3, Slice 6.
 *
 * The model picker groups models by `(engineId, vendorId)`, and the question
 * every group asks is the same one the composer asks about the engine it is
 * about to spawn: *is there a credential behind this, and whose sign-in fixes
 * it?* Two providers can answer — Anthropic (the Claude subscription) and
 * ChatGPT (the shared vault, ADR-068 §1) — and everything else (API keys, free
 * gateways, user-declared endpoints) has no flow ClaudeUI can drive, so it gets
 * no entry point rather than a dead one (ADR-030: never advertise what does not
 * work).
 *
 * Pure and store-free on purpose: the surfaces pass the view in, and the ONE
 * place that reads it off IPC is `refreshProviderAuth` in the session store.
 */
import type { AuthState, EngineId, VendorAuthMap, VendorId } from '../../../shared/types'
import type { ProviderRegistrySnapshot } from '../../../shared/provider-registry'
import { CHATGPT_ROUTE_PROVIDER_IDS } from '../../../shared/shared-provider'
import { engineMeta } from '../../../shared/engine-meta'
import type { SignInProviderId } from '../stores/session-store'

/** The shared vault's id for the ChatGPT subscription (`AuthVault.CHATGPT_PROVIDER_ID`). */
const CHATGPT_ENTRY_ID = 'chatgpt'

/**
 * How each provider is named in a sign-in affordance — the SAME names
 * `SignInDialog` puts in its heading, so "Sign in to Claude" opens a dialog
 * headed "Sign in to Claude". The dialog imports this table rather than keeping
 * its own.
 */
export const SIGN_IN_PROVIDER_LABEL: Record<SignInProviderId, string> = {
  anthropic: 'Claude',
  chatgpt: 'ChatGPT'
}

/**
 * The renderer's one view of "who is signed in", as the entry points need it.
 *
 * `anthropic` is DERIVED from the engine auth probe (`vendorAuth.anthropic`,
 * the same signal `AuthBanner` reads) and is `'unknown'` until a Claude session
 * has reported one — an unprobed host is not a signed-out host, and claiming
 * otherwise would put a Sign in item on every fresh boot.
 *
 * `chatgpt` and `chatgptRoutes` come from `provider-registry:list`; the routes
 * say which engines the ChatGPT credential is actually wired to, because a
 * disabled route means that engine's `openai`/`openai-codex` models are backed
 * by something else entirely (the engine's own auth store) and a ChatGPT
 * sign-in would not touch them.
 */
export interface ProviderAuthView {
  anthropic: AuthState
  chatgpt: AuthState
  chatgptRoutes: Partial<Record<EngineId, boolean>>
}

export const UNKNOWN_PROVIDER_AUTH: ProviderAuthView = {
  anthropic: 'unknown',
  chatgpt: 'unknown',
  chatgptRoutes: {}
}

/** The Anthropic half: the probe's own tri-state, `'unknown'` before it runs. */
export function anthropicAuthState(vendorAuth: VendorAuthMap | null | undefined): AuthState {
  return vendorAuth?.anthropic?.authState ?? 'unknown'
}

/**
 * The ChatGPT half, read off a registry snapshot. `null` (the read failed, or
 * has not happened) leaves both fields at `'unknown'`/`{}` — the honest answer,
 * and the one that renders exactly as today.
 *
 * A MISSING ChatGPT row is also `'unknown'`: the managed definition is always
 * listed on a healthy host, so its absence means the read told us nothing about
 * the vault rather than that the vault is empty.
 */
export function chatgptAuthFromRegistry(
  snapshot: ProviderRegistrySnapshot | null
): Pick<ProviderAuthView, 'chatgpt' | 'chatgptRoutes'> {
  const entry = snapshot?.entries.find((candidate) => candidate.id === CHATGPT_ENTRY_ID)
  if (!entry) return { chatgpt: 'unknown', chatgptRoutes: {} }

  const chatgptRoutes: Partial<Record<EngineId, boolean>> = {}
  for (const [engineId, facts] of Object.entries(entry.engines)) {
    chatgptRoutes[engineId as EngineId] = facts?.enabled ?? false
  }

  // A stored account IS the credential (`sharedCredential`), so a dead ACTIVE
  // account still reports `connected` — `needsReauth` is the only thing that
  // separates "signed in" from "signed in with a token the vault gave up on".
  const active = entry.accounts?.list.find((account) => account.id === entry.accounts?.activeId)
  if (entry.credential === 'none' || active?.needsReauth === true)
    return { chatgpt: 'unauthenticated', chatgptRoutes }
  if (entry.credential === 'connected') return { chatgpt: 'authenticated', chatgptRoutes }
  // A subscription row is only ever `connected` or `none`; anything else means
  // the read model changed under us, and guessing is worse than saying nothing.
  return { chatgpt: 'unknown', chatgptRoutes }
}

/**
 * Which sign-in backs one `(engineId, vendorId)` pair, and what state it is in.
 * `null` = no ClaudeUI-drivable sign-in owns this pair, so no entry point.
 *
 * - **claude / anthropic** — the Claude subscription.
 * - **codex / openai** — Codex runs on the ChatGPT vault and nothing else
 *   (ADR-068 §1). Deliberately NOT gated on `chatgptRoutes`: those describe the
 *   shared provider's pi/opencode routes, which Codex is not one of.
 * - **pi / opencode** — ChatGPT only for the vendor that IS the ChatGPT route
 *   ({@link CHATGPT_ROUTE_PROVIDER_IDS}) and only while that route is enabled.
 * - everything else (API keys, free gateways, custom endpoints) — `null`.
 *
 * An absent `vendorId` falls back to the engine's `defaultVendorId`, which is
 * what a model list with no vendor tracking resolves to anyway.
 */
export function signInProviderFor(
  engineId: EngineId,
  vendorId: VendorId | undefined,
  providerAuth: ProviderAuthView
): { providerId: SignInProviderId; state: AuthState } | null {
  const vendor = vendorId ?? engineMeta(engineId).defaultVendorId
  const chatgpt = { providerId: 'chatgpt', state: providerAuth.chatgpt } as const

  if (engineId === 'claude')
    return vendor === 'anthropic'
      ? { providerId: 'anthropic', state: providerAuth.anthropic }
      : null
  if (engineId === 'codex') return vendor === 'openai' ? chatgpt : null
  if (engineId === 'pi' || engineId === 'opencode')
    return vendor === CHATGPT_ROUTE_PROVIDER_IDS[engineId] && providerAuth.chatgptRoutes[engineId]
      ? chatgpt
      : null
  return null
}
