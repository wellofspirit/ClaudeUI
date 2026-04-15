/**
 * Layer 1: Unit tests for pure utility functions in useTextSelectionComment.ts.
 *
 * Tests normalizeForMatching and deduceLineNumbers — both are pure functions
 * that strip markdown syntax and map selected text to line numbers in raw
 * markdown source. No DOM, no React hooks, no IPC.
 */

import { describe, it, expect } from 'vitest'
import {
  normalizeForMatching,
  deduceLineNumbers,
} from '../../../hooks/useTextSelectionComment'

// ---------------------------------------------------------------------------
// normalizeForMatching
// ---------------------------------------------------------------------------

describe('normalizeForMatching', () => {
  it('normalizeForMatching_boldDoubleStar_stripsAsterisks', () => {
    expect(normalizeForMatching('**bold**')).toBe('bold')
  })

  it('normalizeForMatching_italicSingleStar_stripsAsterisks', () => {
    expect(normalizeForMatching('*italic*')).toBe('italic')
  })

  it('normalizeForMatching_boldDoubleUnderscore_stripsUnderscores', () => {
    expect(normalizeForMatching('__bold__')).toBe('bold')
  })

  it('normalizeForMatching_italicSingleUnderscore_stripsUnderscores', () => {
    expect(normalizeForMatching('_italic_')).toBe('italic')
  })

  it('normalizeForMatching_strikethrough_stripsTildes', () => {
    expect(normalizeForMatching('~~strike~~')).toBe('strike')
  })

  it('normalizeForMatching_inlineCode_stripsBackticks', () => {
    expect(normalizeForMatching('`code`')).toBe('code')
  })

  it('normalizeForMatching_h1Heading_stripsHashPrefix', () => {
    expect(normalizeForMatching('# Heading')).toBe('Heading')
  })

  it('normalizeForMatching_h2Heading_stripsHashPrefix', () => {
    expect(normalizeForMatching('## Sub heading')).toBe('Sub heading')
  })

  it('normalizeForMatching_h6Heading_stripsAllHashes', () => {
    expect(normalizeForMatching('###### Deep')).toBe('Deep')
  })

  it('normalizeForMatching_unorderedListItemDash_stripsPrefix', () => {
    expect(normalizeForMatching('- list item')).toBe('list item')
  })

  it('normalizeForMatching_unorderedListItemStar_stripsPrefix', () => {
    expect(normalizeForMatching('* list item')).toBe('list item')
  })

  it('normalizeForMatching_orderedListItem_stripsNumberAndDot', () => {
    expect(normalizeForMatching('1. ordered item')).toBe('ordered item')
  })

  it('normalizeForMatching_orderedListHighNumber_stripsNumberAndDot', () => {
    expect(normalizeForMatching('10. tenth item')).toBe('tenth item')
  })

  it('normalizeForMatching_markdownLink_keepsLinkTextOnly', () => {
    expect(normalizeForMatching('[link text](https://example.com)')).toBe('link text')
  })

  it('normalizeForMatching_mixedBoldAndItalic_stripsAll', () => {
    expect(normalizeForMatching('**bold** and *italic*')).toBe('bold and italic')
  })

  it('normalizeForMatching_mixedCodeAndBold_stripsAll', () => {
    expect(normalizeForMatching('use `code` and **bold** here')).toBe('use code and bold here')
  })

  it('normalizeForMatching_excessiveWhitespace_collapsedToSingleSpaces', () => {
    expect(normalizeForMatching('  hello   world  ')).toBe('hello world')
  })

  it('normalizeForMatching_plainText_returnsUnchanged', () => {
    expect(normalizeForMatching('just plain text')).toBe('just plain text')
  })

  it('normalizeForMatching_emptyString_returnsEmpty', () => {
    expect(normalizeForMatching('')).toBe('')
  })

  it('normalizeForMatching_headingWithLeadingIndent_stripsHashesAfterNormalization', () => {
    // The heading regex uses ^ with /gm which matches start of line
    expect(normalizeForMatching('### Three')).toBe('Three')
  })
})

