/**
 * Failure output for the opencode 2.x contract suite: these tests are the
 * per-pin-bump gate (ADR-097 §8.1), so a red test must say WHAT the engine did
 * — the event sequence, what the model was sent, outbound attempts, the
 * engine's own log — with every secret redacted.
 */
import { messageText, type FixtureProvider } from './fixture-provider'

const SECRET_KEYS = /^(key|apikey|access|refresh|authorization|password|token|bearer)$/i

/** Deep copy with secret-named fields and Bearer/Basic values replaced by their length. */
export function redact(value: unknown): unknown {
  if (typeof value === 'string')
    return /^(Bearer|Basic) /.test(value)
      ? `${value.split(' ')[0]} <redacted:${value.length}>`
      : value
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEYS.test(key) && typeof item === 'string' && item
          ? `<redacted:${item.length}>`
          : redact(item)
      ])
    )
  return value
}

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) + '…' : text)

interface RawEvent {
  readonly type?: string
  readonly data?: { readonly sessionID?: unknown }
}

/**
 * One line per event: index, type, session suffix, clipped redacted payload.
 * Consecutive deltas of one type collapse into a counted line.
 */
export function formatTrace(events: readonly unknown[], options: { last?: number } = {}): string {
  const lines: string[] = []
  const start = Math.max(0, events.length - (options.last ?? 150))
  let run: { type: string; count: number; first: number; text: string } | null = null
  const flush = () => {
    if (!run) return
    lines.push(`  #${run.first} ${run.type} ×${run.count} ${JSON.stringify(clip(run.text, 120))}`)
    run = null
  }
  for (let i = start; i < events.length; i++) {
    const event = events[i] as RawEvent
    const type = String(event.type)
    const data = (event.data ?? {}) as { sessionID?: unknown; delta?: unknown }
    if (type.endsWith('.delta')) {
      if (run && run.type === type) {
        run.count++
        run.text += String(data.delta ?? '')
        continue
      }
      flush()
      run = { type, count: 1, first: i, text: String(data.delta ?? '') }
      continue
    }
    flush()
    const session = typeof data.sessionID === 'string' ? ` [${data.sessionID.slice(-6)}]` : ''
    lines.push(`  #${i} ${type}${session} ${clip(JSON.stringify(redact(event.data)), 220)}`)
  }
  flush()
  return lines.join('\n')
}

export function formatRequests(fixture: FixtureProvider, last = 12): string {
  const chat = fixture.requests.slice(-last).map((request) => {
    const tail = request.messages
      .slice(-3)
      .map(
        (message) => `${message.role}:${JSON.stringify(clip(messageText(message.content), 100))}`
      )
      .join(' | ')
    return `  #${request.n} ${request.path} auth=${String(redact(request.authorization))} tools=${request.tools.length} … ${tail}`
  })
  const upstream = fixture.upstream
    .slice(-last)
    .map(
      (request) =>
        `  #${request.n} ${request.path} auth=${String(redact(request.authorization))} account=${request.account}`
    )
  return [...chat, ...(upstream.length ? ['  upstream:', ...upstream] : [])].join('\n')
}
