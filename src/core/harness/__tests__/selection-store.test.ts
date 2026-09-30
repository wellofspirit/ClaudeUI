/**
 * @vitest-environment node
 *
 * `~/.claude/ui/harnesses.json` (ADR-082 §2): reads never throw and fall back to
 * the defaults; saves keep what this version does not understand.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  defaultSelection,
  harnessSelection,
  loadHarnessesConfig,
  saveHarnessesConfig
} from '../selection-store'

let tmp: string
let file: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-selection-'))
  file = path.join(tmp, 'ui', 'harnesses.json')
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function write(content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

describe('loadHarnessesConfig', () => {
  it('reads a missing file as the defaults', () => {
    expect(loadHarnessesConfig(file)).toEqual({})
    expect(harnessSelection('claude', loadHarnessesConfig(file))).toEqual({ source: 'bundled' })
    for (const id of ['opencode', 'pi', 'codex'] as const) {
      expect(harnessSelection(id, loadHarnessesConfig(file))).toEqual({
        source: 'managed',
        version: 'tested'
      })
    }
  })

  it.each(['{', 'null', '[]', '"x"', '{"selections": 7}'])(
    'reads %s as the defaults without throwing',
    (content) => {
      write(content)
      expect(() => loadHarnessesConfig(file)).not.toThrow()
      expect(harnessSelection('pi', loadHarnessesConfig(file))).toEqual(defaultSelection('pi'))
    }
  )

  it('drops entries it cannot trust, keeping the valid ones', () => {
    write(
      JSON.stringify({
        selections: {
          opencode: { source: 'system' },
          pi: { source: 'from-the-moon' },
          codex: { source: 'managed', version: '../../evil' },
          claude: { source: 'bundled', version: 7 },
          gemini: { source: 'managed' }
        }
      })
    )
    const config = loadHarnessesConfig(file)
    expect(config.selections).toEqual({
      opencode: { source: 'system' },
      // An unsafe version is dropped, so managed means Tested again.
      codex: { source: 'managed' },
      claude: { source: 'bundled' }
    })
    expect(harnessSelection('pi', config)).toEqual(defaultSelection('pi'))
  })

  it('keeps an exact version, latest and tested', () => {
    write(
      JSON.stringify({
        selections: {
          opencode: { source: 'managed', version: '1.18.32' },
          pi: { source: 'managed', version: 'latest' },
          codex: { source: 'managed', version: '0.156.0-alpha.2' }
        }
      })
    )
    const config = loadHarnessesConfig(file)
    expect(harnessSelection('opencode', config).version).toBe('1.18.32')
    expect(harnessSelection('pi', config).version).toBe('latest')
    expect(harnessSelection('codex', config).version).toBe('0.156.0-alpha.2')
  })
})

describe('saveHarnessesConfig', () => {
  it('creates the file and round-trips a selection', () => {
    saveHarnessesConfig({ selections: { pi: { source: 'system' } } }, file)
    expect(harnessSelection('pi', loadHarnessesConfig(file))).toEqual({ source: 'system' })
  })

  it('keeps unknown top-level keys, unknown harnesses and untouched selections', () => {
    write(
      JSON.stringify({
        updates: 'ask',
        selections: {
          gemini: { source: 'managed', flavour: 'x' },
          opencode: { source: 'managed', version: 'latest' }
        }
      })
    )
    saveHarnessesConfig({ selections: { pi: { source: 'system' } } }, file)
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({
      updates: 'ask',
      selections: {
        gemini: { source: 'managed', flavour: 'x' },
        opencode: { source: 'managed', version: 'latest' },
        pi: { source: 'system' }
      }
    })
  })

  it('refuses an invalid selection instead of writing it', () => {
    expect(() =>
      saveHarnessesConfig({ selections: { pi: { source: 'nowhere' as 'system' } } }, file)
    ).toThrow(/Invalid harness selection/)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('refuses to overwrite a present but unreadable file', () => {
    write('{ not json')
    expect(() => saveHarnessesConfig({ selections: { pi: { source: 'system' } } }, file)).toThrow(
      /Refusing to overwrite/
    )
    expect(fs.readFileSync(file, 'utf-8')).toBe('{ not json')
  })
})
