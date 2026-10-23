import { describe, expect, it, type Assertion } from 'vitest'

describe('jsdom matcher registration', () => {
  it('retains browser text matcher call signatures in the shared type program', () => {
    const browserSignatures = (assertion: Assertion<Promise<void>, HTMLElement>): void => {
      void assertion.toHaveTextContent('text')
      void assertion.toHaveTextContent(123)
      void assertion.toHaveTextContent()
    }
    expect(browserSignatures).toBeTypeOf('function')
  })

  it('preserves regex matching, negation and whitespace normalization', () => {
    const element = document.createElement('div')
    element.textContent = '  Stored\n credential  '
    expect(element).toHaveTextContent(/^Stored credential$/)
    expect(element).not.toHaveTextContent(/rejected/i)
    expect(() => expect(element).toHaveTextContent(/^credential$/)).toThrow()
    expect(element).toHaveTextContent(/^ {2}Stored\n credential {2}$/, {
      normalizeWhitespace: false
    })
    expect(element).toHaveTextContent('Stored credential')
  })
})
