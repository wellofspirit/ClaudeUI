/**
 * WS8 guard tests for session-store: engine identity on local historical
 * load + fork (gpt#3), inactive-transcript eviction + re-hydration (Opus B),
 * rekey boundary resolution (xhigh#9), per-message thinking duration, and
 * per-session draft attachments (gpt#14).
 *
 * Pure store-level tests — drive actions via useSessionStore.getState().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useSessionStore, resolveRoutingId } from '../session-store'
import { makeChatMessage } from '@test/factories/messages'
import type { ChatMessage, FileAttachment, DirectoryGroup } from '../../../../shared/types'

const store = (): ReturnType<typeof useSessionStore.getState> => useSessionStore.getState()

function att(id: string): FileAttachment {
  return {
    id,
    fileName: `${id}.png`,
    fileType: 'image',
    mediaType: 'image/png',
    base64Data: 'AAAA',
    previewUrl: 'data:image/png;base64,AAAA'
  }
}

function onDisk(sessionId: string, cwd = '/p'): DirectoryGroup[] {
  return [
    {
      cwd,
      projectKey: 'pk',
      folderName: 'p',
      sessions: [
        { sessionId, cwd, projectKey: 'pk', title: 't', timestamp: 0, lastActivityAt: 0 }
      ]
    }
  ]
}

beforeEach(() => {
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = {
    saveSessionConfig: vi.fn(),
    saveSettings: vi.fn(),
    saveSlashCommands: vi.fn(),
    logError: vi.fn(),
    resolveForkAnchor: vi.fn()
  } as any

  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {},
    worktreeInfoMap: {},
    hiddenSessionIds: [],
    hiddenProjectKeys: [],
    sessionEngines: {},
    availableModels: [],
    terminalGroups: {},
    activeView: { type: 'chat' }
  })
})

// ---------------------------------------------------------------------------
// Engine identity on LOCAL historical load (gpt#3)
// ---------------------------------------------------------------------------

describe('loadHistoricalSession — engine identity (gpt#3)', () => {
  it('restores status.engineId from the persisted engine, not Claude defaults', () => {
    useSessionStore.setState({
      sessionEngines: {
        s1: { engineId: 'pi', model: { engineId: 'pi', vendorId: 'openai-codex', modelId: 'x' } }
      }
    })
    store().loadHistoricalSession('s1', [], '/p')
    const sess = store().sessions['s1']
    // Pre-fix, status.engineId stayed 'claude' while only selectedEngineId flipped.
    expect(sess.selectedEngineId).toBe('pi')
    expect(sess.status.engineId).toBe('pi')
  })

  it('seeds capabilities for the restored engine (opencode ≠ Claude default caps)', () => {
    useSessionStore.setState({
      sessionEngines: {
        s2: {
          engineId: 'opencode',
          model: { engineId: 'opencode', vendorId: 'anthropic', modelId: 'claude' }
        }
      }
    })
    store().loadHistoricalSession('s2', [], '/p')
    const caps = store().sessions['s2'].status.capabilities
    // opencode does not support Claude-only fork-from-message; Claude default does.
    expect(caps.forkFromMessage).toBe(false)
  })

  it('claude sessions still load as claude (no regression)', () => {
    store().loadHistoricalSession('s3', [], '/p')
    expect(store().sessions['s3'].status.engineId).toBe('claude')
    expect(store().sessions['s3'].selectedEngineId).toBe('claude')
  })
})

// ---------------------------------------------------------------------------
// Engine identity on fork (gpt#3)
// ---------------------------------------------------------------------------

describe('forkFromMessage — engine identity (gpt#3)', () => {
  it('inherits the source engine into status + sessionEngines (no Claude fallback)', async () => {
    // Build a pi source session that supports fork-from-message.
    store().createNewSession('src', '/p')
    store().addMessage('src', makeChatMessage({ id: 'm1', role: 'assistant' }))
    useSessionStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        src: {
          ...s.sessions['src'],
          selectedEngineId: 'pi',
          selectedModel: 'openai-codex/gpt',
          status: {
            ...s.sessions['src'].status,
            engineId: 'pi',
            capabilities: { ...s.sessions['src'].status.capabilities, forkFromMessage: true }
          }
        }
      }
    }))
    ;(window.api.resolveForkAnchor as any).mockResolvedValue({ anchorUuid: 'anchor-1' })

    const newId = await store().forkFromMessage('src', 'm1')
    expect(newId).toBeTruthy()
    const forked = store().sessions[newId!]
    // Pre-fix, the fork used createEmptySession defaults → selectedEngineId 'claude'.
    expect(forked.selectedEngineId).toBe('pi')
    expect(forked.status.engineId).toBe('pi')
    expect(store().sessionEngines[newId!]?.engineId).toBe('pi')
  })
})

// ---------------------------------------------------------------------------
// Eviction + re-hydration (Opus B)
// ---------------------------------------------------------------------------

describe('evict cold sessions on switch, re-hydrate on reselect (Opus B)', () => {
  function seedColdAndActive(): void {
    store().createNewSession('cold', '/p')
    store().addMessage('cold', makeChatMessage({ id: 'c1', content: [{ type: 'text', text: 'hi' }] }))
    store().createNewSession('active', '/p')
    store().addMessage('active', makeChatMessage({ id: 'a1' }))
    // Keep 'cold' out of the last-N recent set, on disk, with an unsent draft.
    useSessionStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        cold: { ...s.sessions['cold'], draftText: 'keep me', effort: 'high' }
      },
      directories: onDisk('cold'),
      recentSessionIds: ['active'],
      activeSessionId: 'active'
    }))
  }

  it('evicts a cold on-disk session heavy arrays but preserves the lightweight entry', () => {
    seedColdAndActive()
    store().switchSession('active')

    const cold = store().sessions['cold']
    expect(cold.evicted).toBe(true)
    expect(cold.messages).toHaveLength(0)
    // Lightweight fields survive eviction.
    expect(cold.draftText).toBe('keep me')
    expect(cold.effort).toBe('high')
    // The active session is never evicted.
    expect(store().sessions['active'].evicted).toBe(false)
    expect(store().sessions['active'].messages.length).toBeGreaterThan(0)
  })

  it('re-hydration restores messages and preserves the preserved draft', () => {
    seedColdAndActive()
    store().switchSession('active')
    expect(store().sessions['cold'].evicted).toBe(true)

    // Reselect → Sidebar's disk-load path calls loadHistoricalSession.
    store().loadHistoricalSession('cold', [makeChatMessage({ id: 'c1' })], '/p')
    const cold = store().sessions['cold']
    expect(cold.evicted).toBe(false)
    expect(cold.messages).toHaveLength(1)
    expect(cold.draftText).toBe('keep me')
  })

  it('never evicts a session that is not on disk (not reloadable)', () => {
    store().createNewSession('fresh', '/p')
    store().addMessage('fresh', makeChatMessage({ id: 'f1' }))
    store().createNewSession('active', '/p')
    store().addMessage('active', makeChatMessage({ id: 'a1' }))
    useSessionStore.setState({ directories: [], recentSessionIds: ['active'], activeSessionId: 'active' })

    store().switchSession('active')
    // 'fresh' has no on-disk transcript → must keep its messages.
    expect(store().sessions['fresh'].evicted).toBe(false)
    expect(store().sessions['fresh'].messages).toHaveLength(1)
  })

  it('never evicts a running (sdkActive) or watched session', () => {
    store().createNewSession('running', '/p')
    store().addMessage('running', makeChatMessage({ id: 'r1' }))
    store().markSdkActive('running')
    store().createNewSession('active', '/p')
    store().addMessage('active', makeChatMessage({ id: 'a1' }))
    useSessionStore.setState({
      directories: onDisk('running'),
      recentSessionIds: ['active'],
      activeSessionId: 'active'
    })

    store().switchSession('active')
    expect(store().sessions['running'].evicted).toBe(false)
    expect(store().sessions['running'].messages).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Rekey boundary resolution (xhigh#9)
// ---------------------------------------------------------------------------

describe('resolveRoutingId — rekey boundary (xhigh#9)', () => {
  it('maps a stale pre-rekey id to the canonical session id', () => {
    store().createNewSession('old', '/p')
    store().rekeySession('old', 'new')
    expect(resolveRoutingId('old')).toBe('new')
    // A never-mapped id resolves to itself.
    expect(resolveRoutingId('new')).toBe('new')
    expect(resolveRoutingId('unrelated')).toBe('unrelated')
  })

  it('a late event resolved at the boundary lands on the new session, no ghost', () => {
    store().createNewSession('old', '/p')
    store().rekeySession('old', 'new')
    // Simulate a main-process event still carrying the OLD id, resolved at boundary.
    store().addMessage(resolveRoutingId('old'), makeChatMessage({ id: 'late' }))
    expect(store().sessions['new'].messages.some((m) => m.id === 'late')).toBe(true)
    // No split-brain ghost session created under the stale id.
    expect(store().sessions['old']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Per-message thinking duration
// ---------------------------------------------------------------------------

describe('thinking duration is recorded per message block', () => {
  afterEach(() => vi.restoreAllMocks())

  function thinkingMsg(id: string): ChatMessage {
    return {
      id,
      role: 'assistant',
      content: [
        { type: 'thinking', text: 't' },
        { type: 'text', text: 'answer' }
      ],
      timestamp: Date.now()
    }
  }

  it('stamps each block with its OWN duration (streamed seal path)', () => {
    const now = vi.spyOn(Date, 'now')
    store().createNewSession('s', '/p')

    now.mockReturnValue(1000)
    store().appendStreamingThinking('s', 'thinking...')
    now.mockReturnValue(1500)
    store().appendStreamingText('s', 'answer') // seals span → parks 500ms
    now.mockReturnValue(1600)
    store().addMessage('s', thinkingMsg('a1')) // consumes parked 500ms

    now.mockReturnValue(2000)
    store().appendStreamingThinking('s', 'more')
    now.mockReturnValue(3200)
    store().appendStreamingText('s', 'answer2') // seals span → parks 1200ms
    now.mockReturnValue(3300)
    store().addMessage('s', thinkingMsg('a2'))

    const blockDuration = (id: string): number | undefined => {
      const b = store()
        .sessions['s'].messages.find((m) => m.id === id)!
        .content.find((c) => c.type === 'thinking')
      return b?.type === 'thinking' ? b.durationMs : undefined
    }
    expect(blockDuration('a1')).toBe(500)
    expect(blockDuration('a2')).toBe(1200)
  })

  it('stamps the block when the span seals inside addMessage (all-in-one)', () => {
    const now = vi.spyOn(Date, 'now')
    store().createNewSession('s', '/p')

    now.mockReturnValue(5000)
    store().appendStreamingThinking('s', 't')
    now.mockReturnValue(5800)
    store().addMessage('s', thinkingMsg('a3')) // seals here (thinkingStartedAt still set)

    const b = store()
      .sessions['s'].messages.find((m) => m.id === 'a3')!
      .content.find((c) => c.type === 'thinking')
    expect(b?.type === 'thinking' ? b.durationMs : undefined).toBe(800)
  })
})

// ---------------------------------------------------------------------------
// Per-session draft attachments (gpt#14)
// ---------------------------------------------------------------------------

describe('draft attachments are keyed per session (gpt#14)', () => {
  it('addDraftAttachments targets the given session only', () => {
    store().createNewSession('A', '/p')
    store().createNewSession('B', '/p')
    store().addDraftAttachments('A', [att('x')])
    expect(store().sessions['A'].draftAttachments).toHaveLength(1)
    expect(store().sessions['B'].draftAttachments).toHaveLength(0)
  })

  it('removeDraftAttachment removes by id; setDraftAttachments replaces', () => {
    store().createNewSession('A', '/p')
    store().addDraftAttachments('A', [att('x'), att('y')])
    store().removeDraftAttachment('A', 'x')
    expect(store().sessions['A'].draftAttachments.map((a) => a.id)).toEqual(['y'])
    store().setDraftAttachments('A', [])
    expect(store().sessions['A'].draftAttachments).toHaveLength(0)
  })

  it('does not throw for an unknown session id', () => {
    expect(() => store().addDraftAttachments('nope', [att('x')])).not.toThrow()
    expect(store().sessions['nope']).toBeUndefined()
  })
})
