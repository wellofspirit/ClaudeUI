/**
 * Layer 2: Claude › Endpoint and Claude › Model mapping (ADR-074 §9), the two
 * group bodies over `vendors/anthropic.json`.
 *
 * What is guarded is the behaviour the move changed, not the markup:
 *
 *  - the gateway fields exist only once "A custom gateway" is chosen, and
 *    choosing Anthropic flips `enabled` alone — the stored URL and token stay,
 *    so switching back restores them;
 *  - the auth token is masked until Reveal, a per-view toggle;
 *  - pin and rename are two switches whose dependent rows appear only when on,
 *    and every switch writes BOTH new flags plus the legacy `enabled`, so an
 *    older build reading the file sees "on" whenever either job is;
 *  - `ChoiceCards` is a real radio group (roles, aria-checked, arrow keys).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SECTIONS } from '../settings-sections'
import type { VendorConfig } from '../../../../../shared/types'

afterEach(cleanup)

function renderItem(
  key: 'claudeEndpoint' | 'claudeModelMapping',
  vendorConfig: VendorConfig
): { updateVendorConfig: ReturnType<typeof vi.fn> } {
  const updateVendorConfig = vi.fn()
  const item = SECTIONS.find((s) => s.id === 'claude-endpoint')!.items.find((i) => i.key === key)!
  render(
    item.render(
      {} as never,
      () => {},
      {} as never,
      () => {},
      vendorConfig,
      updateVendorConfig as never
    )
  )
  return { updateVendorConfig }
}

const E = 'ClaudeEndpointSection'
const M = 'ClaudeModelMappingSection'

const option = (value: string): HTMLElement =>
  screen.getAllByTestId(`${E}.target.option`).find((el) => el.getAttribute('data-id') === value)!

const GATEWAY: VendorConfig = {
  endpoint: { enabled: true, baseUrl: 'https://gw.example.com', authToken: 'sk-ant-secret' }
}

describe('Claude › Endpoint', () => {
  it('hides the gateway fields while Anthropic is chosen, even with a stored URL', () => {
    renderItem('claudeEndpoint', {
      endpoint: { enabled: false, baseUrl: 'https://gw.example.com', authToken: 't' }
    })
    expect(option('anthropic').getAttribute('aria-checked')).toBe('true')
    expect(option('gateway').getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByTestId(`${E}.baseUrl`)).toBeNull()
    expect(screen.queryByTestId(`${E}.authToken`)).toBeNull()
    expect(screen.queryByTestId(`${E}.tokenHint`)).toBeNull()
  })

  it('shows them, and the Bearer hint, once the gateway is chosen', () => {
    renderItem('claudeEndpoint', GATEWAY)
    expect(option('gateway').getAttribute('aria-checked')).toBe('true')
    expect((screen.getByTestId(`${E}.baseUrl`) as HTMLInputElement).value).toBe(
      'https://gw.example.com'
    )
    expect(screen.getByTestId(`${E}.tokenHint`).textContent).toContain(
      'Sent as Authorization: Bearer'
    )
  })

  it('choosing Anthropic flips enabled and KEEPS the stored URL and token', () => {
    const { updateVendorConfig } = renderItem('claudeEndpoint', GATEWAY)
    fireEvent.click(option('anthropic'))
    expect(updateVendorConfig).toHaveBeenCalledWith({
      endpoint: { enabled: false, baseUrl: 'https://gw.example.com', authToken: 'sk-ant-secret' }
    })
  })

  it('choosing the gateway on an empty config writes a whole endpoint object', () => {
    const { updateVendorConfig } = renderItem('claudeEndpoint', {})
    fireEvent.click(option('gateway'))
    expect(updateVendorConfig).toHaveBeenCalledWith({
      endpoint: { enabled: true, baseUrl: '', authToken: '' }
    })
  })

  it('arrow keys move the selection, as in a native radio group', () => {
    const { updateVendorConfig } = renderItem('claudeEndpoint', {})
    expect(screen.getByTestId(`${E}.target`).getAttribute('role')).toBe('radiogroup')
    // One tab stop: the checked card.
    expect(option('anthropic').tabIndex).toBe(0)
    expect(option('gateway').tabIndex).toBe(-1)
    fireEvent.keyDown(option('anthropic'), { key: 'ArrowRight' })
    expect(updateVendorConfig).toHaveBeenLastCalledWith({
      endpoint: { enabled: true, baseUrl: '', authToken: '' }
    })
    expect(document.activeElement).toBe(option('gateway'))
  })

  it('masks the auth token until Reveal, and re-masks on a second press', () => {
    renderItem('claudeEndpoint', GATEWAY)
    const token = (): HTMLInputElement => screen.getByTestId(`${E}.authToken`) as HTMLInputElement
    expect(token().type).toBe('password')
    fireEvent.click(screen.getByTestId(`${E}.revealToken`))
    expect(token().type).toBe('text')
    fireEvent.click(screen.getByTestId(`${E}.revealToken`))
    expect(token().type).toBe('password')
  })

  it('writes the WHOLE endpoint object on a field edit', () => {
    const { updateVendorConfig } = renderItem('claudeEndpoint', GATEWAY)
    fireEvent.change(screen.getByTestId(`${E}.baseUrl`), {
      target: { value: 'https://other.example.com' }
    })
    expect(updateVendorConfig).toHaveBeenCalledWith({
      endpoint: { enabled: true, baseUrl: 'https://other.example.com', authToken: 'sk-ant-secret' }
    })
  })
})

const FIELDS = { model: 'm', sonnetModel: 's', opusModel: 'o', haikuModel: '' }

describe('Claude › Model mapping', () => {
  it('shows no dependent rows while both switches are off', () => {
    renderItem('claudeModelMapping', { modelOverride: { enabled: false, ...FIELDS } })
    expect(screen.getByTestId(`${M}.pin`).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId(`${M}.rename`).getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByTestId(`${M}.pinModel`)).toBeNull()
    expect(screen.queryAllByTestId(`${M}.aliasRow`)).toHaveLength(0)
  })

  it('a legacy enabled:true file reads as both switches on', () => {
    renderItem('claudeModelMapping', { modelOverride: { enabled: true, ...FIELDS } })
    expect((screen.getByTestId(`${M}.pinModel`) as HTMLInputElement).value).toBe('m')
    expect(screen.getAllByTestId(`${M}.aliasRow`).map((r) => r.getAttribute('data-id'))).toEqual([
      'sonnet',
      'opus',
      'haiku'
    ])
  })

  it('each alias row names the env var it sets', () => {
    renderItem('claudeModelMapping', {
      modelOverride: { enabled: true, pinEnabled: false, renameEnabled: true, ...FIELDS }
    })
    expect(screen.queryByTestId(`${M}.pinModel`)).toBeNull()
    const text = screen
      .getAllByTestId(`${M}.aliasRow`)
      .map((r) => r.textContent)
      .join('|')
    expect(text).toContain('ANTHROPIC_DEFAULT_SONNET_MODEL')
    expect(text).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL')
    expect(text).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL')
  })

  it('turning pin off on a legacy file writes both flags, keeping rename on', () => {
    const { updateVendorConfig } = renderItem('claudeModelMapping', {
      modelOverride: { enabled: true, ...FIELDS }
    })
    fireEvent.click(screen.getByTestId(`${M}.pin`))
    expect(updateVendorConfig).toHaveBeenCalledWith({
      modelOverride: {
        enabled: true,
        pinEnabled: false,
        renameEnabled: true,
        ...FIELDS
      }
    })
  })

  it('turning rename on from all-off sets enabled for older builds', () => {
    const { updateVendorConfig } = renderItem('claudeModelMapping', {
      modelOverride: { enabled: false, ...FIELDS }
    })
    fireEvent.click(screen.getByTestId(`${M}.rename`))
    expect(updateVendorConfig).toHaveBeenCalledWith({
      modelOverride: { enabled: true, pinEnabled: false, renameEnabled: true, ...FIELDS }
    })
  })

  it('turning the last switch off clears enabled', () => {
    const { updateVendorConfig } = renderItem('claudeModelMapping', {
      modelOverride: { enabled: true, pinEnabled: true, renameEnabled: false, ...FIELDS }
    })
    fireEvent.click(screen.getByTestId(`${M}.pin`))
    expect(updateVendorConfig).toHaveBeenCalledWith({
      modelOverride: { enabled: false, pinEnabled: false, renameEnabled: false, ...FIELDS }
    })
  })

  it('an alias edit writes the whole object', () => {
    const { updateVendorConfig } = renderItem('claudeModelMapping', {
      modelOverride: { enabled: true, pinEnabled: false, renameEnabled: true, ...FIELDS }
    })
    const opus = screen
      .getAllByTestId(`${M}.aliasModel`)
      .find((el) => el.getAttribute('data-id') === 'opus')!
    fireEvent.change(opus, { target: { value: 'gw-opus' } })
    expect(updateVendorConfig).toHaveBeenCalledWith({
      modelOverride: {
        enabled: true,
        pinEnabled: false,
        renameEnabled: true,
        ...FIELDS,
        opusModel: 'gw-opus'
      }
    })
  })
})
