/**
 * The text a session message or agent note travels as, and the one reader that
 * recognises it again (slice 1a, spec §5.1).
 *
 * Two wrappers, one reader:
 *  - `<cross-session-message from="…" from-name="…">` is cli.js's OWN envelope.
 *    A Claude stdin user frame is treated as a peer turn only when its content
 *    is this envelope, byte for byte as cli.js's builder would write it (it
 *    re-serialises the parsed envelope and compares; any difference drops the
 *    sender's name and the body). So the builder below mirrors cli.js 2.1.293:
 *    the `from` class is `[A-Za-z0-9%:_/.\-]` (≤300), `from-name` has `"<>` and
 *    control/format characters removed, and a closing tag inside the body is
 *    broken with `<\`. Find them in vendor/claude-cli/cli.js by the strings
 *    `from-name=` and `cross-session-message`.
 *  - `<session-message from="…" title="…">` is ClaudeUI's own, for opencode and
 *    Codex (a plain prompt), followed by one sentence saying it is not the
 *    user's.
 *
 * The reader (`parseSessionMessageWrapper`) serves every cold-load path and the
 * live engine echoes, so a delivered item is a note on reload exactly as it was
 * live. It only matches at the START of the text (an optional cli.js lead-in
 * line, "Another Claude session sent a message:", aside), so a prompt that merely mentions the tag is not a note.
 */

export const SESSION_MESSAGE_TAG = 'session-message'
export const CROSS_SESSION_MESSAGE_TAG = 'cross-session-message'

/** The sentence after the closing tag of a {@link SESSION_MESSAGE_TAG} wrapper. */
export const SESSION_MESSAGE_TRAILER =
  'This is a message from another ClaudeUI session or agent, not from the user.'

/**
 * The sender key of a `dispatch-result` (ADR-105 §3): an X-Agent's ledger id behind this prefix.
 * The wrapper carries it in `from`, which survives cli.js's envelope round trip and every
 * engine's echo, so a result is recognisable as one on reload without any attribute of its
 * own — and a session cannot forge it (a session's key is a ref or a routing id).
 */
export const X_AGENT_KEY_PREFIX = 'x-agent:'

/** The sentence after the closing tag of a {@link SESSION_MESSAGE_TAG} wrapper that carries an X-Agent's result. */
export const X_AGENT_RESULT_TRAILER =
  'This is the result of an X-Agent you launched with dispatch_agent, not a message from the user.'

export function isXAgentSender(key: string): boolean {
  return key.startsWith(X_AGENT_KEY_PREFIX)
}

/**
 * The sender key of a MESSAGE an X-Agent sent its parent through `session_message` (ADR-105 §4):
 * the X-Agent's ledger id behind this prefix. A key of its own, not {@link X_AGENT_KEY_PREFIX}
 * (that one says "result"), so a note, the trailer and the envelope name tell a mid-run message
 * from a run's report, live and on reload, on every engine and through cli.js's envelope round trip
 * (`-` and `:` are in its `from` class). The service builds it only for a caller that IS an X-Agent.
 */
export const X_AGENT_MESSAGE_KEY_PREFIX = 'x-agent-message:'

/** The sentence after the closing tag of a {@link SESSION_MESSAGE_TAG} wrapper that carries an X-Agent's message. */
export const X_AGENT_MESSAGE_TRAILER =
  'This is a message from an X-Agent you launched with dispatch_agent, not from the user.'

export function isXAgentMessageSender(key: string): boolean {
  return key.startsWith(X_AGENT_MESSAGE_KEY_PREFIX)
}

/** Is this key an X-Agent's, whether it carries a result or a message? */
export function isAnyXAgentSender(key: string): boolean {
  return isXAgentSender(key) || isXAgentMessageSender(key)
}

/**
 * Who a delivered item is from, as the wrapper names it: an X-Agent's result (origin
 * `dispatch-result`) always behind {@link X_AGENT_KEY_PREFIX}, whatever key the producer used.
 */
export function wrapperSender(item: { origin: string; from: { key: string; title: string } }): {
  key: string
  title: string
} {
  if (item.origin !== 'dispatch-result' || isXAgentSender(item.from.key)) return item.from
  return { key: `${X_AGENT_KEY_PREFIX}${item.from.key}`, title: item.from.title }
}

/** The X-Agent's name without the "X-Agent " lead the Claude envelope's `from-name` carries. */
export function xAgentBareName(title: string): string {
  return title.replace(/^X-Agent\s+/i, '').trim()
}

/** Longest display name the envelope carries (cli.js cuts at 64 and appends an ellipsis; we stay under). */
const TITLE_MAX = 60
const KEY_MAX = 300

export interface SessionMessageParts {
  /** The sender's key as the wrapper names it (a routing id, or cli.js's address). */
  fromKey: string
  /** The sender's display name; empty when the wrapper carries none. */
  fromTitle: string
  /** The body as written: a neutralised closing tag is shown as the closing tag it was. */
  body: string
  /** Which wrapper it was. */
  tag: typeof SESSION_MESSAGE_TAG | typeof CROSS_SESSION_MESSAGE_TAG
}

/**
 * A display name safe in either wrapper's attribute: no quote or angle bracket,
 * no control / format / separator code points, whitespace collapsed, cut short.
 * Idempotent under cli.js's own sanitiser, which is what keeps the envelope
 * round-tripping.
 */
