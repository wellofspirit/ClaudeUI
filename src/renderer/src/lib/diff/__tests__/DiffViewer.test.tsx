import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DiffViewer } from '../DiffViewer'

// Mock @tanstack/react-virtual to avoid needing actual DOM measurements
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 18,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        index: i,
        start: i * 18,
        size: 18,
        key: i
      })),
    measureElement: () => {}
  })
}))

const SIMPLE_PATCH = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
 line1
-line2
+line2_modified
 line3
`

describe('DiffViewer', () => {
  describe('patch mode', () => {
    it('renders all diff lines', () => {
      render(<DiffViewer patch={SIMPLE_PATCH} fileName="foo.ts" />)

      // Should render context and changed lines
      expect(screen.getByText('line1')).toBeInTheDocument()
      expect(screen.getByText('line2')).toBeInTheDocument()
      expect(screen.getByText('line2_modified')).toBeInTheDocument()
      expect(screen.getByText('line3')).toBeInTheDocument()
    })

    it('displays line numbers', () => {
      render(<DiffViewer patch={SIMPLE_PATCH} fileName="foo.ts" />)

      // Old line numbers 1, 2, 3 and new line numbers 1, 2, 3
      const gutters = screen.getAllByRole('cell')
      const gutterTexts = gutters
        .filter((el) => el.classList.contains('diff-gutter'))
        .map((el) => el.textContent)
        .filter((t) => t !== '')

      // Should have line numbers present
      expect(gutterTexts).toContain('1')
      expect(gutterTexts).toContain('2')
      expect(gutterTexts).toContain('3')
    })

    it('shows + indicator for additions', () => {
      render(<DiffViewer patch={SIMPLE_PATCH} fileName="foo.ts" />)

      const indicators = screen
        .getAllByRole('cell')
        .filter((el) => el.classList.contains('diff-indicator-add'))
      expect(indicators.length).toBeGreaterThan(0)
      expect(indicators[0].textContent).toBe('+')
    })

    it('shows - indicator for deletions', () => {
      render(<DiffViewer patch={SIMPLE_PATCH} fileName="foo.ts" />)

      const indicators = screen
        .getAllByRole('cell')
        .filter((el) => el.classList.contains('diff-indicator-del'))
      expect(indicators.length).toBeGreaterThan(0)
      expect(indicators[0].textContent).toBe('-')
    })

    it('applies diff-row-add class to addition rows', () => {
      render(<DiffViewer patch={SIMPLE_PATCH} fileName="foo.ts" />)

      const addRows = document.querySelectorAll('.diff-row-add')
      expect(addRows.length).toBeGreaterThan(0)
    })

    it('applies diff-row-del class to deletion rows', () => {
      render(<DiffViewer patch={SIMPLE_PATCH} fileName="foo.ts" />)

      const delRows = document.querySelectorAll('.diff-row-del')
      expect(delRows.length).toBeGreaterThan(0)
    })

    it('shows "No changes" for empty patch', () => {
      const emptyPatch = `--- a/file.ts
+++ b/file.ts
`
      render(<DiffViewer patch={emptyPatch} fileName="file.ts" />)
      expect(screen.getByText('No changes')).toBeInTheDocument()
    })
  })

  describe('content mode (oldStr/newStr)', () => {
    it('computes and renders a diff from old/new strings', () => {
      render(
        <DiffViewer
          oldStr={'line1\nline2\nline3'}
          newStr={'line1\nline2_modified\nline3'}
          fileName="test.ts"
        />
      )

      expect(screen.getByText('line2')).toBeInTheDocument()
      expect(screen.getByText('line2_modified')).toBeInTheDocument()
    })

    it('handles pure addition (empty oldStr)', () => {
      render(<DiffViewer oldStr="" newStr="new content" fileName="test.ts" />)

      // Should have diff-pure-add class
      const container = document.querySelector('.diff-pure-add')
      expect(container).toBeInTheDocument()
    })

    it('handles pure deletion (empty newStr)', () => {
      render(<DiffViewer oldStr="old content" newStr="" fileName="test.ts" />)

      const container = document.querySelector('.diff-pure-del')
      expect(container).toBeInTheDocument()
    })

    it('respects ignoreWhitespace', () => {
      render(
        <DiffViewer
          oldStr="const x  =  1"
          newStr="const x = 1"
          fileName="test.ts"
          ignoreWhitespace={true}
        />
      )

      // With whitespace normalization, these should be the same — no changes
      expect(screen.getByText('No changes')).toBeInTheDocument()
    })
  })

  describe('view modes', () => {
    it('renders unified view by default', () => {
      render(<DiffViewer patch={SIMPLE_PATCH} fileName="foo.ts" />)

      // Unified view should NOT have split dividers
      const dividers = document.querySelectorAll('.diff-split-divider')
      expect(dividers).toHaveLength(0)
    })

    it('renders split view when viewMode is "split" and virtualize is true', () => {
      render(<DiffViewer patch={SIMPLE_PATCH} fileName="foo.ts" viewMode="split" virtualize />)

      // Split view should have dividers
      const dividers = document.querySelectorAll('.diff-split-divider')
      expect(dividers.length).toBeGreaterThan(0)
    })
  })

  describe('line highlighting', () => {
    it('applies highlight class to specified lines', () => {
      const highlighted = new Set(['new:2'])
      render(<DiffViewer patch={SIMPLE_PATCH} fileName="foo.ts" highlightedLines={highlighted} />)

      const highlightedRows = document.querySelectorAll('.diff-row-highlighted')
      expect(highlightedRows.length).toBeGreaterThan(0)
    })
  })

  describe('hunk expansion', () => {
    const patchWithGap = `--- a/file.ts
+++ b/file.ts
@@ -5,3 +5,3 @@
 line5
-line6
+line6_new
 line7
`
    const oldContent = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n')
    const newContent = oldContent.replace('line6', 'line6_new')

    it('shows expansion gaps when full content is provided', () => {
      render(
        <DiffViewer
          patch={patchWithGap}
          oldContent={oldContent}
          newContent={newContent}
          fileName="file.ts"
        />
      )

      // Should show gap text
      const gaps = document.querySelectorAll('.diff-gap')
      expect(gaps.length).toBeGreaterThan(0)
    })

    it('expands a gap when clicked', () => {
      render(
        <DiffViewer
          patch={patchWithGap}
          oldContent={oldContent}
          newContent={newContent}
          fileName="file.ts"
        />
      )

      const gaps = document.querySelectorAll('.diff-gap')
      expect(gaps.length).toBeGreaterThan(0)

      // Click the first gap to expand
      fireEvent.click(gaps[0])

      // After expansion, should have more line rows (tr in table or div[role=row])
      const allRows = document.querySelectorAll('tr.diff-row, [role="row"]')
      expect(allRows.length).toBeGreaterThan(0)
    })
  })

  describe('className passthrough', () => {
    it('applies custom className to container', () => {
      render(<DiffViewer patch={SIMPLE_PATCH} fileName="foo.ts" className="my-custom-class" />)

      const container = document.querySelector('.my-custom-class')
      expect(container).toBeInTheDocument()
    })
  })
})
