import { describe, it, expect } from 'vitest'
import { OpencodeSessionAllows } from '../session-allows'

describe('OpencodeSessionAllows (ADR-085 S2)', () => {
  it('covers a single-pattern ask by a stored arity prefix', () => {
    const allows = new OpencodeSessionAllows()
    allows.add('bash', ['git push *'])
    expect(allows.covers('bash', ['git push origin feat'], 'linux')).toBe(true)
    // `" *"` also matches the bare prefix (opencode's Wildcard.match).
    expect(allows.covers('bash', ['git push'], 'linux')).toBe(true)
    expect(allows.covers('bash', ['git pull origin main'], 'linux')).toBe(false)
  })

  it('a two-statement ask is covered only when BOTH statements match', () => {
    const allows = new OpencodeSessionAllows()
    allows.add('bash', ['git push *'])
    expect(allows.covers('bash', ['git push origin a', 'rm -rf dist'], 'linux')).toBe(false)
    allows.add('bash', ['rm *'])
    expect(allows.covers('bash', ['git push origin a', 'rm -rf dist'], 'linux')).toBe(true)
  })

  it('a multi-pattern add stores each pattern', () => {
    const allows = new OpencodeSessionAllows()
    allows.add('bash', ['git push *', 'npm test *'])
    expect(allows.size).toBe(2)
    expect(allows.covers('bash', ['npm test --watch'], 'linux')).toBe(true)
    expect(allows.covers('bash', ['git push origin x', 'npm test'], 'linux')).toBe(true)
    // The same pattern twice is one entry.
    allows.add('bash', ['git push *'])
    expect(allows.size).toBe(2)
  })

  it('an absent / empty patterns list means `*`', () => {
    const allows = new OpencodeSessionAllows()
    allows.add('webfetch', ['https://example.com/*'])
    // `*` is not matched by a narrower stored pattern…
    expect(allows.covers('webfetch', undefined, 'linux')).toBe(false)
    expect(allows.covers('webfetch', [], 'linux')).toBe(false)
    // …but is by the `["*"]` an edit / webfetch / MCP ask carries as `always`.
    allows.add('edit', ['*'])
    expect(allows.covers('edit', undefined, 'linux')).toBe(true)
    expect(allows.covers('edit', [], 'linux')).toBe(true)
    expect(allows.covers('edit', ['src/a.ts', '.env'], 'linux')).toBe(true)
  })

  it('matches case-insensitively on win32 only', () => {
    const allows = new OpencodeSessionAllows()
    allows.add('bash', ['git push *'])
    expect(allows.covers('bash', ['GIT PUSH origin x'], 'win32')).toBe(true)
    expect(allows.covers('bash', ['GIT PUSH origin x'], 'linux')).toBe(false)
    expect(allows.covers('BASH', ['git push origin x'], 'win32')).toBe(true)
    expect(allows.covers('BASH', ['git push origin x'], 'linux')).toBe(false)
  })

  it('an empty `always` stores nothing', () => {
    const allows = new OpencodeSessionAllows()
    allows.add('bash', [])
    expect(allows.size).toBe(0)
    expect(allows.covers('bash', ['ls'], 'linux')).toBe(false)
    expect(allows.covers('bash', undefined, 'linux')).toBe(false)
  })

  it('a different permission never covers', () => {
    const allows = new OpencodeSessionAllows()
    allows.add('edit', ['*'])
    expect(allows.covers('bash', ['ls'], 'linux')).toBe(false)
    expect(allows.covers('webfetch', ['https://x.test'], 'linux')).toBe(false)
    expect(allows.covers('external_directory', ['/tmp/*'], 'linux')).toBe(false)
  })
})
