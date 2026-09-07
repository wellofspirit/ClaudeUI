/**
 * Layer 1: shared settings controls.
 *
 * Two things are guarded here.
 *
 * `SettingRow` is the one row vocabulary (ADR-065): every setting in the dialog
 * is drawn through it, so its label/description/chip/badge/dot/reset/error
 * anatomy and the legacy wrappers' preserved APIs are contract, not detail. The
 * contrast fix in particular — a description is 12px `text-text-secondary`, not
 * 10px `text-text-muted/60` — is the reason the redesign happened, and a
 * regression there is invisible in a screenshot on a good monitor.
 *
 * `InfoTooltip` is retired for settings rows but still exported, and it grew a
 * touch affordance: a phone has no hover, so the ⓘ is tappable. Desktop hover
 * must be untouched, and the tap must not leak into whatever it is embedded in.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import {
  InfoTooltip,
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

  it('renders the engine chip, the applies-later badge and the changed dot', () => {
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
    expect(screen.getByTestId('SettingRow.modified')).toBeInTheDocument()
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
    render(<SettingRow testid="MyRow" dataId="x" label="A" modified appliesOn="next-session" />)
    expect(screen.getByTestId('MyRow')).toHaveAttribute('data-id', 'x')
    expect(screen.getByTestId('MyRow.modified')).toBeInTheDocument()
    expect(screen.getByTestId('MyRow.badge')).toBeInTheDocument()
    expect(screen.queryByTestId('SettingRow')).not.toBeInTheDocument()
  })

  it('an explanatory row has no label and no control', () => {
    render(<SettingRow description="Nothing to configure." dimmed />)
    expect(screen.getByTestId('SettingRow')).toHaveTextContent('Nothing to configure.')
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

/**
 * One tap, as a real touch browser reports it.
 *
 * Android Chrome and iOS Safari synthesize a mouse sequence after the touch
 * one, INCLUDING a `mouseenter` — and never a matching `mouseleave`, because
 * the finger has left. Simulating only `click` would test a device that does
 * not exist and would miss the stuck-open bug entirely.
 */
function deviceTap(el: Element): void {
  fireEvent.pointerEnter(el, { pointerType: 'touch' })
  fireEvent.pointerDown(el, { pointerType: 'touch' })
  fireEvent.pointerUp(el, { pointerType: 'touch' })
  fireEvent.mouseEnter(el) // synthesized; no mouseleave will ever follow
  fireEvent.click(el)
}

describe('InfoTooltip', () => {
  it('is closed until something asks for it', () => {
    render(<InfoTooltip text="the explanation" />)
    expect(screen.queryByTestId('InfoTooltip.popover')).not.toBeInTheDocument()
  })

  it('opens on hover and closes on leave (desktop, unchanged)', () => {
    render(<InfoTooltip text="the explanation" />)
    const root = screen.getByTestId('InfoTooltip')

    fireEvent.mouseEnter(root)
    expect(screen.getByTestId('InfoTooltip.popover')).toHaveTextContent('the explanation')

    fireEvent.mouseLeave(root)
    expect(screen.queryByTestId('InfoTooltip.popover')).not.toBeInTheDocument()
  })

  it('a tap pins it open, and a second tap closes it — on a browser that fakes hover', () => {
    render(<InfoTooltip text="the explanation" />)
    const toggle = screen.getByTestId('InfoTooltip.toggle')

    deviceTap(toggle)
    expect(screen.getByTestId('InfoTooltip.popover')).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    // The second tap must actually CLOSE it. Two things have to hold: the
    // outside-tap dismiss must ignore pointerdowns inside the tooltip (or it
    // would cancel the toggle out), and the synthesized `mouseenter` must not
    // have latched `hovered` (or the popover would stay up on a phantom hover
    // that no `mouseleave` will ever clear).
    deviceTap(toggle)
    expect(screen.queryByTestId('InfoTooltip.popover')).not.toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('a tap never latches hover, so nothing is left stuck open', () => {
    render(<InfoTooltip text="the explanation" />)
    const toggle = screen.getByTestId('InfoTooltip.toggle')
    deviceTap(toggle)
    deviceTap(toggle)
    // A mouseleave would never arrive on a phone; assert the popover is already
    // gone without one.
    expect(screen.queryByTestId('InfoTooltip.popover')).not.toBeInTheDocument()
  })

  it('a real mouse still hovers after a touch interaction on the same element', () => {
    render(<InfoTooltip text="the explanation" />)
    const root = screen.getByTestId('InfoTooltip')
    deviceTap(screen.getByTestId('InfoTooltip.toggle'))
    deviceTap(screen.getByTestId('InfoTooltip.toggle')) // back to closed

    // Hybrid device (a Surface, a phone with a mouse): a genuine mouse pointer
    // must not be permanently locked out by the earlier taps.
    fireEvent.pointerEnter(root, { pointerType: 'mouse' })
    fireEvent.mouseEnter(root)
    expect(screen.getByTestId('InfoTooltip.popover')).toBeInTheDocument()
  })

  it('a pinned popover survives the pointer leaving (no hover on touch)', () => {
    render(<InfoTooltip text="the explanation" />)
    deviceTap(screen.getByTestId('InfoTooltip.toggle'))
    fireEvent.mouseLeave(screen.getByTestId('InfoTooltip'))
    expect(screen.getByTestId('InfoTooltip.popover')).toBeInTheDocument()
  })

  it('a tap outside dismisses it', () => {
    render(
      <div>
        <InfoTooltip text="the explanation" />
        <button data-testid="elsewhere">elsewhere</button>
      </div>
    )
    fireEvent.click(screen.getByTestId('InfoTooltip.toggle'))
    expect(screen.getByTestId('InfoTooltip.popover')).toBeInTheDocument()

    fireEvent.pointerDown(screen.getByTestId('elsewhere'))
    expect(screen.queryByTestId('InfoTooltip.popover')).not.toBeInTheDocument()
  })

  it('the popover itself is inert — taps fall through to the content behind it', () => {
    render(<InfoTooltip text="the explanation" />)
    fireEvent.click(screen.getByTestId('InfoTooltip.toggle'))
    // Deliberate: the popover is a read-only hint, so it must never swallow a
    // tap aimed at the setting underneath it.
    expect(screen.getByTestId('InfoTooltip.popover')).toHaveClass('pointer-events-none')
  })
})
