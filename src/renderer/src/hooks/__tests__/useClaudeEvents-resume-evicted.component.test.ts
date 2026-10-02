import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
vi.mock('electron', async () => import('@test/stubs/electron-shim'))

import { createElement } from 'react'
import { render, cleanup } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useClaudeEvents } from '../useClaudeEvents'
import { useSessionStore, markViewEvicted } from '../../stores/session-store'
import { evictLocalSessions, patchLocalSession } from '../../stores/replica'
import { emitSync } from '@test/helpers/replica-seed'
import { makeAssistantMessage } from '@test/factories/messages'
import type { ChatMessage } from '../../../../shared/types'

/**
 * A resident entry is not always one WITH a transcript (ADR-087 §2): a snapshot
 * that did not carry it leaves an empty, evicted entry. When another client then
 * resumes that session, THIS client needs the resumed history exactly as a
 * follower that had never seen the session does — the host's own seed is not an
 * event, so nothing else will bring it. A resident entry that holds its
 * transcript (the originator of the resume) must keep doing nothing.
 */

let app: TestApp
const loadSessionHistory = vi.fn()

const texts = (messages: ChatMessage[]): string[] =>
  messages.map((m) => m.content.map((b) => (b.type === 'text' ? b.text : '')).join(''))

function EventHarness(): null {
  useClaudeEvents()
  return null
}

const LISTED = [
  {
    cwd: '/p',
    projectKey: '-p',
    folderName: 'p',
    sessions: [
      {
        sessionId: 'gone',
        cwd: '/p',
        projectKey: '-p',
        title: 'gone',
        timestamp: 1,
        lastActivityAt: 1
      }
    ]
  }
]

beforeEach(async () => {
  app = await bootTestApp()
  loadSessionHistory.mockReset()
  Object.assign(window.api, { loadSessionHistory })
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: LISTED,
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {},
    worktreeInfoMap: {}
  })
  render(createElement(EventHarness))
})

afterEach(() => {
  cleanup()
  app.teardown()
})

function residentEntry(withTranscript: boolean): void {
  patchLocalSession(
    'gone',
    { cwd: '/p', messages: [makeAssistantMessage('held')] },
    { create: true }
  )
  if (!withTranscript) {
    markViewEvicted(['gone'])
    evictLocalSessions(['gone'])
  }
}

describe('session:created for a resident entry', () => {
  it('an EVICTED resident entry loads the resumed history and stops being evicted', async () => {
    residentEntry(false)
    loadSessionHistory.mockResolvedValue({
      messages: [makeAssistantMessage('from-disk')],
      taskNotifications: [],
      customTitle: null,
      statusLine: null,
      warnings: []
    })

    emitSync('session:created', ['gone', { cwd: '/p', resumeSessionId: 'gone' }])

    await vi.waitFor(() =>
      expect(useSessionStore.getState().sessions['gone'].messages).toHaveLength(1)
    )
    const session = useSessionStore.getState().sessions['gone']
    expect(loadSessionHistory).toHaveBeenCalledWith('gone', '-p', undefined)
    expect(texts(session.messages)).toEqual(['from-disk'])
    expect(session.sdkActive).toBe(true)
    expect(session.evicted).toBe(false)
    expect(session.isHistorical).toBe(false)
    // Already registered: it must not re-announce itself or yank the selection.
    expect(useSessionStore.getState().recentSessionIds).toEqual([])
    expect(useSessionStore.getState().activeSessionId).toBeNull()
  })

  it('a resident entry that HOLDS its transcript (the originator) loads nothing', async () => {
    residentEntry(true)

    emitSync('session:created', ['gone', { cwd: '/p', resumeSessionId: 'gone' }])
    await Promise.resolve()

    expect(loadSessionHistory).not.toHaveBeenCalled()
    expect(texts(useSessionStore.getState().sessions['gone'].messages)).toEqual(['held'])
  })

  it('a session this client had never seen is still registered and loaded', async () => {
    loadSessionHistory.mockResolvedValue({
      messages: [makeAssistantMessage('from-disk')],
      taskNotifications: [],
      customTitle: null,
      statusLine: null,
      warnings: []
    })

    emitSync('session:created', ['gone', { cwd: '/p', resumeSessionId: 'gone' }])

    await vi.waitFor(() => expect(loadSessionHistory).toHaveBeenCalled())
    expect(useSessionStore.getState().recentSessionIds).toContain('gone')
  })
})
