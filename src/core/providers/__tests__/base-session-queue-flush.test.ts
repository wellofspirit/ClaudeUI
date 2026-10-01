/**
 * @vitest-environment node
 *
 * `BaseSession.flushQueuedItems` — boundary serialization (ADR-053).
 *
 * The flush is serialized so two boundaries cannot forward the same item
 * twice. The trap is what "serialized" costs: if a boundary arriving mid-flush
 * is simply DROPPED, a forward the engine refuses strands its item, because a
 * finished turn emits no later boundary to retry it. CodexSession had to work
 * around this locally (`queueBoundary` chains boundaries on its own promise);
 * the memory lives in the base now, so every engine gets it.
 *
 * These tests drive the base class directly through a probe subclass — no
 * engine, no Electron, no DB — so they pin the scheduling rule itself rather
 * than any one adapter's use of it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AttachmentUpload, EngineId, QueuedItem } from '../../../shared/types'
import type { ResolvedCapabilities } from '../../../shared/model-capabilities'

const { emitted } = vi.hoisted(() => ({
  emitted: [] as Array<{ channel: string; args: unknown[] }>
}))

vi.mock('../../services/sync-host', () => ({
  emitEvent: (channel: string, args: unknown[]) => emitted.push({ channel, args }),
  addExtraSink: vi.fn(),
  removeExtraSink: vi.fn(),
  extraSinks: () => new Set()
}))
vi.mock('../../services/db', () => ({ dispatchedCostsByRouting: () => [] }))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { BaseSession } from '../BaseSession'
import { blobRefOf } from '../../../test/helpers/blob-refs'

type Deferred = { promise: Promise<void>; resolve: () => void }
function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** The abstract surface of a session with nothing behind it. */
abstract class StubSession extends BaseSession {
  readonly engineId: EngineId = 'opencode'
  readonly capabilities = {} as ResolvedCapabilities
  readonly willQueue = false

  getSessionId(): string | null {
    return null
  }
  async run(
    _prompt: string | null,
    _attachments?: AttachmentUpload[],
    _clientUserMessageId?: string
  ): Promise<void> {}
  async interrupt(): Promise<void> {}
  cancel(): void {}
  resolveApproval(): void {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  dispose(): void {}

  /** Public seam for the protected boundary entry point. */
  boundary(): Promise<void> {
    return this.flushQueuedItems()
  }
}

/**
 * Probe session whose forward is scripted per attempt: each entry decides
 * whether the item is acknowledged (delivered) and hands back a gate the test
 * settles by hand, so a boundary can be fired while a forward is in flight.
 */
class ProbeSession extends StubSession {
  /** One entry per forward attempt, oldest first. */
  readonly attempts: Array<{ item: QueuedItem; gate: Deferred }> = []
  /** Attempt index -> deliver the item on that attempt. Default: refuse. */
  deliverOn = new Set<number>()

  protected override async forwardQueuedItem(item: QueuedItem): Promise<void> {
    const index = this.attempts.length
    const gate = deferred()
    this.attempts.push({ item, gate })
    await gate.promise
    // An engine that accepted the prompt acks through onPromptDelivered; one
    // that refused leaves the item `queued`, which is how the flush reads
    // "nothing landed".
    if (this.deliverOn.has(index)) this.onPromptDelivered(item.text)
  }
}

function probe(): ProbeSession {
  return new ProbeSession('rid', { isDestroyed: () => false } as never, '/repo')
}

/** Let queued microtasks (the awaits inside the flush loop) run. */
const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  emitted.length = 0
})

