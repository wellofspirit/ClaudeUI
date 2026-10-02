/**
 * The usage-ledger row for one pi assistant message — shared by PiSession's
 * own turns and its host-run subagents' (ADR-089 D6), so the account
 * attribution and the list-price flag are stated once.
 */
import { piAuthProvider } from '../auth/PiAuthProvider'
import type { UsageTurnEvent } from '../services/usage-recorder'
import type { PiMapperOutput } from './event-mapper'

export interface PiUsageRowOpts {
  /** The pi session the message belongs to (a child's own id for a subagent row). */
  sessionId: string | null
  /** `'session'` for the session's own turns, `'child'` for a subagent's. */
  origin: 'session' | 'child'
  /** The spawning session's routing id for a child row; null for the session's own. */
  parentRoutingId: string | null
}

export function piUsageEvent(
  output: Extract<PiMapperOutput, { kind: 'usage' }>,
  opts: PiUsageRowOpts
): UsageTurnEvent {
  // ADR-071 §3: the account this vendor's turns run under, read from pi's own
  // auth.json per turn.
  const identity = piAuthProvider.accountIdentity(output.provider)
  return {
    engineId: 'pi',
    vendorId: output.provider,
    // Mirrors OpencodeSession.recordTurnUsage's identical pattern
    // (opencodeAuthProvider.buildAccountRef(...).accountId ?? null) —
    // PiAuthProvider shipped in M3, so this is no longer the M1 gap the
    // old comment here described.
    accountId: piAuthProvider.buildPiAccountRef(output.provider)?.accountId ?? null,
    accountUuid: null, // pi's auth.json has no OAuth account UUID field (same gap as opencode's)
    modelId: output.modelId,
    tokens: {
      input: output.tokens.input,
      output: output.tokens.output,
      cacheWrite: output.tokens.cacheWrite,
      cacheWrite1h: 0, // pi does not distinguish 1h-TTL cache writes
      cacheRead: output.tokens.cacheRead
    },
    engineCostUsd: output.costUsd,
    sessionId: opts.sessionId,
    messageId: output.messageId,
    source: 'live',
    accountKey: identity.accountKey,
    accountLabel: identity.accountLabel,
    billingType: piAuthProvider.buildPiAccountRef(output.provider)?.billingType ?? 'unknown',
    origin: opts.origin,
    parentRoutingId: opts.parentRoutingId,
    // pi reports a LIST PRICE, not a charge: its catalog knows
    // long-context tiers our table does not (S1b), but the figure is the
    // same whether the credential is a subscription or an API key.
    engineCostIsEquivalent: true
  }
}
