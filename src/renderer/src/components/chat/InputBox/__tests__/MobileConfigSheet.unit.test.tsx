/**
 * Layer 1: Unit tests for MobileConfigSheet — the mobile-only combined
 * Engine/Model/Thinking/Variant/Effort control (bottom sheet, Option B).
 *
 * Covers the kickoff spec's testing checklist (a-h), scoped to this
 * standalone component. Integration point (a) — that View renders exactly
 * one trigger on mobile and the individual pickers on desktop — is covered
 * separately in View.unit.test.tsx.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MobileConfigSheet, type MobileConfigSheetProps } from '../MobileConfigSheet'
import type { ModelDisplay } from '../../../shared/InlinePickers'

const opusModel: ModelDisplay = {
  value: 'claude-opus-4-7',
  displayName: 'Opus 4.7',
  description: 'Opus 4.7 · Anthropic',
  shortName: 'Opus 4.7',
  engineId: 'claude',
  vendorId: 'anthropic'
}

const veryLongModel: ModelDisplay = {
  value: 'openai-codex/gpt-5-6-experimental-research-preview-long-name',
  displayName: 'GPT-5.6 Experimental Research Preview (Very Long Name Edition)',
  description: 'GPT-5.6 Experimental Research Preview (Very Long Name Edition) · OpenAI Codex',
  shortName: 'GPT-5.6 Experimental Research Preview (Very Long Name Edition)',
  engineId: 'pi',
  vendorId: 'openai-codex'
}

function makeProps(overrides: Partial<MobileConfigSheetProps> = {}): MobileConfigSheetProps {
  return {
    models: [opusModel],
    selectedModel: opusModel,
    selectedEngineId: 'claude',
    engineLocked: false,
    showModePicker: false,
    permissionMode: 'default',
    canPlan: true,
    autoAvailable: true,
    showEnginePicker: true,
    showModelPicker: true,
    showThinkingPicker: true,
    thinkingMode: 'adaptive',
    adaptiveSupported: true,
    reasoningVariants: [],
    reasoningVariant: null,
    effort: 'high',
    effortSupported: true,
    allowedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    onSelectMode: vi.fn(),
    onSelectEngine: vi.fn(),
    onSelectModel: vi.fn(),
    onSelectThinking: vi.fn(),
    onSelectReasoningVariant: vi.fn(),
    onSelectEffort: vi.fn(),
    ...overrides
  }
}

function openSheet(): void {
  fireEvent.click(screen.getByTestId('MobileConfigSheet.trigger'))
}

describe('MobileConfigSheet — trigger', () => {
  it('shows engine logo, model shortName, and effort when effort is supported', () => {
    render(<MobileConfigSheet {...makeProps()} />)
    const trigger = screen.getByTestId('MobileConfigSheet.trigger')
    expect(trigger).toHaveTextContent('Opus 4.7 · high')
    expect(within(trigger).getByTestId('EngineLogo')).toBeInTheDocument()
  })

  it('displays the effort suffix capitalized like existing picker UX, without altering model casing', () => {
    render(<MobileConfigSheet {...makeProps({ effort: 'xhigh' })} />)
    const trigger = screen.getByTestId('MobileConfigSheet.trigger')
    const effortSpan = within(trigger).getByText('xhigh')
    expect(effortSpan.className).toContain('capitalize')
    expect(trigger).toHaveTextContent('Opus 4.7 · xhigh')
    // The summary stays a single truncated line even with the nested span.
    const label = trigger.querySelector('span.truncate')
    expect(label!.className).toContain('whitespace-nowrap')
  })

  it('omits the effort suffix when effort is unsupported', () => {
    render(<MobileConfigSheet {...makeProps({ effortSupported: false })} />)
    const trigger = screen.getByTestId('MobileConfigSheet.trigger')
    expect(trigger).toHaveTextContent('Opus 4.7')
    expect(trigger).not.toHaveTextContent('·')
  })

  it('keeps a long model label single-line and truncated (never wraps)', () => {
    render(
      <MobileConfigSheet
        {...makeProps({ models: [veryLongModel], selectedModel: veryLongModel })}
      />
    )
    const trigger = screen.getByTestId('MobileConfigSheet.trigger')
    const label = trigger.querySelector('span.truncate')
    expect(label).not.toBeNull()
    expect(label!.className).toContain('truncate')
    expect(label!.className).toContain('whitespace-nowrap')
    expect(label!.className).toContain('min-w-0')
  })

  it('hides the trigger entirely when no grouped setting is applicable', () => {
    const { container } = render(
      <MobileConfigSheet
        {...makeProps({
          showEnginePicker: false,
          showModelPicker: false,
          showThinkingPicker: false,
          reasoningVariants: [],
          effortSupported: false
        })}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('MobileConfigSheet — root page', () => {
  it('opens on the root page with capability-gated rows and their selected values', () => {
    render(
      <MobileConfigSheet
        {...makeProps({
          reasoningVariants: ['none', 'thinking'],
          reasoningVariant: 'thinking'
        })}
      />
    )
    openSheet()

    const dialog = screen.getByTestId('MobileConfigSheet.dialog')
    expect(dialog).toHaveAttribute('role', 'dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(within(dialog).getByText('Run configuration')).toBeInTheDocument()

    expect(screen.getByTestId('MobileConfigSheet.engine')).toHaveTextContent('Claude')
    expect(screen.getByTestId('MobileConfigSheet.model')).toHaveTextContent('Opus 4.7')
    expect(screen.getByTestId('MobileConfigSheet.thinking')).toHaveTextContent('adaptive')
    expect(screen.getByTestId('MobileConfigSheet.variant')).toHaveTextContent('thinking')
    expect(screen.getByTestId('MobileConfigSheet.effort')).toHaveTextContent('high')
  })

  it('hides rows for capabilities that are unavailable', () => {
    render(
      <MobileConfigSheet
        {...makeProps({
          showEnginePicker: false,
          showThinkingPicker: false,
          reasoningVariants: [],
          effortSupported: false
        })}
      />
    )
    openSheet()
    expect(screen.queryByTestId('MobileConfigSheet.engine')).not.toBeInTheDocument()
    expect(screen.getByTestId('MobileConfigSheet.model')).toBeInTheDocument()
    expect(screen.queryByTestId('MobileConfigSheet.thinking')).not.toBeInTheDocument()
    expect(screen.queryByTestId('MobileConfigSheet.variant')).not.toBeInTheDocument()
    expect(screen.queryByTestId('MobileConfigSheet.effort')).not.toBeInTheDocument()
  })

  it('opening the sheet always starts on the root page (state resets across opens)', () => {
    render(<MobileConfigSheet {...makeProps()} />)
    openSheet()
    fireEvent.click(screen.getByTestId('MobileConfigSheet.model'))
    expect(screen.getByText('Model')).toBeInTheDocument()

    // Close and reopen — must land back on root, not the previous submenu.
    fireEvent.click(screen.getByTestId('MobileConfigSheet.close'))
    openSheet()
    expect(screen.getByTestId('MobileConfigSheet.engine')).toBeInTheDocument()
  })
})

describe('MobileConfigSheet — mode row + submenu', () => {
  it('renders the mode row with the current label when showModePicker is true', () => {
    render(
      <MobileConfigSheet {...makeProps({ showModePicker: true, permissionMode: 'acceptEdits' })} />
    )
    openSheet()
    expect(screen.getByTestId('MobileConfigSheet.mode')).toHaveTextContent('Accept Edits')
  })

  it('hides the mode row when showModePicker is false', () => {
    render(<MobileConfigSheet {...makeProps({ showModePicker: false })} />)
    openSheet()
    expect(screen.queryByTestId('MobileConfigSheet.mode')).not.toBeInTheDocument()
  })

  it('tapping the mode row opens the mode page listing all four options', () => {
    render(<MobileConfigSheet {...makeProps({ showModePicker: true })} />)
    openSheet()
    fireEvent.click(screen.getByTestId('MobileConfigSheet.mode'))

    const options = screen.getAllByTestId('MobileConfigSheet.modeOption')
    expect(options.map((o) => o.getAttribute('data-value'))).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'auto'
    ])
  })

  it('disables the plan option when canPlan is false, leaving the others enabled', () => {
    render(<MobileConfigSheet {...makeProps({ showModePicker: true, canPlan: false })} />)
    openSheet()
    fireEvent.click(screen.getByTestId('MobileConfigSheet.mode'))

    const options = screen.getAllByTestId('MobileConfigSheet.modeOption')
    const plan = options.find((o) => o.getAttribute('data-value') === 'plan')!
    expect(plan).toBeDisabled()
    expect(plan).toHaveAttribute('title', expect.stringContaining("doesn't support plan mode"))
    for (const value of ['default', 'acceptEdits', 'auto']) {
      expect(options.find((o) => o.getAttribute('data-value') === value)).toBeEnabled()
    }
  })

  it('disables the auto option when autoAvailable is false, leaving the others enabled', () => {
    render(<MobileConfigSheet {...makeProps({ showModePicker: true, autoAvailable: false })} />)
    openSheet()
    fireEvent.click(screen.getByTestId('MobileConfigSheet.mode'))

    const options = screen.getAllByTestId('MobileConfigSheet.modeOption')
    const auto = options.find((o) => o.getAttribute('data-value') === 'auto')!
    expect(auto).toBeDisabled()
    expect(auto).toHaveAttribute('title', expect.stringContaining('unavailable for this account'))
    for (const value of ['default', 'acceptEdits', 'plan']) {
      expect(options.find((o) => o.getAttribute('data-value') === value)).toBeEnabled()
    }
  })

  it('selecting an option calls onSelectMode with the mode value and returns to root', () => {
    const onSelectMode = vi.fn()
    render(<MobileConfigSheet {...makeProps({ showModePicker: true, onSelectMode })} />)
    openSheet()
    fireEvent.click(screen.getByTestId('MobileConfigSheet.mode'))

    const options = screen.getAllByTestId('MobileConfigSheet.modeOption')
    fireEvent.click(options.find((o) => o.getAttribute('data-value') === 'acceptEdits')!)

    expect(onSelectMode).toHaveBeenCalledWith('acceptEdits')
    expect(screen.getByTestId('MobileConfigSheet.mode')).toBeInTheDocument()
  })

  it('clicking a disabled mode option does not call onSelectMode', () => {
    const onSelectMode = vi.fn()
    render(
      <MobileConfigSheet {...makeProps({ showModePicker: true, canPlan: false, onSelectMode })} />
    )
    openSheet()
    fireEvent.click(screen.getByTestId('MobileConfigSheet.mode'))
    const plan = screen
      .getAllByTestId('MobileConfigSheet.modeOption')
      .find((o) => o.getAttribute('data-value') === 'plan')!
    fireEvent.click(plan)
    expect(onSelectMode).not.toHaveBeenCalled()
  })
})

describe('MobileConfigSheet — engine submenu', () => {
  it('drills in, lists every engine, marks current, and selecting calls back + returns root', () => {
    const onSelectEngine = vi.fn()
    render(<MobileConfigSheet {...makeProps({ onSelectEngine })} />)
    openSheet()
    fireEvent.click(screen.getByTestId('MobileConfigSheet.engine'))

    const options = screen.getAllByTestId('MobileConfigSheet.engineOption')
    expect(options.map((o) => o.getAttribute('data-value'))).toEqual(['claude', 'opencode', 'pi'])

    const piOption = options.find((o) => o.getAttribute('data-value') === 'pi')!
    fireEvent.click(piOption)

    expect(onSelectEngine).toHaveBeenCalledWith('pi')
    // Returned to root.
    expect(screen.getByTestId('MobileConfigSheet.engine')).toBeInTheDocument()
  })

  it('a locked engine row is disabled and non-drillable with a useful hint', () => {
    render(<MobileConfigSheet {...makeProps({ engineLocked: true })} />)
    openSheet()
    const row = screen.getByTestId('MobileConfigSheet.engine')
    expect(row).toBeDisabled()
    expect(row).toHaveAttribute(
      'title',
      expect.stringContaining('Engine cannot change after session initialization')
    )
    fireEvent.click(row)
    expect(screen.queryByTestId('MobileConfigSheet.engineOption')).not.toBeInTheDocument()
  })
})

describe('MobileConfigSheet — model submenu', () => {
  const claudeModel: ModelDisplay = opusModel
  const zenFreeModel: ModelDisplay = {
    value: 'opencode/free1',
    displayName: 'Free One',
    description: 'Free One · OpenCode Zen',
    shortName: 'Free One',
    engineId: 'opencode',
    vendorId: 'zen',
    free: true
  }
  const zenPaidModel: ModelDisplay = {
    value: 'opencode/paid1',
    displayName: 'Paid One',
    description: 'Paid One · OpenCode Zen',
    shortName: 'Paid One',
    engineId: 'opencode',
    vendorId: 'zen'
  }

  it('groups by engine/vendor, shows free badges + filter, selecting calls back + returns root', () => {
    const onSelectModel = vi.fn()
    render(
      <MobileConfigSheet
        {...makeProps({
          models: [claudeModel, zenFreeModel, zenPaidModel],
          onSelectModel
        })}
      />
    )
    openSheet()
    fireEvent.click(screen.getByTestId('MobileConfigSheet.model'))

    expect(screen.getAllByTestId('MobileConfigSheet.modelOption')).toHaveLength(3)
    expect(screen.getByTestId('MobileConfigSheet.modelFreeFilter')).toBeInTheDocument()
    expect(screen.getByTestId('MobileConfigSheet.modelFreeBadge')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('MobileConfigSheet.modelFreeFilter'))
    expect(screen.getAllByTestId('MobileConfigSheet.modelOption')).toHaveLength(1)

    fireEvent.click(screen.getByTestId('MobileConfigSheet.modelOption'))
    expect(onSelectModel).toHaveBeenCalledWith('opencode/free1')
    // Returned to root.
    expect(screen.getByTestId('MobileConfigSheet.model')).toBeInTheDocument()
  })

  it('a long model label stays single-line/truncated in the option list', () => {
    render(
      <MobileConfigSheet
        {...makeProps({
          models: [veryLongModel],
          selectedModel: veryLongModel
        })}
      />
    )
    openSheet()
    fireEvent.click(screen.getByTestId('MobileConfigSheet.model'))
    const option = screen.getByTestId('MobileConfigSheet.modelOption')
    const label = within(option).getByText(veryLongModel.shortName)
    expect(label.className).toContain('truncate')
  })
})

describe('MobileConfigSheet — thinking submenu', () => {
  it('lists all modes, disables adaptive when unsupported with tooltip, selecting returns root', () => {
    const onSelectThinking = vi.fn()
    render(
      <MobileConfigSheet
        {...makeProps({ adaptiveSupported: false, thinkingMode: 'enabled', onSelectThinking })}
      />
    )
    openSheet()
    fireEvent.click(screen.getByTestId('MobileConfigSheet.thinking'))

    const options = screen.getAllByTestId('MobileConfigSheet.thinkingOption')
    expect(options.map((o) => o.getAttribute('data-value'))).toEqual([
      'adaptive',
      'enabled',
      'disabled'
    ])

    const adaptive = options.find((o) => o.getAttribute('data-value') === 'adaptive')!
    expect(adaptive).toBeDisabled()
    expect(adaptive).toHaveAttribute(
      'title',
      expect.stringContaining('Adaptive thinking is only supported')
    )
    fireEvent.click(adaptive)
    expect(onSelectThinking).not.toHaveBeenCalled()

    const disabledMode = options.find((o) => o.getAttribute('data-value') === 'disabled')!
    fireEvent.click(disabledMode)
    expect(onSelectThinking).toHaveBeenCalledWith('disabled')
    expect(screen.getByTestId('MobileConfigSheet.thinking')).toBeInTheDocument()
  })
})

describe('MobileConfigSheet — reasoning variant submenu', () => {
  it('lists Default + variants, selecting calls back + returns root', () => {
    const onSelectReasoningVariant = vi.fn()
    render(
      <MobileConfigSheet
        {...makeProps({
          reasoningVariants: ['none', 'thinking'],
          reasoningVariant: 'none',
          onSelectReasoningVariant
        })}
      />
    )
    openSheet()
    fireEvent.click(screen.getByTestId('MobileConfigSheet.variant'))

    const options = screen.getAllByTestId('MobileConfigSheet.variantOption')
    expect(options.map((o) => o.getAttribute('data-value'))).toEqual([
      'Default',
      'none',
      'thinking'
    ])

    fireEvent.click(options.find((o) => o.getAttribute('data-value') === 'thinking')!)
    expect(onSelectReasoningVariant).toHaveBeenCalledWith('thinking')
    expect(screen.getByTestId('MobileConfigSheet.variant')).toBeInTheDocument()
  })

  it('selecting Default calls back with null', () => {
    const onSelectReasoningVariant = vi.fn()
    render(
      <MobileConfigSheet
        {...makeProps({
          reasoningVariants: ['none', 'thinking'],
          reasoningVariant: 'thinking',
          onSelectReasoningVariant
        })}
      />
    )
    openSheet()
    fireEvent.click(screen.getByTestId('MobileConfigSheet.variant'))
    fireEvent.click(screen.getAllByTestId('MobileConfigSheet.variantOption')[0])
    expect(onSelectReasoningVariant).toHaveBeenCalledWith(null)
  })
})

describe('MobileConfigSheet — effort submenu', () => {
  it('lists all levels, disables unsupported ones with tooltip, selecting returns root', () => {
    const onSelectEffort = vi.fn()
    render(
      <MobileConfigSheet
        {...makeProps({
          effort: 'high',
          allowedEffortLevels: ['low', 'medium', 'high', 'max'],
          onSelectEffort
        })}
      />
    )
    openSheet()
    fireEvent.click(screen.getByTestId('MobileConfigSheet.effort'))

    const options = screen.getAllByTestId('MobileConfigSheet.effortOption')
    const xhigh = options.find((o) => o.getAttribute('data-value') === 'xhigh')!
    expect(xhigh).toBeDisabled()
    expect(xhigh).toHaveAttribute(
      'title',
      expect.stringContaining('xhigh effort is only available on Opus 4.7')
    )
    fireEvent.click(xhigh)
    expect(onSelectEffort).not.toHaveBeenCalled()

    const max = options.find((o) => o.getAttribute('data-value') === 'max')!
    fireEvent.click(max)
    expect(onSelectEffort).toHaveBeenCalledWith('max')
    expect(screen.getByTestId('MobileConfigSheet.effort')).toBeInTheDocument()
  })
})

describe('MobileConfigSheet — dialog chrome', () => {
  it('backdrop click closes the sheet', () => {
    render(<MobileConfigSheet {...makeProps()} />)
    openSheet()
    fireEvent.click(screen.getByTestId('MobileConfigSheet.backdrop'))
    expect(screen.queryByTestId('MobileConfigSheet.dialog')).not.toBeInTheDocument()
  })

  it('close button closes the sheet', () => {
    render(<MobileConfigSheet {...makeProps()} />)
    openSheet()
    fireEvent.click(screen.getByTestId('MobileConfigSheet.close'))
    expect(screen.queryByTestId('MobileConfigSheet.dialog')).not.toBeInTheDocument()
  })

  it('Escape key closes the sheet', () => {
    render(<MobileConfigSheet {...makeProps()} />)
    openSheet()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('MobileConfigSheet.dialog')).not.toBeInTheDocument()
  })

  it('back returns from a submenu to root without closing the sheet', () => {
    render(<MobileConfigSheet {...makeProps()} />)
    openSheet()
    fireEvent.click(screen.getByTestId('MobileConfigSheet.model'))
    expect(screen.queryByTestId('MobileConfigSheet.back')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('MobileConfigSheet.back'))
    expect(screen.getByTestId('MobileConfigSheet.dialog')).toBeInTheDocument()
    expect(screen.getByTestId('MobileConfigSheet.engine')).toBeInTheDocument()
    expect(screen.queryByTestId('MobileConfigSheet.back')).not.toBeInTheDocument()
  })

  it('closes when every grouped setting becomes inapplicable, and does not silently reappear open once they return', () => {
    const { rerender } = render(<MobileConfigSheet {...makeProps()} />)
    openSheet()
    expect(screen.getByTestId('MobileConfigSheet.dialog')).toBeInTheDocument()

    // All capabilities disappear mid-session (e.g. an engine switch) — the
    // component renders null, but its internal `open` state must not survive
    // this so the dialog doesn't pop back open once settings return.
    rerender(
      <MobileConfigSheet
        {...makeProps({
          showEnginePicker: false,
          showModelPicker: false,
          showThinkingPicker: false,
          reasoningVariants: [],
          effortSupported: false
        })}
      />
    )
    expect(screen.queryByTestId('MobileConfigSheet.trigger')).not.toBeInTheDocument()
    expect(screen.queryByTestId('MobileConfigSheet.dialog')).not.toBeInTheDocument()

    rerender(<MobileConfigSheet {...makeProps()} />)
    expect(screen.getByTestId('MobileConfigSheet.trigger')).toBeInTheDocument()
    expect(screen.queryByTestId('MobileConfigSheet.dialog')).not.toBeInTheDocument()
  })

  it('fails safe when the current submenu becomes invalid via external prop change', () => {
    const { rerender } = render(
      <MobileConfigSheet {...makeProps({ effortSupported: true, effort: 'high' })} />
    )
    openSheet()
    fireEvent.click(screen.getByTestId('MobileConfigSheet.effort'))
    expect(screen.getByText('Effort level')).toBeInTheDocument()

    // Model switch mid-sheet drops effort support — must not strand the user
    // on the now-nonexistent effort submenu.
    rerender(<MobileConfigSheet {...makeProps({ effortSupported: false })} />)
    expect(screen.getByText('Run configuration')).toBeInTheDocument()
    expect(screen.queryByTestId('MobileConfigSheet.effortOption')).not.toBeInTheDocument()
  })
})
