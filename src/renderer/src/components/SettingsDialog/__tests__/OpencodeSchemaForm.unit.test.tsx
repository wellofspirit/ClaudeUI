/**
 * Layer 1: Unit tests for OpencodeSchemaForm.
 *
 * The generic schema-driven form must render each shape (boolean/string/enum/
 * Record), fall back to a raw-JSON leaf editor for unions, and surface unknown
 * value keys as read-only "unmanaged" rows — never crashing on an unknown shape.
 */

import { useState } from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  OpencodeSchemaForm,
  detectKind,
  type SchemaNode,
  type SchemaDefs
} from '../OpencodeSchemaForm'
import { selectMenuOptionValues } from '../../../../../test/helpers/select-menu'

const miniSchema: SchemaNode = {
  type: 'object',
  properties: {
    flag: { type: 'boolean', description: 'A boolean flag' },
    label: { type: 'string' },
    level: { type: 'string', enum: ['low', 'high'] },
    tags: { type: 'object', additionalProperties: { type: 'boolean' } },
    weird: { anyOf: [{ type: 'boolean' }, { type: 'string' }] }
  }
}
const defs: SchemaDefs = {}

function Harness({ initial }: { initial: Record<string, unknown> }): React.JSX.Element {
  const [value, setValue] = useState<Record<string, unknown>>(initial)
  return <OpencodeSchemaForm schema={miniSchema} defs={defs} value={value} onChange={setValue} />
}

describe('detectKind', () => {
  it('classifies primitives, enums, arrays, records, and unions', () => {
    expect(detectKind({ type: 'boolean' }, defs)).toBe('boolean')
    expect(detectKind({ type: 'string' }, defs)).toBe('string')
    expect(detectKind({ type: 'integer' }, defs)).toBe('number')
    expect(detectKind({ type: 'string', enum: ['a'] }, defs)).toBe('enum')
    expect(detectKind({ type: 'array', items: { type: 'string' } }, defs)).toBe('stringArray')
    expect(detectKind({ type: 'array', items: { type: 'string', enum: ['x'] } }, defs)).toBe(
      'enumArray'
    )
    expect(detectKind({ type: 'object', additionalProperties: { type: 'boolean' } }, defs)).toBe(
      'record'
    )
    expect(detectKind({ anyOf: [{ type: 'string' }] }, defs)).toBe('raw')
    expect(detectKind({ type: 'object', additionalProperties: false }, defs)).toBe('raw')
  })
})

describe('OpencodeSchemaForm rendering', () => {
  it('renders boolean, string, enum, record, and union (raw) controls', () => {
    render(<Harness initial={{}} />)
    expect(screen.getByTestId('OpencodeSchemaForm')).toBeInTheDocument()
    expect(screen.getByTestId('OpencodeSchemaForm.bool')).toBeInTheDocument()
    expect(screen.getByTestId('OpencodeSchemaForm.text')).toBeInTheDocument()
    const enumField = screen.getByTestId('OpencodeSchemaForm.enum')
    // Themed SelectMenu, never a native <select>; `data-id` still discriminates
    // the schema key on the root (ADR-027 repeated-instance convention).
    expect(enumField.querySelector('select')).toBeNull()
    expect(enumField).toHaveAttribute('data-id', 'level')
    expect(selectMenuOptionValues(enumField)).toEqual(['', 'low', 'high'])
    expect(screen.getByTestId('OpencodeSchemaForm.record')).toBeInTheDocument()
    // Union (anyOf) → raw-JSON leaf editor escape hatch.
    expect(screen.getByTestId('OpencodeSchemaForm.rawJson')).toBeInTheDocument()
  })

  it('shows unknown value keys as read-only unmanaged rows (never dropped)', () => {
    render(<Harness initial={{ mysteryKey: { deep: 1 } }} />)
    const row = screen.getByTestId('OpencodeSchemaForm.unmanaged')
    expect(row).toHaveAttribute('data-id', 'mysteryKey')
    expect(row.textContent).toContain('mysteryKey')
    expect(row.textContent).toContain('unmanaged')
  })

  it('toggling a boolean updates the value', () => {
    render(<Harness initial={{}} />)
    const toggle = screen.getByTestId('OpencodeSchemaForm.bool')
    // The toggle track (2nd span) carries the muted background while off.
    const track = () => toggle.querySelectorAll('span')[1]
    expect(track().className).toContain('bg-text-muted')
    fireEvent.click(toggle)
    // After toggling, the controlled state flips the track to the accent colour.
    expect(track().className).toContain('bg-accent')
  })

  it('editing a string field updates the value', () => {
    render(<Harness initial={{}} />)
    const input = screen.getByTestId('OpencodeSchemaForm.text') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'hello' } })
    expect(input.value).toBe('hello')
  })

  it('adds a Record entry via the add button', () => {
    render(<Harness initial={{}} />)
    expect(screen.queryByTestId('OpencodeSchemaForm.recordRow')).toBeNull()
    fireEvent.click(screen.getByTestId('OpencodeSchemaForm.recordAdd'))
    expect(screen.getByTestId('OpencodeSchemaForm.recordRow')).toBeInTheDocument()
  })
})