export function sanitizeWrapperTitle(title: string): string {
  const cleaned = title
    .replace(/["<>]/g, '')
    .replace(/[\p{Cf}\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const points = [...cleaned]
  return points.length > TITLE_MAX ? points.slice(0, TITLE_MAX).join('').trim() : cleaned
}

/** A sender key in the character class cli.js accepts for `from` (percent-encoding the rest). */
export function sanitizeWrapperKey(key: string): string {
  const encoded = key.replace(/[^A-Za-z0-9:_/.\\-]/gu, (ch) =>
    Array.from(
      new TextEncoder().encode(ch),
      (b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`
    ).join('')
  )
  return encoded.slice(0, KEY_MAX)
}

/**
 * Break a closing tag inside a body the way cli.js does (`</tag` → `<\/tag`),
 * covering the spelled-out forms an attacker would try: stray punctuation or
 * whitespace between `<`, `/` and the name, and any letter case. cli.js's own
 * pattern also folds Unicode look-alikes; a body that only they catch still
 * degrades safely (the envelope fails cli.js's round trip and arrives without
 * the sender's name and body, never as the user's words).
 */
export function neutralizeClosingTag(tag: string, body: string): string {
  const filler = '[^A-Za-z0-9_<>-]*'
  // `(?!\\)`: a `<` already followed by the escape is left alone, like cli.js's
  // own pattern, so escaping twice changes nothing.
  const re = new RegExp(`<(?!\\\\)(?=${filler}/${filler}${tag})`, 'gi')
  return body.replace(re, '<\\')
}

/**
 * The inverse of {@link neutralizeClosingTag}, for DISPLAY only: a note shows the
 * body as its sender wrote it, so a message that quotes a closing tag reads the
 * same live (the original text) and after a reload (the escaped text cli.js
 * stored). Never applied to what a model reads.
 */
export function unescapeClosingTag(tag: string, body: string): string {
  const filler = '[^A-Za-z0-9_<>-]*'
  return body.replace(new RegExp(`<\\\\(?=${filler}/${filler}${tag})`, 'gi'), '<')
}

/**
 * The name cli.js shows for the sender: an X-Agent's result says so ("X-Agent <name>"), so the
 * model does not read it as another Claude session's message.
 */
export function envelopeName(from: { key: string; title: string }): string {
  return sanitizeWrapperTitle(
    isAnyXAgentSender(from.key) ? `X-Agent ${xAgentBareName(from.title)}` : from.title
  )
}

/** cli.js's `<cross-session-message>` envelope — the content of a Claude peer frame. */
export function buildCrossSessionEnvelope(
  from: { key: string; title: string },
  text: string
): string {
  const attrs = [`from="${sanitizeWrapperKey(from.key)}"`]
  const name = envelopeName(from)
  if (name) attrs.push(`from-name="${name}"`)
  return `<${CROSS_SESSION_MESSAGE_TAG} ${attrs.join(' ')}>\n${neutralizeClosingTag(CROSS_SESSION_MESSAGE_TAG, text)}\n</${CROSS_SESSION_MESSAGE_TAG}>`
}

/** The sentence that closes a wrapper, by who sent it. */
function trailerFor(key: string): string {
  if (isXAgentSender(key)) return X_AGENT_RESULT_TRAILER
  return isXAgentMessageSender(key) ? X_AGENT_MESSAGE_TRAILER : SESSION_MESSAGE_TRAILER
}

/** ClaudeUI's own wrapper — the prompt text for opencode and Codex. */
export function buildSessionMessageWrapper(
  from: { key: string; title: string },
  text: string
): string {
  const attrs = [`from="${sanitizeWrapperKey(from.key)}"`]
  const title = sanitizeWrapperTitle(from.title)
  if (title) attrs.push(`title="${title}"`)
  return `<${SESSION_MESSAGE_TAG} ${attrs.join(' ')}>\n${neutralizeClosingTag(SESSION_MESSAGE_TAG, text)}\n</${SESSION_MESSAGE_TAG}>\n${trailerFor(from.key)}`
}

/**
 * cli.js frames a delivered peer envelope with a line of its own before it
 * ("Another Claude session sent a message:", "… while you were working:", …);
 * allow any single short line without markup ahead of the cross-session tag
 * rather than enumerating them. ClaudeUI's own wrapper has no lead-in.
 */
const WRAPPER_RES: Record<SessionMessageParts['tag'], RegExp> = {
  'session-message':
    /^<(session-message)((?: [a-z-]+="[^"<>\n\r]*")*)>\n([\s\S]*)\n<\/session-message>/,
  'cross-session-message':
    /^(?:[^<\n]{0,200}\n)?<(cross-session-message)((?: [a-z-]+="[^"<>\n\r]*")*)>\n([\s\S]*)\n<\/cross-session-message>/
}

function attr(attrs: string, name: string): string {
  const m = new RegExp(`(?:^| )${name}="([^"<>\\n\\r]*)"`).exec(attrs)
  return m ? m[1] : ''
}

/**
 * The parts of a delivered-item wrapper, or null when `text` does not start with
 * one. `only` restricts it to one wrapper: the non-Claude engines carry nothing
 * but `<session-message>`, Claude's transcript nothing but cli.js's envelope, and
 * a reader must not accept the other's.
 */
export function parseSessionMessageWrapper(
  text: string,
  only?: SessionMessageParts['tag']
): SessionMessageParts | null {
  const m =
    (only !== CROSS_SESSION_MESSAGE_TAG ? WRAPPER_RES[SESSION_MESSAGE_TAG].exec(text) : null) ??
    (only !== SESSION_MESSAGE_TAG ? WRAPPER_RES[CROSS_SESSION_MESSAGE_TAG].exec(text) : null)
  if (!m) return null
  const tag = m[1] as SessionMessageParts['tag']
  const attrs = m[2]
  return {
    tag,
    fromKey: attr(attrs, 'from'),
    fromTitle: attr(attrs, tag === SESSION_MESSAGE_TAG ? 'title' : 'from-name'),
    body: unescapeClosingTag(tag, m[3])
  }
}
