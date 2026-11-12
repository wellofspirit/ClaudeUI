/**
 * @vitest-environment node
 *
 * App settings have one schema (`src/shared/app-settings.ts`) and, in core, one reader
 * (`appSetting` in `src/core/services/app-settings.ts`, over canonical state). A second
 * reader (disk, or canonical with its own default) is how core came to run with a default
 * the UI did not show. These scans fail on the next one.
 */

import { describe, it, expect } from 'vitest'
import { isTestFile, listSourceFiles, readSource } from '../../test/helpers/source-graph'

const FIX =
  'Read the setting with `appSetting(key)` from `src/core/services/app-settings.ts` (core acts on a change in `applySettings`, `app-settings-apply.ts`).'

const source = listSourceFiles().filter((f) => !isTestFile(f))
const filesMatching = (files: string[], re: RegExp): string[] =>
  files.filter((f) => re.test(readSource(f)))
const hostSide = source.filter((f) => /^src\/(core|main|server)\//.test(f))

describe('app-settings readers', () => {
  it('only the config plane, the config:load-settings handler and the canonical seed call loadSettings', () => {
    expect(filesMatching(hostSide, /\bloadSettings\(/), FIX).toEqual([
      'src/core/ipc/app-state-commands.ts',
      'src/core/services/sync-seed.ts',
      'src/core/services/ui-config.ts'
    ])
  })

  it('only appSetting reads the settings out of canonical state', () => {
    // The chained read (wrapped or not) and the destructured one. A read through a local
    // (`const state = getCanonicalState()`, then `state.settings`) is not caught here.
    const chained = /getCanonicalState\(\)\s*\.settings\b/
    const destructured = /\{[^{}]*\bsettings\b[^{}]*\}\s*=\s*[\w.]*getCanonicalState\(\)/
    const readers = hostSide.filter((f) => {
      const text = readSource(f)
      return chained.test(text) || destructured.test(text)
    })
    expect(readers, FIX).toEqual(['src/core/services/app-settings.ts'])
  })

  it('the schema and its defaults are declared once', () => {
    expect(filesMatching(source, /\binterface AppSettings\b/)).toEqual([
      'src/shared/app-settings.ts'
    ])
    expect(filesMatching(source, /\bconst DEFAULT_SETTINGS\b/)).toEqual([
      'src/shared/app-settings.ts'
    ])
  })
})
