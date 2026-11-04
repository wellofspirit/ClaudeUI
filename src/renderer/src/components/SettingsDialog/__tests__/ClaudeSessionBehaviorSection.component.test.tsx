/**
 * Layer 2: Engines › Claude Code › Session behaviour — the two cli.js
 * behaviours ClaudeUI owns a switch for, rendered through the `claude-session`
 * section's one item.
 *
 * What is guarded here:
 *
 *  - the defaults are ClaudeUI's, not cli.js's: idle compaction OFF (absent
 *    means off) and the email-address privacy check ON (absent means on), even
 *    though cli.js itself defaults compaction to on;
 *  - each toggle writes `claudeConfig` through the engine-config save path and
 *    KEEPS the other keys (`defaultModel` above all), because
 *    `saveEngineConfig` replaces the whole file;
 *  - switching a row back to its default DELETES its key rather than writing
 *    the default out.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SECTIONS } from '../settings-sections'
import { SECTION_TARGET } from '../settings-pages'
import type { AppSettings } from '../../../stores/session-store'
import type { EngineConfig } from '../../../../../shared/types'

afterEach(cleanup)

const T = 'ClaudeSessionBehaviorSection'

function renderSection(engineConfig: EngineConfig = {}): {
  updateEngineConfig: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
} {
  const update = vi.fn()
  const updateEngineConfig = vi.fn()
  const section = SECTIONS.find((s) => s.id === 'claude-session')!
  expect(section.items.map((i) => i.key)).toEqual(['claudeSessionBehavior'])
  render(
    section.items[0].render(
      {} as AppSettings,
      update as never,
      engineConfig,
      updateEngineConfig as never,
      {} as never,
      () => {}
    )
  )
  return { updateEngineConfig, update }
}

const toggle = (key: 'idleCompaction' | 'privacyEmailCheck'): HTMLElement =>
  screen.getByTestId(`${T}.${key}`)

describe('Engines › Claude Code › Session behaviour', () => {
  it('is filed under the Claude page, in the Session behaviour group', () => {
    expect(SECTION_TARGET['claude-session']).toEqual({ page: 'claude', group: 'session' })
  })

  it('shows ClaudeUI defaults: compaction OFF, email check ON, with the hints', () => {
    renderSection()
    expect(toggle('idleCompaction')).toHaveAttribute('aria-pressed', 'false')
    expect(toggle('privacyEmailCheck')).toHaveAttribute('aria-pressed', 'true')
    expect(toggle('idleCompaction').textContent).toContain('Compact idle conversations')
    expect(toggle('idleCompaction').textContent).toContain(
      'Claude Code summarises a long conversation (200K+ tokens) left idle. Off keeps the full history. Applies to sessions started after the change.'
    )
    expect(toggle('privacyEmailCheck').textContent).toContain(
      'Ask before sending your email address'
    )
    expect(toggle('privacyEmailCheck').textContent).toContain(
      'Claude Code asks before a web or shell call that would send your account email address off this machine. Applies to sessions started after the change.'
    )
  })

  it('renders saved values when the engine config has them', () => {
    renderSection({ claudeConfig: { idleCompaction: true, privacyEmailCheck: false } })
    expect(toggle('idleCompaction')).toHaveAttribute('aria-pressed', 'true')
    expect(toggle('privacyEmailCheck')).toHaveAttribute('aria-pressed', 'false')
  })

  it('turning compaction ON writes it and keeps defaultModel', () => {
    const { updateEngineConfig } = renderSection({ claudeConfig: { defaultModel: 'sonnet' } })
    fireEvent.click(toggle('idleCompaction'))
    expect(updateEngineConfig).toHaveBeenCalledWith({
      claudeConfig: { defaultModel: 'sonnet', idleCompaction: true }
    })
  })

  it('turning the email check OFF writes it and keeps defaultModel', () => {
    const { updateEngineConfig } = renderSection({ claudeConfig: { defaultModel: 'sonnet' } })
    fireEvent.click(toggle('privacyEmailCheck'))
    expect(updateEngineConfig).toHaveBeenCalledWith({
      claudeConfig: { defaultModel: 'sonnet', privacyEmailCheck: false }
    })
  })

  it('switching a row back to its default DELETES the key instead of writing it', () => {
    const { updateEngineConfig } = renderSection({
      claudeConfig: { defaultModel: 'opus', idleCompaction: true, privacyEmailCheck: false }
    })
    fireEvent.click(toggle('idleCompaction'))
    expect(updateEngineConfig).toHaveBeenLastCalledWith({
      claudeConfig: { defaultModel: 'opus', privacyEmailCheck: false }
    })
    fireEvent.click(toggle('privacyEmailCheck'))
    expect(updateEngineConfig).toHaveBeenLastCalledWith({
      claudeConfig: { defaultModel: 'opus', idleCompaction: true }
    })
  })

  it('writes claudeConfig only — never another engine’s block', () => {
    const { updateEngineConfig } = renderSection({ dispatch: { defaultModel: 'haiku' } })
    fireEvent.click(toggle('idleCompaction'))
    const [patch] = updateEngineConfig.mock.calls[0] as [Record<string, unknown>]
    expect(Object.keys(patch)).toEqual(['claudeConfig'])
  })
})
