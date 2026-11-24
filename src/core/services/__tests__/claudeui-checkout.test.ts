/**
 * @vitest-environment node
 *
 * The rebuild source an admin types (`app-update:set-source`): an absolute
 * path to a ClaudeUI checkout, resolved; the reasons name no path.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { checkSourcePath, isClaudeUiCheckout } from '../claudeui-checkout'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeui-checkout-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function checkout(name: string, pkgName = 'claudui'): string {
  const dir = path.join(root, name)
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkgName }))
  fs.writeFileSync(path.join(dir, 'scripts', 'build.mjs'), '')
  return dir
}

describe('checkSourcePath', () => {
  it('accepts an absolute checkout, trimmed and resolved', () => {
    const dir = checkout('ClaudeUI')
    expect(checkSourcePath(`  ${dir}${path.sep}.${path.sep}  `)).toEqual({ ok: true, path: dir })
    expect(isClaudeUiCheckout(dir)).toBe(true)
  })

  it('refuses an empty, a relative and a non-checkout path, naming no path', () => {
    const other = checkout('other', 'something-else')
    const cases: Array<[string, RegExp]> = [
      ['   ', /Enter the folder/],
      ['relative/ClaudeUI', /must be absolute/],
      [other, /Not a ClaudeUI checkout/],
      [path.join(root, 'missing'), /Not a ClaudeUI checkout/]
    ]
    for (const [raw, reason] of cases) {
      const result = checkSourcePath(raw)
      expect(result.ok, raw).toBe(false)
      if (!result.ok) {
        expect(result.reason).toMatch(reason)
        expect(result.reason).not.toContain(root)
      }
    }
  })

  it('takes the checkout rule it is given', () => {
    expect(checkSourcePath(path.join(root, 'x'), () => true)).toEqual({
      ok: true,
      path: path.join(root, 'x')
    })
  })
})
