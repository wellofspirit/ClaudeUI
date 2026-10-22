/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

const { syntaxCheckChunk } = await import('../../../scripts/lib/syntax-check-chunk.mjs')

describe('patched chunk syntax checking', () => {
  it('parses ESM without resolving absent imports or evaluating top-level code', () => {
    expect(
      syntaxCheckChunk(
        Buffer.from(`
        import missing from 'claudeui-nonexistent-syntax-check-package';
        export { other } from '/nonexistent/claudeui-syntax-check-module.mjs';
        throw new Error('must not execute');
        await Promise.reject(new Error('must not execute either'));
        export default missing;
      `)
      )
    ).toBeNull()
  })

  it('accepts independent chunks with colliding module bindings', () => {
    for (const value of [1, 2]) {
      expect(
        syntaxCheckChunk(Buffer.from(`const binding = ${value}; export { binding };`))
      ).toBeNull()
    }
  })

  it('fails closed with parser diagnostics for malformed JavaScript', () => {
    expect(syntaxCheckChunk(Buffer.from('export const value = ;'))).toMatch(/SyntaxError/)
  })

  it('rejects an unbound ESM export', () => {
    expect(syntaxCheckChunk(Buffer.from('export { undefinedBinding };'))).toMatch(
      /Export 'undefinedBinding' is not defined/
    )
  })
})
