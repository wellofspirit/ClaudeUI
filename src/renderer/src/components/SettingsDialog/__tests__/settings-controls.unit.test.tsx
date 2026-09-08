/**
 * Layer 1: shared settings controls.
 *
 * Two things are guarded here.
 *
 * `SettingRow` is the one row vocabulary (ADR-065): every setting in the dialog
 * is drawn through it, so its label/description/chip/badge/reset/error anatomy,
 * its content-sized control column, and the legacy wrappers' preserved APIs are
 * contract, not detail. The
 * contrast fix in particular — a description is 12px `text-text-secondary`, not
 * 10px `text-text-muted/60` — is the reason the redesign happened, and a
 * regression there is invisible in a screenshot on a good monitor.
 *
 * The ⓘ affordance those descriptions replaced is gone entirely (ADR-065
 * phase 7 deleted `InfoTooltip` once the last call site had been converted), so
 * what is guarded of it is only its ABSENCE from the rows below.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import {
  NumberField,
  RadioRow,
  SettingRow,
  SettingsSelect,
  SettingsSlider,
  SettingsToggle,
  ToggleSwitch
} from '../settings-controls'

// ── SettingRow ──────────────────────────────────────────────────────────────

describe('SettingRow', () => {
  it('renders label and description, and the description is the readable size', () => {
    render(<SettingRow label="Compact automatically" description="Summarise when it fills." />)
    const row = screen.getByTestId('SettingRow')
    expect(row).toHaveTextContent('Compact automatically')
    const description = screen.getByText('Summarise when it fills.')
    // 12px / text-secondary is the WCAG-AA fix; 10px text-muted/60 measured
    // 1.6:1 on the dark theme and must never come back.
    expect(description).toHaveClass('text-[12px]')
    expect(description).toHaveClass('text-text-secondary')
  })

  it('renders the engine chip and the applies-later badge, and NO changed dot', () => {
    render(
      <SettingRow
        label="Permission rules"
        engine="claude"
        appliesOn="next-server-start"
        modified
        onReset={vi.fn()}
      >
        <span>control</span>
      </SettingRow>
    )
    expect(screen.getByTestId('SettingRow.engine')).toHaveTextContent('Claude')
    expect(screen.getByTestId('SettingRow.badge')).toHaveTextContent('Next server start')
    // The accent dot was removed on the owner's request (2026-09-08): a changed
    // row has no persistent indicator, only the hover Reset below.
    expect(screen.queryByTestId('SettingRow.modified')).not.toBeInTheDocument()
    expect(screen.getByTestId('SettingRow.reset')).toBeInTheDocument()
  })

  it('offers Reset only when the row is modified AND a reset handler exists', () => {
    const onReset = vi.fn()
    render(
      <SettingRow label="A" modified onReset={onReset}>
        <span>control</span>
      </SettingRow>
    )
    fireEvent.click(screen.getByTestId('SettingRow.reset'))
    expect(onReset).toHaveBeenCalledTimes(1)

    cleanup()
    render(
      <SettingRow label="A" onReset={onReset}>
        <span>control</span>
      </SettingRow>
    )
    expect(screen.queryByTestId('SettingRow.reset')).not.toBeInTheDocument()
  })

  it('puts Reset on the label line of a STACKED row', () => {
    // A stacked row's control column is the full width under the label, so a
    // Reset rendered there would sit above the textarea, left-aligned.
    render(
      <SettingRow
        testid="Stacked"
        layout="stacked"
        label="Network allowlist"
        modified
        onReset={vi.fn()}
      >
        <textarea />
      </SettingRow>
    )
    const reset = screen.getByTestId('Stacked.reset')
    expect(reset.parentElement?.textContent).toContain('Network allowlist')
  })

  it('a disabled dependent row is not resettable either', () => {
    render(
      <SettingRow
        label="Include read results"
        modified
        onReset={vi.fn()}
        as="button"
        disabled
        dimmed
      >
        <span>control</span>
      </SettingRow>
    )
    expect(screen.queryByTestId('SettingRow.reset')).not.toBeInTheDocument()
  })

  it('renders a validation error under the text, in the danger colour', () => {
    render(<SettingRow label="Reserved tokens" error="EACCES: opencode.jsonc is read-only" />)
    const error = screen.getByTestId('SettingRow.error')
    expect(error).toHaveTextContent('EACCES: opencode.jsonc is read-only')
    expect(error).toHaveClass('text-danger')
  })

  it('namespaces its parts under a caller-supplied testid (ADR-027)', () => {
    render(
      <SettingRow
        testid="MyRow"
        dataId="x"
        label="A"
        modified
        onReset={vi.fn()}
        appliesOn="next-session"
      />
    )
    expect(screen.getByTestId('MyRow')).toHaveAttribute('data-id', 'x')
    expect(screen.getByTestId('MyRow.reset')).toBeInTheDocument()
    expect(screen.getByTestId('MyRow.badge')).toBeInTheDocument()
    expect(screen.queryByTestId('SettingRow')).not.toBeInTheDocument()
  })

  it('an explanatory row has no label and no control', () => {
    render(<SettingRow description="Nothing to configure." dimmed />)
    expect(screen.getByTestId('SettingRow')).toHaveTextContent('Nothing to configure.')
  })

  it('sizes the inline control column to its CONTENT, not to a fixed 240px', () => {
    // The fixed column was wrong in both directions: in the 560px Manage sheet
    // a row whose control is one button wrapped its description at half the
    // card, and in the ~330px quick popover it left ~60px of label and pushed
    // the switches out of the sidebar. The label block keeps `flex-1 min-w-0`,
    // so the text now runs to the control and wraps there.
    const { container } = render(
      <SettingRow label="Shared login" description="One sign-in, vended to each engine.">
        <button type="button">Disconnect</button>
      </SettingRow>
    )
    const column = container.querySelector('[data-testid="SettingRow"] > span:last-of-type')!
    expect(column.className).not.toContain('w-[240px]')
    expect(column.className).toContain('shrink-0')
    expect(column.className).toContain('justify-end')
    // The phone cap is unchanged, including the two tokens that shrink a
    // control which declares its own width into it.
    expect(column.className).toContain('max-md:max-w-[58%]')
    expect(column.className).toContain('max-md:[&>*]:max-w-full')
    expect(column.className).toContain('max-md:[&>*]:min-w-0')
  })
})

// ── The legacy wrappers, restyled through it ────────────────────────────────

describe('SettingsToggle', () => {
  it('keeps its testid, data-id and aria-pressed contract', () => {
    const onChange = vi.fn()
    render(
      <SettingsToggle
        testid="MyToggle"
        dataId="row-1"
        label="Split diff view"
        checked
        onChange={onChange}
      />
    )
    const root = screen.getByTestId('MyToggle')
    expect(root).toHaveAttribute('data-id', 'row-1')
    expect(root).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(root)
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it('defaults its testid to the component name', () => {
    render(<SettingsToggle label="A" checked={false} onChange={vi.fn()} />)
    expect(screen.getByTestId('SettingsToggle')).toBeInTheDocument()
  })

  it('renders `tooltip` as a VISIBLE description, with no ⓘ left to hover', () => {
    render(
      <SettingsToggle
        label="Command sandbox"
        checked={false}
        onChange={vi.fn()}
        tooltip="what it does"
      />
    )
    expect(screen.getByTestId('SettingsToggle')).toHaveTextContent('what it does')
    // The hover-only explanation is gone: unreachable on a phone, and the 10px
    // muted variant it replaced failed WCAG AA.
    expect(screen.queryByTestId('InfoTooltip')).not.toBeInTheDocument()
  })

  it('a disabled dependent row does not fire', () => {
    const onChange = vi.fn()
    render(
      <SettingsToggle
        label="Include read results"
        checked
        onChange={onChange}
        indent
        dimmed
        disabled
      />
    )
    fireEvent.click(screen.getByTestId('SettingsToggle'))
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('the control set', () => {
  it('the slider value slot grows with its content instead of clipping', () => {
    // "5,000 chars" is far wider than the board's "115%"; a fixed 36px slot cut
    // it to "5,000 cha" on Chat › Max output chars.
    render(
      <SettingsSlider
        label="Max output chars"
        value={5000}
        min={500}
        max={50000}
        onChange={vi.fn()}
        formatValue={(v) => `${v.toLocaleString()} chars`}
      />
    )
    const slot = screen.getByText('5,000 chars')
    expect(slot).toHaveClass('min-w-9')
    expect(slot).toHaveClass('whitespace-nowrap')
    expect(slot.className).not.toMatch(/(^|\s)w-9(\s|$)/)
  })

  it('the slider DECLARES its 200px track', () => {
    // The content-sized control column can no longer supply a width, so a
    // `flex-1` track would collapse to the value span's width.
    render(<SettingsSlider label="A" value={50} min={0} max={100} onChange={vi.fn()} />)
    const track = screen.getByTestId('SliderField')
    expect(track).toHaveClass('w-[200px]')
    expect(track.className).not.toContain('flex-1')
  })

  it('the slider draws a full-strength accent fill', () => {
    // The whole control used to sit at 40% opacity, which washed the fill out.
    render(<SettingsSlider label="A" value={50} min={0} max={100} onChange={vi.fn()} />)
    const track = screen.getByTestId('SliderField')
    expect(track.className).not.toMatch(/opacity-40/)
    expect(track.style.background).toContain('var(--color-accent)')
  })

  it('the toggle track is visible when off', () => {
    // text-muted at 40% over bg-secondary all but disappears on the dark theme.
    const { container } = render(<ToggleSwitch checked={false} />)
    expect(container.querySelector('[data-testid="ToggleSwitch"]')).toHaveClass('bg-text-muted/60')
  })

  it('the radio is an outlined ring, not the UA’s filled circle', () => {
    render(
      <RadioRow
        name="autonomyMode"
        value="plan"
        label="Read-only (Plan)"
        checked={false}
        onSelect={vi.fn()}
      />
    )
    const radio = screen.getByDisplayValue('plan')
    expect(radio).toHaveClass('appearance-none')
    expect(radio).toHaveClass('border-border-bright')
    expect(radio).toHaveClass('checked:border-accent')
  })
})

describe('SettingsSelect', () => {
  it('keeps the `${testid}.option` + data-id contract call sites assert', () => {
    const onChange = vi.fn()
    render(
      <SettingsSelect
        testid="SettingsTheme"
        label="Theme"
        value="dark"
        options={[
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' }
        ]}
        onChange={onChange}
      />
    )
    const options = screen.getAllByTestId('SettingsTheme.option')
    expect(options.map((o) => o.dataset.id)).toEqual(['dark', 'light'])

    fireEvent.click(options[1])
    expect(onChange).toHaveBeenCalledWith('light')
  })

  it('stays inline for ≤5 options and stacks for 6 or more', () => {
    const opts = (n: number): { value: string; label: string }[] =>
      Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `L${i}` }))

    render(<SettingsSelect label="Five" value="v0" options={opts(5)} onChange={vi.fn()} />)
    expect(screen.getByTestId('SettingsSelect')).toHaveClass('items-center')

    cleanup()
    render(<SettingsSelect label="Six" value="v0" options={opts(6)} onChange={vi.fn()} />)
    expect(screen.getByTestId('SettingsSelect')).toHaveClass('flex-col')
  })
})

describe('NumberField', () => {
  it('does not commit while you are still typing', () => {
    const onChange = vi.fn()
    render(<NumberField value={30} onChange={onChange} />)
    fireEvent.change(screen.getByTestId('NumberField'), { target: { value: '1' } })
    // "1" on the way to "120" must not be written.
    expect(onChange).not.toHaveBeenCalled()
  })

  it('commits on blur', () => {
    const onChange = vi.fn()
    render(<NumberField value={30} onChange={onChange} />)
    const input = screen.getByTestId('NumberField')
    fireEvent.change(input, { target: { value: '120' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith(120)
  })

  it('commits on Enter', () => {
    const onChange = vi.fn()
    render(<NumberField value={30} onChange={onChange} />)
    const input = screen.getByTestId('NumberField')
    fireEvent.change(input, { target: { value: '45' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(45)
  })

  it('commits an empty field as undefined — how "default"/"unlimited" is set', () => {
    const onChange = vi.fn()
    render(<NumberField value={30} onChange={onChange} placeholder="default" />)
    const input = screen.getByTestId('NumberField')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  it('clamps to min/max and ignores a non-number', () => {
    const onChange = vi.fn()
    render(<NumberField value={30} min={1} max={99} onChange={onChange} />)
    const input = screen.getByTestId('NumberField')
    fireEvent.change(input, { target: { value: '5000' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith(99)

    onChange.mockClear()
    fireEvent.change(input, { target: { value: 'abc' } })
    fireEvent.blur(input)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows the placeholder — not a zero — when the value is unset', () => {
    render(<NumberField value={undefined} onChange={vi.fn()} placeholder="unlimited" />)
    expect(screen.getByTestId('NumberField')).toHaveValue('')
    expect(screen.getByPlaceholderText('unlimited')).toBeInTheDocument()
  })
})
