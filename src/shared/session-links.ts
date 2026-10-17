/**
 * Session refs and parent/child links (session tools, slice 1b, spec §4/§5).
 *
 * A ref is the stable, short handle every session-tools surface uses for a
 * session: it outlives the routing-id rekey and a restart, and it is never
 * shaped like cli.js's `local_<hex>` ids (cli.js intercepts those). A link
 * records "this session was started by / handed off from that one".
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

/** Words the tools resolve in the caller's context, so no session can be addressed by them as a title. */
export const RESERVED_SESSION_WORDS: ReadonlySet<string> = new Set(['self', 'parent'])

export type SessionLinkKind = 'started' | 'handoff'
export type SessionLinkCreator = 'agent' | 'user' | 'pressure'
export type SessionLinkState = 'starting' | 'live' | 'ended' | 'failed' | 'detached'

/** What a client needs of a link. Keyed by the child's ref. */
export interface SessionLinkInfo {
  parentRef: string
  kind: SessionLinkKind
  state: SessionLinkState
  createdBy: SessionLinkCreator
  wakeParent: boolean
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

/** A detached link nests nothing; every other state still names a relationship. */
export function linkNests(link: Pick<SessionLinkInfo, 'state'>): boolean {
  return link.state !== 'detached'
}
