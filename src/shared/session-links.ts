/**
 * Session refs and the links between sessions (session tools, slice 1b, spec §4/§5;
 * reworked in slice 5 into flat groups).
 *
 * A ref is the stable, short handle every session-tools surface uses for a
 * session: it outlives the routing-id rekey and a restart, and it is never
 * shaped like cli.js's `local_<hex>` ids (cli.js intercepts those). A link
 * records "this session was started by / handed off from that one" — its ORIGIN —
 * and whether the user sees the two as one piece of work (`grouped`). There is no
 * parent/child relationship as such: the lineage is always kept, and a group is
 * only a way of showing sequential work together.
 *
 * Shared by the host (`core/services/session-links.ts`), the canonical reducer
 * and the renderer, so the types and the ref shape have one definition.
 */

/** Crockford's base32, lowercase: no `i`, `l`, `o`, `u`, so no two characters read alike. */
export const REF_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'
export const REF_LENGTH = 6

/** Exactly the refs we mint. */
export const REF_PATTERN = /^s-[0-9a-hjkmnp-tv-z]{6}$/
/** Anything that could pass for a ref; a title like this is never matched as one. */
const REF_LIKE_PATTERN = /^s-[0-9a-z]{6}$/i

export function isRef(input: string): boolean {
  return REF_PATTERN.test(input)
}

/** Shaped like a ref, whether or not we minted it. */
export function isRefShaped(input: string): boolean {
  return REF_LIKE_PATTERN.test(input)
}

/**
 * Words the tools resolve in the caller's context, so no session can be addressed by them
 * as a title. `origin` is the session that started the caller; `parent` is the older
 * spelling of it, still accepted.
 */
export const RESERVED_SESSION_WORDS: ReadonlySet<string> = new Set(['self', 'origin', 'parent'])

export type SessionLinkKind = 'started' | 'handoff'
export type SessionLinkCreator = 'agent' | 'user'
export type SessionLinkState = 'starting' | 'live' | 'ended' | 'failed'

/** What a client needs of a link. Keyed by the started session's ref. */
export interface SessionLinkInfo {
  /** The session that started this one: the origin the lineage names. */
  originRef: string
  kind: SessionLinkKind
  state: SessionLinkState
  createdBy: SessionLinkCreator
  /** Shown as part of the origin's group (a hand-off always starts so; the user can change it). */
  grouped: boolean
  createdAt: number
}

/** The replicated link state: the links, and the sidebar id of each session they name. */
export interface SessionLinksPayload {
  /** child ref → link. */
  links: Record<string, SessionLinkInfo>
  /**
   * sidebar id → ref, for every session a link names. The sidebar id is the one
   * a row is keyed by: the routing id while a session is live (the engine's
   * session id after its rekey), the durable session id otherwise.
   */
  refs: Record<string, string>
}

/**
 * The head of the group `ref` belongs to: the topmost session reached by following
 * `grouped` links upward. A session whose own link is missing or standalone is its own
 * head, and so is one whose chain reaches a cycle (never recorded, but replicated data
 * is not trusted: the walk stops at the first repeat).
 */
export function groupHeadRef(
  linkOf: (ref: string) => Pick<SessionLinkInfo, 'originRef' | 'grouped'> | undefined,
  ref: string
): string {
  const seen = new Set<string>([ref])
  let cur = ref
  for (;;) {
    const link = linkOf(cur)
    if (!link || !link.grouped || seen.has(link.originRef)) return cur
    seen.add(link.originRef)
    cur = link.originRef
  }
}
