/**
 * @vitest-environment node
 *
 * Guard: the renderer must contain ZERO native `<select>` elements.
 *
 * A native option list is painted by the OS with UA colors, so under a dark
 * theme (Monokai especially) the inherited light-on-dark text is unreadable —
 * the defect that pushed the judge-model picker onto `ModelPicker` in 8bc26d7
 * and then the whole renderer onto `ModelPicker` / `SelectMenu`. Nothing in the
 * type system stops the next contributor from reaching for `<select>` again, so
 * the invariant is enforced as a static SOURCE scan (same technique as
 * `src/main/ipc/__tests__/remote-channel-parity.test.ts`).
 *
 * Fix, when this fails: use `SelectMenu` (src/renderer/src/components/shared/
 * SelectMenu.tsx) for a generic choice, or `ModelPicker` when the choice is a
 * model. Do NOT add an exemption.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const RENDERER = path.join(process.cwd(), 'src', 'renderer')

/** Every renderer source file that ships to the app (tests excluded). */
function shippedSources(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue
        walk(full)
      } else if (/\.(tsx|ts|jsx|js)$/.test(entry.name) && !/\.test\.[tj]sx?$/.test(entry.name)) {
        out.push(full)
      }
    }
  }
  walk(RENDERER)
  return out
}

/**
 * Drop comments before matching — the doc comments that explain WHY the native
 * element is banned necessarily spell `<select>` out, and must not read as
 * violations. Everything else (JSX, strings) is left intact.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** `<select` followed by whitespace, `>` or `/` — the element, not `selectMenu`. */
const SELECT_ELEMENT = /<select[\s>/]/

describe('renderer has no native <select>', () => {
  it('the scan actually reads the renderer tree (non-vacuity)', () => {
    const files = shippedSources()
    expect(files.length).toBeGreaterThan(50)
    // Anchor on a file known to render a themed dropdown where a native select
    // used to be — if the walk silently returned the wrong tree, this fails.
    const selectMenu = files.find((f) => f.endsWith(path.join('shared', 'SelectMenu.tsx')))
    expect(selectMenu).toBeTruthy()
    expect(fs.readFileSync(selectMenu!, 'utf-8')).toContain('role="listbox"')
  })

  it('the detector actually detects (non-vacuity)', () => {
    expect(SELECT_ELEMENT.test(stripComments('  <select value={x}>'))).toBe(true)
    expect(SELECT_ELEMENT.test(stripComments('  <select>'))).toBe(true)
    // …and does not fire on the prose that explains the ban, or on identifiers.
    expect(SELECT_ELEMENT.test(stripComments('// not a native <select> here'))).toBe(false)
    expect(SELECT_ELEMENT.test(stripComments('/* a <select> in a doc block */'))).toBe(false)
    expect(SELECT_ELEMENT.test(stripComments('<SelectMenu value={x} />'))).toBe(false)
  })

  it('no shipped renderer source opens a <select> element', () => {
    const offenders = shippedSources()
      .filter((f) => SELECT_ELEMENT.test(stripComments(fs.readFileSync(f, 'utf-8'))))
      .map((f) => path.relative(process.cwd(), f))
    expect(offenders).toEqual([])
  })
})
