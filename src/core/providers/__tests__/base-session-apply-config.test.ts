/**
 * @vitest-environment node
 *
 * `BaseSession.applyConfig`: the one live entry for a session's config, over the engine's
 * `liveConfig` table. The order is fixed (a model change clears opencode's variant, so the
 * variant must follow it), absent fields are skipped, `null` is a value for the variant.
 */

import { describe, it, expect, vi } from 'vitest'
import type { AttachmentUpload, EngineId } from '../../../shared/types'
import type { ResolvedCapabilities } from '../../../shared/model-capabilities'

vi.mock('../../services/sync-host', () => ({
  emitEvent: vi.fn(),
  addExtraSink: vi.fn(),
  removeExtraSink: vi.fn(),
  extraSinks: () => new Set()
}))
vi.mock('../../services/db', () => ({ dispatchedCostsByRouting: () => [] }))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { BaseSession } from '../BaseSession'

type Table = BaseSession['liveConfig']

class ProbeSession extends BaseSession {
  readonly engineId: EngineId = 'pi'
  readonly capabilities = {} as ResolvedCapabilities
  readonly willQueue = false
  constructor(protected readonly liveConfig: Table) {
    super('rid', null, '/tmp')
  }
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
  dispose(): void {}
}

function table(calls: unknown[][], over: Partial<Table> = {}): Table {
  const rec =
    (name: string) =>
    (v: unknown): void => {
      calls.push([name, v])
    }
  return {
    model: rec('model'),
    permissionMode: rec('permissionMode'),
    effort: rec('effort'),
    thinkingMode: rec('thinkingMode'),
    reasoningVariant: rec('reasoningVariant'),
    ...over
  } as Table
}

describe('BaseSession.applyConfig', () => {
  it('delivers each field to its handler, in the fixed order whatever the patch key order', async () => {
    const calls: unknown[][] = []
    await new ProbeSession(table(calls)).applyConfig({
      reasoningVariant: 'high',
      thinkingMode: 'enabled',
      effort: 'low',
      permissionMode: 'plan',
      model: 'm'
    })
    expect(calls).toEqual([
      ['model', 'm'],
      ['permissionMode', 'plan'],
      ['effort', 'low'],
      ['thinkingMode', 'enabled'],
      ['reasoningVariant', 'high']
    ])
  })

  it('skips undefined, delivers a null variant, and skips a null handler', async () => {
    const calls: unknown[][] = []
    const s = new ProbeSession(table(calls, { effort: null }))
    await s.applyConfig({ model: undefined, effort: 'low', reasoningVariant: null })
    expect(calls).toEqual([['reasoningVariant', null]])
  })

  it('rejects when a handler rejects, and stops there', async () => {
    const calls: unknown[][] = []
    const s = new ProbeSession(
      table(calls, {
        model: async () => {
          throw new Error('boom')
        }
      })
    )
    await expect(s.applyConfig({ model: 'm', permissionMode: 'plan' })).rejects.toThrow('boom')
    expect(calls).toEqual([])
  })
})