describe('BaseSession.flushQueuedItems — boundary serialization', () => {
  it('runs one more pass for a boundary that arrives while a forward is in flight', async () => {
    const s = probe()
    s.enqueuePrompt('held until a boundary')

    // Boundary 1: the forward starts and parks awaiting the engine.
    const first = s.boundary()
    await settle()
    expect(s.attempts).toHaveLength(1)

    // Boundary 2 (e.g. turn end) lands mid-forward. Pre-fix this returned
    // early and was lost forever.
    const second = s.boundary()
    await settle()
    expect(s.attempts).toHaveLength(1)

    // The engine refuses the first attempt (item stays `queued`).
    s.attempts[0].gate.resolve()
    await settle()

    // The remembered boundary must produce a second forward attempt.
    // Pre-fix: attempts stays at 1 and the item is stranded until the user
    // sends something else.
    expect(s.attempts).toHaveLength(2)
    expect(s.attempts[1].item.itemId).toBe(s.attempts[0].item.itemId)
    expect(s.queuedItems).toHaveLength(1)

    // Second attempt lands.
    s.deliverOn.add(1)
    s.attempts[1].gate.resolve()
    await Promise.all([first, second])
    expect(s.queuedItems).toHaveLength(0)
  })

  it('coalesces several mid-flush boundaries into a single extra pass', async () => {
    const s = probe()
    s.enqueuePrompt('one')

    const first = s.boundary()
    await settle()
    expect(s.attempts).toHaveLength(1)

    const extra = [s.boundary(), s.boundary(), s.boundary()]
    await settle()

    s.attempts[0].gate.resolve()
    await settle()

    // Three swallowed boundaries buy exactly one rerun, not three.
    expect(s.attempts).toHaveLength(2)

    s.deliverOn.add(1)
    s.attempts[1].gate.resolve()
    await Promise.all([first, ...extra])
    await settle()
    expect(s.attempts).toHaveLength(2)
    expect(s.queuedItems).toHaveLength(0)
  })

  it('still forwards one item at a time — a mid-flight boundary never doubles a send', async () => {
    const s = probe()
    s.enqueuePrompt('a')
    s.enqueuePrompt('b')
    s.deliverOn.add(0).add(1)

    const first = s.boundary()
    await settle()
    expect(s.attempts.map((a) => a.item.text)).toEqual(['a'])

    // A boundary during the in-flight forward of 'a' must not start 'b'.
    const second = s.boundary()
    await settle()
    expect(s.attempts).toHaveLength(1)

    s.attempts[0].gate.resolve()
    await settle()
    expect(s.attempts.map((a) => a.item.text)).toEqual(['a', 'b'])

    s.attempts[1].gate.resolve()
    await Promise.all([first, second])
    await settle()
    // The remembered boundary reruns the loop, finds nothing unforwarded, and
    // stops — no third attempt, no resend of either item.
    expect(s.attempts).toHaveLength(2)
    expect(s.queuedItems).toHaveLength(0)
  })

  it('does not spin when the queue is empty and boundaries keep arriving', async () => {
    const s = probe()
    await s.boundary()
    await s.boundary()
    expect(s.attempts).toHaveLength(0)
  })
})

/**
 * The default drain (opencode and pi) hands the engine the bytes the user
 * uploaded, while the item that is broadcast carries refs only (ADR-087).
 */
class RunProbeSession extends StubSession {
  readonly runs: Array<{ prompt: string | null; attachments?: AttachmentUpload[] }> = []

  override async run(prompt: string | null, attachments?: AttachmentUpload[]): Promise<void> {
    this.runs.push({ prompt, attachments })
  }
}

describe('BaseSession.forwardQueuedItem — attachments', () => {
  const UPLOAD: AttachmentUpload = {
    mediaType: 'image/png',
    base64Data: 'QUJDREVGR0g=',
    fileName: 'shot.png'
  }

  it('runs the original upload bytes, and broadcasts the ref only', async () => {
    const s = new RunProbeSession('rid', { isDestroyed: () => false } as never, '/repo')
    s.enqueuePrompt('look at this', [UPLOAD])

    const queued = (): string[] =>
      emitted
        .filter((e) => e.channel === 'session:queue-changed')
        .map((e) => JSON.stringify(e.args))
    expect(queued().length).toBeGreaterThan(0)
    expect(s.queuedItems[0].attachments).toEqual([
      { mediaType: 'image/png', ...blobRefOf(UPLOAD.base64Data), fileName: 'shot.png' }
    ])

    await s.boundary()
    expect(s.runs).toEqual([{ prompt: 'look at this', attachments: [UPLOAD] }])
    // Every broadcast so far — the enqueue, plus anything the drain emitted
    // (the probe's run() never acks delivery, so there is no consumed one here)
    // — carries the ref and never the bytes.
    expect(queued().length).toBeGreaterThanOrEqual(1)
    for (const payload of queued()) {
      expect(payload).not.toContain(UPLOAD.base64Data)
      expect(payload).toContain(blobRefOf(UPLOAD.base64Data).blobId)
    }
  })
})