describe('Record key editing (draft state, commit on blur)', () => {
  it('typing multiple characters keeps the draft — the rename only commits on blur', () => {
    render(<Harness initial={{ tags: { old: true } }} />)
    const keyInput = screen.getByTestId('OpencodeSchemaForm.recordKey') as HTMLInputElement

    // Type character by character; the value must accumulate (no remount/reset
    // between keystrokes) and the committed record key must stay 'old'.
    fireEvent.change(keyInput, { target: { value: 'n' } })
    fireEvent.change(keyInput, { target: { value: 'ne' } })
    fireEvent.change(keyInput, { target: { value: 'new' } })
    expect(keyInput.value).toBe('new')
    expect(screen.getByTestId('OpencodeSchemaForm.recordRow')).toHaveAttribute('data-id', 'old')

    // Blur commits: the row identity becomes 'new'.
    fireEvent.blur(keyInput)
    expect(screen.getByTestId('OpencodeSchemaForm.recordRow')).toHaveAttribute('data-id', 'new')
    expect((screen.getByTestId('OpencodeSchemaForm.recordKey') as HTMLInputElement).value).toBe(
      'new'
    )
  })

  it('Enter commits the rename like blur does', () => {
    render(<Harness initial={{ tags: { old: true } }} />)
    const keyInput = screen.getByTestId('OpencodeSchemaForm.recordKey') as HTMLInputElement
    fireEvent.change(keyInput, { target: { value: 'renamed' } })
    fireEvent.keyDown(keyInput, { key: 'Enter' })
    expect(screen.getByTestId('OpencodeSchemaForm.recordRow')).toHaveAttribute('data-id', 'renamed')
  })

  it('renaming onto an existing key is rejected with an inline error, not overwritten', () => {
    render(<Harness initial={{ tags: { a: true, b: false } }} />)
    const rows = screen.getAllByTestId('OpencodeSchemaForm.recordRow')
    expect(rows.map((r) => r.getAttribute('data-id'))).toEqual(['a', 'b'])

    const aKeyInput = screen
      .getAllByTestId('OpencodeSchemaForm.recordKey')
      .find((el) => el.getAttribute('data-id') === 'a') as HTMLInputElement
    fireEvent.change(aKeyInput, { target: { value: 'b' } })
    fireEvent.blur(aKeyInput)

    // Both entries survive — no silent overwrite — and the error shows.
    const after = screen.getAllByTestId('OpencodeSchemaForm.recordRow')
    expect(after.map((r) => r.getAttribute('data-id'))).toEqual(['a', 'b'])
    expect(screen.getByTestId('OpencodeSchemaForm.recordKeyError').textContent).toContain(
      'duplicate key'
    )
    // The rejected draft is kept in the input so the user can fix it.
    expect(aKeyInput.value).toBe('b')
  })

  it('blurring with an unchanged or empty draft is a no-op (draft snaps back)', () => {
    render(<Harness initial={{ tags: { keep: true } }} />)
    const keyInput = screen.getByTestId('OpencodeSchemaForm.recordKey') as HTMLInputElement
    fireEvent.change(keyInput, { target: { value: '' } })
    fireEvent.blur(keyInput)
    expect(screen.getByTestId('OpencodeSchemaForm.recordRow')).toHaveAttribute('data-id', 'keep')
    expect(keyInput.value).toBe('keep')
    expect(screen.queryByTestId('OpencodeSchemaForm.recordKeyError')).toBeNull()
  })
})
