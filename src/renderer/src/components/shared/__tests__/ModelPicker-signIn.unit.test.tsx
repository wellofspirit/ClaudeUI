/**
 * Layer 1: the model picker's sign-in entry point (ADR-068 §3, Slice 6).
 *
 * A group whose provider has no usable credential gets ONE leading "Sign in to
 * …" item and dimmed — never disabled — options. Two rules carry the weight:
 *
 *  - `'unknown'` renders exactly as the picker always did. The registry read is
 *    async and the Claude probe only lands when a session starts, so treating
 *    "not yet known" as "signed out" would put the item on every cold boot.
 *  - the options stay clickable. Picking a model and then signing in is a
 *    legitimate order, and a picker that refuses the click leaves the user with
 *    a dimmed row and no way forward.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ModelPicker, type ModelDisplay } from '../InlinePickers'
import { useSessionStore } from '../../../stores/session-store'
import { UNKNOWN_PROVIDER_AUTH, type ProviderAuthView } from '../../../utils/sign-in-provider'

const claudeModel: ModelDisplay = {
  value: 'claude-opus-4-7',
  displayName: 'Opus 4.7',
  description: 'Opus 4.7 · Anthropic',
  shortName: 'Opus 4.7',
  engineId: 'claude',
  vendorId: 'anthropic'
}

const codexModel: ModelDisplay = {
  value: 'gpt-5.6-codex',
  displayName: 'GPT-5.6 Codex',
  description: 'GPT-5.6 Codex · OpenAI',
  shortName: 'GPT-5.6 Codex',
  engineId: 'codex',
  vendorId: 'openai'
}

const zenModel: ModelDisplay = {
  value: 'opencode/mimo-v2.5-free',
  displayName: 'MiMo',
  description: 'MiMo · OpenCode Zen',
  shortName: 'MiMo',
  engineId: 'opencode',
  vendorId: 'zen',
  free: true
}

function setAuth(patch: Partial<ProviderAuthView>): void {
  useSessionStore.setState({ providerAuth: { ...UNKNOWN_PROVIDER_AUTH, ...patch } })
}

function openDropdown(): void {
  fireEvent.click(screen.getByTestId('ModelPicker.trigger'))
}

function optionByValue(value: string): HTMLElement {
  const match = screen
    .getAllByTestId('ModelPicker.option')
    .find((o) => o.getAttribute('data-value') === value)
  if (!match) throw new Error(`No ModelPicker.option with data-value="${value}"`)
  return match
}

function signInItems(): HTMLElement[] {
  return screen.queryAllByTestId('ModelPicker.signIn')
}

beforeEach(() => {
  useSessionStore.setState({ providerAuth: UNKNOWN_PROVIDER_AUTH, signInDialog: null })
})

describe('ModelPicker — sign-in entry point', () => {
  it('an unauthenticated group gets one Sign in item and dimmed options', () => {
    setAuth({ anthropic: 'unauthenticated' })
    render(
      <ModelPicker
        models={[claudeModel, zenModel]}
        selectedModel={claudeModel}
        onSelectModel={vi.fn()}
      />
    )
    openDropdown()

    const items = signInItems()
    expect(items).toHaveLength(1)
    expect(items[0]).toHaveAttribute('data-id', 'anthropic')
    expect(items[0]).toHaveTextContent('Sign in to Claude')
    expect(optionByValue('claude-opus-4-7').className).toContain('opacity-60')
    // The authenticated-irrelevant opencode zen group is untouched.
    expect(optionByValue('opencode/mimo-v2.5-free').className).not.toContain('opacity-60')
  })

  it('clicking it opens the dialog in reauth mode and closes the picker', () => {
    setAuth({ chatgpt: 'unauthenticated' })
    render(<ModelPicker models={[codexModel]} selectedModel={codexModel} onSelectModel={vi.fn()} />)
    openDropdown()

    fireEvent.click(screen.getByTestId('ModelPicker.signIn'))
    expect(useSessionStore.getState().signInDialog).toEqual({
      providerId: 'chatgpt',
      mode: 'reauth'
    })
    expect(screen.queryByTestId('ModelPicker.option')).toBeNull()
  })

  it('a dimmed option is still selectable', () => {
    const onSelectModel = vi.fn()
    setAuth({ anthropic: 'unauthenticated' })
    render(
      <ModelPicker
        models={[claudeModel]}
        selectedModel={claudeModel}
        onSelectModel={onSelectModel}
      />
    )
    openDropdown()

    const option = optionByValue('claude-opus-4-7')
    expect(option).not.toBeDisabled()
    fireEvent.click(option)
    expect(onSelectModel).toHaveBeenCalledWith('claude-opus-4-7')
  })

  it.each(['authenticated', 'unknown'] as const)(
    'a %s group shows neither the item nor the dimming',
    (state) => {
      setAuth({ anthropic: state })
      render(
        <ModelPicker models={[claudeModel]} selectedModel={claudeModel} onSelectModel={vi.fn()} />
      )
      openDropdown()

      expect(signInItems()).toHaveLength(0)
      expect(optionByValue('claude-opus-4-7').className).not.toContain('opacity-60')
    }
  )

  it('gates a pi ChatGPT group on the route being enabled', () => {
    const piModel: ModelDisplay = {
      value: 'openai-codex/gpt-5.6-luna',
      displayName: 'Luna',
      description: 'Luna · OpenAI Codex',
      shortName: 'Luna',
      engineId: 'pi',
      vendorId: 'openai-codex'
    }
    setAuth({ chatgpt: 'unauthenticated', chatgptRoutes: { pi: false } })
    const { unmount } = render(
      <ModelPicker models={[piModel]} selectedModel={piModel} onSelectModel={vi.fn()} />
    )
    openDropdown()
    expect(signInItems()).toHaveLength(0)
    unmount()

    setAuth({ chatgpt: 'unauthenticated', chatgptRoutes: { pi: true } })
    render(<ModelPicker models={[piModel]} selectedModel={piModel} onSelectModel={vi.fn()} />)
    openDropdown()
    expect(signInItems()[0]).toHaveTextContent('Sign in to ChatGPT')
    expect(signInItems()[0]).toHaveAttribute('data-id', 'chatgpt')
  })
})
