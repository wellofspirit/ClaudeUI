/**
 * Layer 2: Engines › Claude Code › Session behaviour — the three cli.js
 * behaviours ClaudeUI owns a switch for, rendered through the `claude-session`
 * section's one item.
 *
 * What is guarded here:
 *
 *  - the defaults are ClaudeUI's, not cli.js's: idle compaction OFF (absent
 *    means off), the email-address privacy check ON and Stop keeping background
 *    agents running ON (absent means on), even though cli.js itself defaults
 *    compaction to on and kills background agents on an interrupt;
 *  - each toggle writes `claudeConfig` through the engine-config save path and
 *    KEEPS the other keys (`defaultModel` above all), because
 *    `saveEngineConfig` replaces the whole file;
 *  - switching a row back to its default DELETES its key rather than writing
 *    the default out, and Reset (shown only while the key is present) does the
 *    same.
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

type Key = 'idleCompaction' | 'privacyEmailCheck' | 'stopKeepsBackgroundAgents'

const toggle = (key: Key): HTMLElement => screen.getByTestId(`${T}.${key}`)

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
      'Claude Code asks before a shell, web, file-write or MCP call that would send your account email address off this machine or use it as a client identity. Applies to sessions started after the change.'
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

  it('shows Stop keeps background agents running ON by default, with the hint and key', () => {
    renderSection()
    const row = toggle('stopKeepsBackgroundAgents')
    expect(row).toHaveAttribute('aria-pressed', 'true')
    expect(row.textContent).toContain('Stop keeps background agents running')
    expect(row.textContent).toContain(
      "Stop and Esc end only the current turn. Agents running in the background keep going, and each keeps its own Stop on its card and in the Tasks panel. Off: Stop also stops every running background agent (Claude Code's default). Applies to sessions started after the change."
    )
    expect(row.textContent).toContain(
      'engines/claude.json · claudeConfig.stopKeepsBackgroundAgents'
    )
    // Default: nothing to reset.
    expect(screen.queryByTestId(`${T}.stopKeepsBackgroundAgents.reset`)).toBeNull()
  })

  it('renders it OFF when the engine config says false', () => {
    renderSection({ claudeConfig: { stopKeepsBackgroundAgents: false } })
    expect(toggle('stopKeepsBackgroundAgents')).toHaveAttribute('aria-pressed', 'false')
  })

  it('turning it OFF writes false and keeps the other keys', () => {
    const { updateEngineConfig } = renderSection({
      claudeConfig: { defaultModel: 'sonnet', idleCompaction: true }
    })
    fireEvent.click(toggle('stopKeepsBackgroundAgents'))
    expect(updateEngineConfig).toHaveBeenCalledWith({
      claudeConfig: {
        defaultModel: 'sonnet',
        idleCompaction: true,
        stopKeepsBackgroundAgents: false
      }
    })
  })

  it('turning it back ON DELETES the key instead of writing true', () => {
    const { updateEngineConfig } = renderSection({
      claudeConfig: { defaultModel: 'opus', stopKeepsBackgroundAgents: false }
    })
    fireEvent.click(toggle('stopKeepsBackgroundAgents'))
    expect(updateEngineConfig).toHaveBeenLastCalledWith({ claudeConfig: { defaultModel: 'opus' } })
  })

  it('Reset shows while the key is set and deletes it', () => {
    const { updateEngineConfig } = renderSection({
      claudeConfig: { defaultModel: 'opus', stopKeepsBackgroundAgents: false }
    })
    fireEvent.click(screen.getByTestId(`${T}.stopKeepsBackgroundAgents.reset`))
    expect(updateEngineConfig).toHaveBeenCalledTimes(1)
    expect(updateEngineConfig).toHaveBeenLastCalledWith({ claudeConfig: { defaultModel: 'opus' } })
  })

  it('Reset on the two older rows restores their defaults by deleting the keys', () => {
    const { updateEngineConfig } = renderSection({
      claudeConfig: { idleCompaction: true, privacyEmailCheck: false }
    })
    fireEvent.click(screen.getByTestId(`${T}.idleCompaction.reset`))
    expect(updateEngineConfig).toHaveBeenLastCalledWith({
      claudeConfig: { privacyEmailCheck: false }
    })
    fireEvent.click(screen.getByTestId(`${T}.privacyEmailCheck.reset`))
    expect(updateEngineConfig).toHaveBeenLastCalledWith({ claudeConfig: { idleCompaction: true } })
  })

  it('a hand-edited non-boolean reads as the default, as the host reads it', () => {
    renderSection({
      claudeConfig: {
        idleCompaction: 'yes',
        privacyEmailCheck: 0,
        stopKeepsBackgroundAgents: 'no'
      } as unknown as EngineConfig['claudeConfig']
    })
    expect(toggle('idleCompaction')).toHaveAttribute('aria-pressed', 'false')
    expect(toggle('privacyEmailCheck')).toHaveAttribute('aria-pressed', 'true')
    expect(toggle('stopKeepsBackgroundAgents')).toHaveAttribute('aria-pressed', 'true')
  })

  it('writes claudeConfig only — never another engine’s block', () => {
    const { updateEngineConfig } = renderSection({ dispatch: { defaultModel: 'haiku' } })
    fireEvent.click(toggle('idleCompaction'))
    const [patch] = updateEngineConfig.mock.calls[0] as [Record<string, unknown>]
    expect(Object.keys(patch)).toEqual(['claudeConfig'])
  })
})
