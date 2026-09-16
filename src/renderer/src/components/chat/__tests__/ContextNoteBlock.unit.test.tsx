/**
 * Layer 1 (unit) for `ContextNoteBlock` — Codex `hookPrompt` fragments and pi
 * `custom_message` entries.
 *
 * The rule it carries: a fragment is THIRD-PARTY text (an arbitrary hook
 * script, an extension) and renders verbatim, never through markdown.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { ContextNoteBlock } from '../ContextNoteBlock'
import type { ContentBlock } from '../../../../../shared/types'

type ContextNote = Extract<ContentBlock, { type: 'context_note' }>

const note: ContextNote = {
  type: 'context_note',
  title: 'Injected context',
  fragments: [
    { text: 'Repository policy: never write to files under vendor/.', label: '9f2a' },
    { text: 'The working tree has 3 uncommitted files.', label: '9f2b' }
  ]
}

describe('ContextNoteBlock', () => {
  it('collapses to the title and a fragment count', () => {
    render(<ContextNoteBlock block={note} />)
    expect(screen.getByTestId('ContextNoteBlock').textContent).toContain('Injected context')
    expect(screen.getByTestId('ContextNoteBlock').textContent).toContain('2 fragments')
    expect(screen.queryAllByTestId('ContextNoteBlock.fragment')).toHaveLength(0)
  })

  it('singularises one fragment', () => {
    render(<ContextNoteBlock block={{ ...note, fragments: [note.fragments[0]] }} />)
    expect(screen.getByTestId('ContextNoteBlock').textContent).toContain('1 fragment')
    expect(screen.getByTestId('ContextNoteBlock').textContent).not.toContain('1 fragments')
  })

  it('reveals every fragment verbatim, with its label, on expand', () => {
    render(<ContextNoteBlock block={note} />)
    fireEvent.click(screen.getByTestId('ContextNoteBlock.toggle'))
    const fragments = screen.getAllByTestId('ContextNoteBlock.fragment')
    expect(fragments).toHaveLength(2)
    expect(fragments[0].textContent).toContain('never write to files under vendor/.')
    expect(fragments[0].textContent).toContain('9f2a')
  })

  it('does NOT put a fragment through the markdown pipeline', () => {
    render(
      <ContextNoteBlock
        block={{
          type: 'context_note',
          title: 'my-extension',
          fragments: [{ text: '# heading\n**bold** [link](https://evil.test)' }]
        }}
      />
    )
    fireEvent.click(screen.getByTestId('ContextNoteBlock.toggle'))
    const root = screen.getByTestId('ContextNoteBlock')
    expect(root.querySelector('h1')).toBeNull()
    expect(root.querySelector('strong')).toBeNull()
    expect(root.querySelector('a')).toBeNull()
    expect(root.textContent).toContain('# heading')
    expect(root.textContent).toContain('[link](https://evil.test)')
  })
})
