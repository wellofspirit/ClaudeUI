/**
 * @vitest-environment node
 *
 * `wordsFromTokens` and `addonEntry` — the pure pieces of the sherpa adapter. The real loader
 * needs the addon and a 650 MB model and is exercised by the gated real-model
 * check, not here.
 */

import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { addonEntry, wordsFromTokens } from '../recognizer'

describe('addonEntry', () => {
  let dir: string

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeui-addon-entry-'))
  })
  afterAll(() => {
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name))
    fs.rmdirSync(dir)
  })

  it('is the manifest main, as an absolute file path — a compiled bun executable cannot require a directory', () => {
    const pkg = path.join(dir, 'package.json')
    fs.writeFileSync(pkg, JSON.stringify({ name: 'sherpa-onnx-node', main: 'sherpa-onnx.js' }))

    expect(addonEntry(dir)).toBe(path.join(dir, 'sherpa-onnx.js'))
    fs.unlinkSync(pkg)
  })

  it('never leaves the addon directory: a main that climbs out falls back to index.js', () => {
    const pkg = path.join(dir, 'package.json')
    for (const main of ['../../x.js', '../x.js', path.resolve(dir, '..', 'x.js'), '.', './']) {
      fs.writeFileSync(pkg, JSON.stringify({ main }))
      expect(addonEntry(dir)).toBe(path.join(dir, 'index.js'))
    }
    fs.writeFileSync(pkg, JSON.stringify({ main: './lib/entry.js' }))
    expect(addonEntry(dir)).toBe(path.join(dir, 'lib', 'entry.js'))
    fs.unlinkSync(pkg)
  })

  it('falls back to index.js without a usable manifest, and lets the loader name what is missing', () => {
    expect(addonEntry(path.join(dir, 'nowhere'))).toBe(path.join(dir, 'nowhere', 'index.js'))

    const pkg = path.join(dir, 'package.json')
    fs.writeFileSync(pkg, '{ not json')
    expect(addonEntry(dir)).toBe(path.join(dir, 'index.js'))
    fs.writeFileSync(pkg, JSON.stringify({ main: 42 }))
    expect(addonEntry(dir)).toBe(path.join(dir, 'index.js'))
    fs.unlinkSync(pkg)
  })
})

describe('wordsFromTokens', () => {
  it('a token starting with a space starts a new word; others continue the last', () => {
    const words = wordsFromTokens(
      [' use', 'Stick', 'To', ' bottom'],
      [0.1, 0.4, 0.6, 1.0],
      [0.2, 0.1, 0.1, 0.3]
    )
    expect(words).toHaveLength(2)
    expect(words[0].word).toBe('useStickTo')
    expect(words[0].start).toBeCloseTo(0.1)
    expect(words[0].end).toBeCloseTo(0.7) // the last token's start + duration
    expect(words[1]).toEqual({ word: 'bottom', start: 1.0, end: 1.3 })
  })

  it('the first token starts a word even without a leading space', () => {
    expect(wordsFromTokens(['hi', ' there'], [0, 0.5], [0.2, 0.2]).map((w) => w.word)).toEqual([
      'hi',
      'there'
    ])
  })

  it('a bare-space token ends the word before it without becoming one', () => {
    expect(
      wordsFromTokens(['a', ' ', 'b'], [0, 0.2, 0.4], [0.1, 0.1, 0.1]).map((w) => w.word)
    ).toEqual(['a', 'b'])
  })

  it('without durations a word ends where it starts', () => {
    expect(wordsFromTokens([' a'], [1.5])).toEqual([{ word: 'a', start: 1.5, end: 1.5 }])
  })

  it('no tokens, no words', () => {
    expect(wordsFromTokens([], [])).toEqual([])
  })
})
