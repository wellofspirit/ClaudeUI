import type { ItemStreamFrame } from './item-stream'

/** A lossy pass-through tail carried outside the reliable event ring. */
export interface StreamEventFrame {
  type: 'stream-ev'
  channel: string
  args: unknown[]
}

/** Every frame retained on the volatile stream lane. */
export type StreamLaneFrame = ItemStreamFrame | StreamEventFrame

export function isStreamEventFrame(value: unknown): value is StreamEventFrame {
  if (!value || typeof value !== 'object') return false
  const frame = value as Record<string, unknown>
  return (
    frame.type === 'stream-ev' && typeof frame.channel === 'string' && Array.isArray(frame.args)
  )
}

/** Bounds each connection-owned watch set to avoid unbounded remote input. */
export const MAX_STREAM_WATCH = 32
/** Congested volatile traffic is dropped; reliable events are never dropped. */
export const STREAM_BACKPRESSURE_BYTES = 1024 * 1024

export type LaneScope = { kind: 'session'; id: string } | { kind: 'automation'; id: string }

export function streamEventScopeOf(frame: StreamEventFrame): LaneScope | null {
  // Automation tails are selected by automation id; session tails use args[0].
  if (frame.channel === 'automation:stream-event') {
    const data = frame.args[0] as { automationId?: unknown } | undefined
    return typeof data?.automationId === 'string' && data.automationId !== ''
      ? { kind: 'automation', id: data.automationId }
      : null
  }
  const routingId = frame.args[0]
  return typeof routingId === 'string' && routingId !== ''
    ? { kind: 'session', id: routingId }
    : null
}
