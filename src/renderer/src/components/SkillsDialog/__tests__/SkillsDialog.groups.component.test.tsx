/**
 * Layer 2: what the Skills dialog shows for a session's catalog list, desktop and
 * mobile: groups in source order, legacy commands marked, invocation flags shown as
 * such, and the Claude-only note on entries a non-Claude engine does not fully apply.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { SkillsDialog } from '../SkillsDialog'
import type { SkillInfo } from '../../../../../shared/types'

const originalMatchMedia = window.matchMedia
const originalInnerWidth = window.innerWidth

function setViewportIsMobile(isMobile: boolean): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: isMobile ? 390 : 1280
  })
  window.matchMedia = ((query: string) => ({
    matches: isMobile && query.includes('max-width: 768px'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
}

function skill(name: string, overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    name,
    description: `${name} description`,
    source: 'project',
    path: `/repo/.claude/skills/${name}/SKILL.md`,
    content: `# ${name}`,
    ...overrides
  }
}

// Deliberately out of display order: the dialog must group, not trust arrival order.
const LIST: SkillInfo[] = [
  skill('eng-own', { source: 'engine', path: '' }),
  skill('plug:s', { source: 'plugin', pluginName: 'plug' }),
  skill('mine', { source: 'user', kind: 'command', userInvocable: true }),
  skill('proj', { source: 'project', claudeOnly: ['context', 'allowed-tools'] }),
  skill('policy', { source: 'managed', userInvocable: false }),
  skill('quiet', { source: 'project', modelInvocable: false })
]

let app: TestApp

beforeEach(async () => {
  app = await bootTestApp()
  app.bridge.ipcMain.handle('config:load-skill-details', async () => LIST)
})

afterEach(() => {
  cleanup()
  app.teardown()
  window.matchMedia = originalMatchMedia
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: originalInnerWidth
  })
})

async function renderDialog(): Promise<void> {
  await act(async () => {
    render(<SkillsDialog open cwd="/repo" routingId="route-1" onClose={vi.fn()} />)
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

function tagsOf(row: HTMLElement, testId: string): string[] {
  return within(row)
    .queryAllByTestId(testId)
    .map((t) => t.dataset.id!)
}

describe('SkillsDialog groups (desktop)', () => {
  beforeEach(() => setViewportIsMobile(false))

  it('lists rows grouped managed, project, user, plugin, engine', async () => {
    await renderDialog()

    const rows = screen.getAllByTestId('SkillsDialog.skillRow').map((r) => r.dataset.id)
    expect(rows).toEqual(['policy', 'proj', 'quiet', 'mine', 'plug:s', 'eng-own'])
  })

  it('marks commands and shows the invocation flags as such', async () => {
    await renderDialog()
    const row = (id: string): HTMLElement =>
      screen.getAllByTestId('SkillsDialog.skillRow').find((r) => r.dataset.id === id)!

    expect(tagsOf(row('mine'), 'SkillsDialog.tag')).toEqual(['command'])
    expect(tagsOf(row('policy'), 'SkillsDialog.tag')).toEqual(['not-user-invocable'])
    expect(tagsOf(row('quiet'), 'SkillsDialog.tag')).toEqual(['not-model-invocable'])
    expect(tagsOf(row('proj'), 'SkillsDialog.tag')).toEqual([])
  })

  it('shows the Claude-only note for an entry that carries claudeOnly, and only then', async () => {
    await renderDialog()
    const pick = async (id: string): Promise<void> => {
      await act(async () => {
        fireEvent.click(
          screen.getAllByTestId('SkillsDialog.skillRow').find((r) => r.dataset.id === id)!
        )
      })
    }

    await pick('proj')
    expect(screen.getByTestId('SkillsDialog.claudeOnlyNote').textContent).toContain(
      'context, allowed-tools'
    )

    await pick('mine')
    expect(screen.queryByTestId('SkillsDialog.claudeOnlyNote')).toBeNull()
  })
})

describe('SkillsDialog groups (mobile)', () => {
  beforeEach(() => setViewportIsMobile(true))

  it('lists rows in the same group order, with the same tags', async () => {
    await renderDialog()

    const rows = screen.getAllByTestId('SkillsMobileView.row')
    expect(rows.map((r) => r.dataset.id)).toEqual([
      'policy',
      'proj',
      'quiet',
      'mine',
      'plug:s',
      'eng-own'
    ])
    const row = (id: string): HTMLElement => rows.find((r) => r.dataset.id === id)!
    expect(tagsOf(row('mine'), 'SkillsMobileView.tag')).toEqual(['command'])
    expect(tagsOf(row('policy'), 'SkillsMobileView.tag')).toEqual(['not-user-invocable'])
    expect(tagsOf(row('quiet'), 'SkillsMobileView.tag')).toEqual(['not-model-invocable'])
  })

  it('the detail screen carries the Claude-only note', async () => {
    await renderDialog()

    await act(async () => {
      fireEvent.click(
        screen.getAllByTestId('SkillsMobileView.row').find((r) => r.dataset.id === 'proj')!
      )
    })

    expect(screen.getByTestId('SkillsMobileView.claudeOnlyNote').textContent).toContain(
      'context, allowed-tools'
    )
  })
})
