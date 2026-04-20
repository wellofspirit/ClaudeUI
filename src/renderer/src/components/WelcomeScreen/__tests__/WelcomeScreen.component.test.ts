/**
 * Layer 2: Component tests for WelcomeScreen FC.
 *
 * Tested flows:
 *   1. onOpen → pickFolder IPC, then createNewSession on success
 *   2. onOpen cancelled (user dismisses dialog) → no session created
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import type { WelcomeScreenViewProps } from '../View'

let viewProps: WelcomeScreenViewProps
vi.mock('../View', () => ({
  WelcomeScreenView: (props: WelcomeScreenViewProps) => {
    viewProps = props
    return null
  },
}))

describe('WelcomeScreen FC', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.setState({ activeSessionId: null, sessions: {}, recentSessionIds: [] })
  })

  afterEach(() => {
    app.teardown()
  })

  async function renderFC(): Promise<void> {
    const { WelcomeScreen } = await import('../WelcomeScreen')
    await act(async () => {
      render(React.createElement(WelcomeScreen))
    })
  }

  it('picks a folder and creates a session', async () => {
    app.bridge.ipcMain.handle('session:pick-folder', async () => '/d/new-project')

    await renderFC()

    await act(async () => { await viewProps.onOpen() })

    const sessions = Object.values(useSessionStore.getState().sessions)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].cwd).toBe('/d/new-project')
  })

  it('does nothing when the user cancels the folder picker', async () => {
    app.bridge.ipcMain.handle('session:pick-folder', async () => null)

    await renderFC()

    await act(async () => { await viewProps.onOpen() })

    expect(Object.values(useSessionStore.getState().sessions)).toHaveLength(0)
  })

  it('toggles loading around pickFolder', async () => {
    let resolve!: (v: string | null) => void
    app.bridge.ipcMain.handle('session:pick-folder', () => new Promise((r) => { resolve = r }))

    await renderFC()

    const p = viewProps.onOpen() as unknown as Promise<void>
    // The FC calls setLoading(true) before awaiting pickFolder
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(viewProps.loading).toBe(true)

    await act(async () => { resolve(null); await p })
    expect(viewProps.loading).toBe(false)
  })
})
