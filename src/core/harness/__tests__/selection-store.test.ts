/**
 * @vitest-environment node
 *
 * `~/.claude/ui/harnesses.json` (ADR-082 §2, §6, §8): reads never throw and fall back
 * to the defaults; saves keep what this version does not understand.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  defaultSelection,
  harnessSelection,
  harnessUpdateMode,
  loadHarnessesConfig,
  saveHarnessesConfig,
  upgradePromptAnswered
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

describe('the update mode (ADR-082 §6)', () => {
  it('defaults to Ask me: missing file, missing key, or a value it does not know', () => {
    expect(harnessUpdateMode(loadHarnessesConfig(file))).toBe('ask')
    write(JSON.stringify({ selections: {} }))
    expect(harnessUpdateMode(loadHarnessesConfig(file))).toBe('ask')
    write(JSON.stringify({ updates: 'always' }))
    expect(harnessUpdateMode(loadHarnessesConfig(file))).toBe('ask')
  })

  it('reads the mode even when there are no selections', () => {
    write(JSON.stringify({ updates: 'auto' }))
    expect(loadHarnessesConfig(file)).toEqual({ updates: 'auto' })
    expect(harnessUpdateMode(loadHarnessesConfig(file))).toBe('auto')
  })

  it('saves the mode, keeping the selections and unknown keys, and a selection save keeps it', () => {
    write(
      JSON.stringify({
        future: 1,
        selections: { opencode: { source: 'managed', version: 'latest' } }
      })
    )
    saveHarnessesConfig({ updates: 'auto' }, file)
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({
      future: 1,
      selections: { opencode: { source: 'managed', version: 'latest' } },
      updates: 'auto'
    })
    saveHarnessesConfig({ selections: { pi: { source: 'system' } } }, file)
    expect(loadHarnessesConfig(file)).toMatchObject({ updates: 'auto' })
  })

  it('refuses an invalid mode instead of writing it', () => {
    expect(() => saveHarnessesConfig({ updates: 'always' as 'auto' }, file)).toThrow(
      /Invalid harness update mode/
    )
    expect(fs.existsSync(file)).toBe(false)
  })
})

describe('the upgrade prompt answer (ADR-082 §8)', () => {
  it('is unanswered until saved, and reads nothing but "answered" as answered', () => {
    expect(upgradePromptAnswered(loadHarnessesConfig(file))).toBe(false)
    write(JSON.stringify({ upgradePrompt: 'maybe' }))
    expect(upgradePromptAnswered(loadHarnessesConfig(file))).toBe(false)
    expect(loadHarnessesConfig(file)).toEqual({})
  })

  it('persists the answer beside the selections, the mode and unknown keys, and they keep it', () => {
    write(
      JSON.stringify({
        future: { nested: true },
        updates: 'auto',
        selections: { pi: { source: 'system' }, later: { source: 'managed' } }
      })
    )
    saveHarnessesConfig({ upgradePrompt: 'answered' }, file)
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({
      future: { nested: true },
      updates: 'auto',
      selections: { pi: { source: 'system' }, later: { source: 'managed' } },
      upgradePrompt: 'answered'
    })
    expect(upgradePromptAnswered(loadHarnessesConfig(file))).toBe(true)
    // Later saves of the other keys keep it.
    saveHarnessesConfig({ selections: { opencode: { source: 'system' } } }, file)
    saveHarnessesConfig({ updates: 'ask' }, file)
    expect(loadHarnessesConfig(file)).toMatchObject({ upgradePrompt: 'answered', updates: 'ask' })
  })

  it('refuses any other value instead of writing it', () => {
    expect(() => saveHarnessesConfig({ upgradePrompt: 'later' as 'answered' }, file)).toThrow(
      /Invalid upgrade prompt state/
    )
    expect(fs.existsSync(file)).toBe(false)
  })
})
