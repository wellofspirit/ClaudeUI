/**
 * @vitest-environment node
 *
 * **The snapshot-size guard** (ADR-087 §1) — the regression test for a
 * `sync-full` that was ~273 MB for one screenshot-heavy session.
 *
 * Images used to ride inline as base64 on `tool_result.images`, on subagent tool
 * results and on `session:user-message` attachments. All of it was ringed and
 * folded into canonical state, so every snapshot carried it: the 5000-entry ring
 * bounds catchup by entry COUNT, and a snapshot is all of canonical state.
 *
 * This drives the REAL pieces end to end — the shared tool-result decoder every
 * producer goes through, `sendPrompt`'s interning, the process-wide `SyncCore`
 * and its real reducer — with ~1 MiB images, then measures what a reconnecting
 * client would actually be sent: the full snapshot, and the ring's catchup.
 * Nothing here knows about blobs; it would fail on any change that put an
 * image's bytes back on either lane.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatMessage } from '../../../shared/types'
import { extractToolResultContent } from '../../services/tool-result-content'
import { syncCore, emitEvent } from '../../services/sync-host'
import { sendPrompt, getBlob } from '../../ipc/handlers-core'
import type { SessionManager } from '../../services/session-manager'

vi.mock('../../services/skill-scanner', () => ({ scanSkills: vi.fn(async () => []) }))
vi.mock('../../services/claude-settings', () => ({ saveCleanupPeriodDays: vi.fn() }))
vi.mock('../../services/ui-config', () => ({
  saveSessionConfig: vi.fn(),
  loadEngineConfig: vi.fn(() => ({}))
}))

const ROUTING_ID = 'rid-blob-size'
const ONE_MIB = 1024 * 1024
const BUDGET = 16 * 1024

/** `n` bytes of incompressible-looking filler, distinct per seed. */
function imageBytes(seed: number): Buffer {
  const bytes = Buffer.alloc(ONE_MIB)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 131 + seed * 17 + (i >> 8)) & 0xff
  return bytes
}

function toolResultContent(seed: number): unknown[] {
  return [
    { type: 'text', text: 'screenshot taken' },
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: imageBytes(seed).toString('base64')
      }
    }
  ]
}

function assistantWithToolUse(id: string, toolUseId: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: [
      { type: 'tool_use', toolUseId, toolName: 'Read', toolInput: { file_path: '/a.png' } }
    ],
    timestamp: 1
  }
}

function sessionStub(): { willQueue: boolean; engineId: string; run: ReturnType<typeof vi.fn> } {
  return { willQueue: false, engineId: 'claude', run: vi.fn() }
}

describe('sync lanes carry no image bytes', () => {
  beforeEach(() => {
    syncCore.resetCanonicalForTests()
  })

  it('a session full of ~1 MiB images costs a few KiB of snapshot and of catchup', () => {
    const startSeq = syncCore.currentSeq()
    const upload = {
      mediaType: 'image/png',
      base64Data: imageBytes(3).toString('base64'),
      fileName: 'pasted.png'
    }
    const session = sessionStub()
    const manager = { get: () => session } as unknown as SessionManager

    emitEvent('session:created', [ROUTING_ID, { cwd: '/repo' }])

    // A main-lane tool result, produced by the real decoder.
    emitEvent('session:message', [ROUTING_ID, assistantWithToolUse('a1', 'tu-1')])
    const main = extractToolResultContent(toolResultContent(1))
    emitEvent('session:tool-result', [
      ROUTING_ID,
      { toolUseId: 'tu-1', result: main.text, isError: false, images: main.images }
    ])

    // A subagent's tool result, the lane the measured session was fattest on.
    emitEvent('session:subagent-message', [
      ROUTING_ID,
      { toolUseId: 'sub-1', message: assistantWithToolUse('s1', 'stu-1') }
    ])
    const sub = extractToolResultContent(toolResultContent(2))
    emitEvent('session:subagent-tool-result', [
      ROUTING_ID,
      {
        toolUseId: 'sub-1',
        toolResultToolUseId: 'stu-1',
        result: sub.text,
        isError: false,
        images: sub.images
      }
    ])

    // A pasted attachment, through the real `sendPrompt` interning.
    sendPrompt(manager, ROUTING_ID, 'look at this', [upload])

    // The test is only meaningful if the images really reached canonical state.
    const canonical = syncCore.getCanonicalState().sessions[ROUTING_ID]
    const blocks = canonical.messages.flatMap((m) => m.content)
    expect(blocks.some((b) => b.type === 'tool_result' && b.images?.length === 1)).toBe(true)
    expect(blocks.some((b) => b.type === 'image')).toBe(true)
    expect(
      canonical.subagentMessages['sub-1']
        .flatMap((m) => m.content)
        .some((b) => b.type === 'tool_result' && b.images?.length === 1)
    ).toBe(true)
    // …and the engine still got the real upload (it needs the bytes).
    expect(session.run).toHaveBeenCalledWith('look at this', [upload])

    const snapshot = JSON.stringify(syncCore.getSnapshot()).length
    const ring = syncCore.getAfter(startSeq)
    expect(ring).not.toBeNull()
    const catchup = JSON.stringify(ring).length

    expect(snapshot, `snapshot was ${snapshot} bytes`).toBeLessThan(BUDGET)
    expect(catchup, `ring catchup was ${catchup} bytes`).toBeLessThan(BUDGET)
  })

  it('the refs in canonical state fetch the exact bytes back through blob:get', () => {
    const bytes = imageBytes(9)
    const decoded = extractToolResultContent([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') }
      }
    ])

    const fetched = getBlob(decoded.images![0].blobId)

    expect(fetched?.mediaType).toBe('image/png')
    expect(Buffer.from(fetched!.base64Data, 'base64').equals(bytes)).toBe(true)
  })
})
