/**
 * @vitest-environment node
 *
 * Contract test for the `vendor/claude-cli/cli.js` chunk-concat header
 * (`scripts/lib/chunk-format.mjs`), shared by extract-cli, apply-all and
 * rebundle-cli.
 *
 * Why this exists: the 2.1.261 bump shipped a guard that matched
 * `// @bun-chunk B:` — the Windows-only spelling of Bun's standalone FS root.
 * Extraction and all 14 patches succeeded on macOS and Linux, where the same
 * modules are named `/$bunfs/root/…`, and only the guard failed, red-lighting
 * every non-Windows job. The prefix is host-specific; the delimiter is not.
 */

import { describe, it, expect } from 'vitest'

const mod: any = await import('../../../scripts/lib/chunk-format.mjs')
const { isChunkConcat, CHUNK_DELIM_PREFIX, CHUNK_DELIM_RE } = mod

const header = (name: string) => Buffer.from(`// @bun-chunk ${name}\nconst a=1;\n`, 'latin1')

describe('chunk-concat header', () => {
  it('accepts the win32 module namespace', () => {
    expect(isChunkConcat(header('B:/~BUN/root/chunk-w7xy78n9.js'))).toBe(true)
  })

  it('accepts the macOS/Linux module namespace', () => {
    expect(isChunkConcat(header('/$bunfs/root/chunk-6ja9qp17.js'))).toBe(true)
    expect(isChunkConcat(header('/$bunfs/root/cli'))).toBe(true)
  })

  it('rejects the pre-2.1.261 monolith header', () => {
    expect(isChunkConcat(Buffer.from('// @bun @bytecode\nvar x=1;\n', 'latin1'))).toBe(false)
  })

  it('rejects a delimiter with no module name', () => {
    expect(isChunkConcat(Buffer.from('// @bun-chunk \n', 'latin1'))).toBe(false)
  })

  it('rejects a file whose header a patch clobbered', () => {
    expect(isChunkConcat(Buffer.from('/*PATCHED:foo*/// @bun-chunk B:/x\n', 'latin1'))).toBe(false)
  })

  it('splits on the delimiter regardless of namespace', () => {
    const file = [
      '// @bun-chunk B:/~BUN/root/a.js',
      'const a=1;',
      '// @bun-chunk /$bunfs/root/b.js',
      'const b=2;',
      ''
    ].join('\n')
    CHUNK_DELIM_RE.lastIndex = 0
    expect([...file.matchAll(CHUNK_DELIM_RE)].map((m) => m[1])).toEqual([
      'B:/~BUN/root/a.js',
      '/$bunfs/root/b.js'
    ])
  })

  it('exports the delimiter the concat is built from', () => {
    expect(CHUNK_DELIM_PREFIX).toBe('// @bun-chunk ')
  })
})