// ---------------------------------------------------------------------------
// deduceLineNumbers
// ---------------------------------------------------------------------------

describe('deduceLineNumbers', () => {
  it('deduceLineNumbers_singleLineMatchOnThirdLine_returnsBothAsThree', () => {
    const planContent = 'line one\nline two\nline three'
    const result = deduceLineNumbers('line three', planContent)
    expect(result).toEqual({ lineNumber: 3, endLineNumber: 3 })
  })

  it('deduceLineNumbers_singleLineMatchOnFirstLine_returnsBothAsOne', () => {
    const planContent = 'alpha\nbeta\ngamma'
    const result = deduceLineNumbers('alpha', planContent)
    expect(result).toEqual({ lineNumber: 1, endLineNumber: 1 })
  })

  it('deduceLineNumbers_singleLineMatchOnSecondLine_returnsBothAsTwo', () => {
    const planContent = 'line one\nline two\nline three'
    const result = deduceLineNumbers('line two', planContent)
    expect(result).toEqual({ lineNumber: 2, endLineNumber: 2 })
  })

  it('deduceLineNumbers_multiLineMatch_returnsCorrectStartAndEnd', () => {
    // "alpha beta" spans lines 1 and 2 in the normalized content stream
    const planContent = 'alpha\nbeta\ngamma'
    const result = deduceLineNumbers('alpha beta', planContent)
    expect(result).toEqual({ lineNumber: 1, endLineNumber: 2 })
  })

  it('deduceLineNumbers_threeLineMatch_returnsCorrectRange', () => {
    const planContent = 'first\nsecond\nthird\nfourth'
    // "first second third" spans lines 1–3
    const result = deduceLineNumbers('first second third', planContent)
    expect(result).toEqual({ lineNumber: 1, endLineNumber: 3 })
  })

  it('deduceLineNumbers_noMatch_fallsBackToLineOneOne', () => {
    const planContent = 'hello world\nfoo bar'
    const result = deduceLineNumbers('completely absent text', planContent)
    expect(result).toEqual({ lineNumber: 1, endLineNumber: 1 })
  })

  it('deduceLineNumbers_emptySelection_fallsBackToLineOneOne', () => {
    const planContent = 'hello\nworld'
    const result = deduceLineNumbers('', planContent)
    expect(result).toEqual({ lineNumber: 1, endLineNumber: 1 })
  })

  it('deduceLineNumbers_markdownInContent_matchesViaNormalization', () => {
    // Content has markdown; selected text is the rendered (plain) version
    const planContent = '## Setup Steps\n**Install** the dependencies\nRun the tests'
    // Rendered: "Setup Steps" maps to line 1
    const result = deduceLineNumbers('Setup Steps', planContent)
    expect(result).toEqual({ lineNumber: 1, endLineNumber: 1 })
  })

  it('deduceLineNumbers_boldTextSelected_stripsMarkdownForMatching', () => {
    const planContent = 'Introduction\n**Important note** about the task\nConclusion'
    // User selected the rendered bold text "Important note about the task"
    const result = deduceLineNumbers('Important note about the task', planContent)
    expect(result).toEqual({ lineNumber: 2, endLineNumber: 2 })
  })

  it('deduceLineNumbers_matchOnLastLine_returnsLastLineNumber', () => {
    const planContent = 'step one\nstep two\nstep three'
    const result = deduceLineNumbers('step three', planContent)
    expect(result).toEqual({ lineNumber: 3, endLineNumber: 3 })
  })

  it('deduceLineNumbers_emptyPlanContent_fallsBackToLineOneOne', () => {
    const result = deduceLineNumbers('anything', '')
    expect(result).toEqual({ lineNumber: 1, endLineNumber: 1 })
  })
})
