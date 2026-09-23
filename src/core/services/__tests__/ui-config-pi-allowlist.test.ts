/**
 * @vitest-environment node
 *
 * ADR-074 §1 — `loadEngineConfig('pi')` reads the legacy global
 * `piConfig.modelAllowlist` (`<provider>/<model>` values) as the per-provider
 * record, WITHOUT rewriting the file; other engines' configs are untouched.
 *
 * Drives the REAL `ui-config.ts` against a temp home (the
 * `ui-config-shared-automode.test.ts` trick) — the developer's real
 * `~/.claude/ui` is never read or written.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const homedirHolder = vi.hoisted(() => ({ current: '' }))
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => homedirHolder.current,
    default: { ...actual, homedir: () => homedirHolder.current }
  }
})
vi.mock('../db', () => ({
  allSessionMeta: () => [],
  setSessionMeta: vi.fn(),
  deleteSessionMeta: vi.fn(),
  importSessionEnginesOnce: vi.fn()
}))
vi.mock('../sync-host', () => ({ emitEvent: vi.fn() }))
vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

let testHome: string
const engineFile = (id: string): string => join(testHome, '.claude', 'ui', 'engines', `${id}.json`)

function writeEngine(id: string, data: unknown): string {
  mkdirSync(join(testHome, '.claude', 'ui', 'engines'), { recursive: true })
  const text = JSON.stringify(data, null, 2)
  writeFileSync(engineFile(id), text)
  return text
}

async function freshModule(): Promise<typeof import('../ui-config')> {
  vi.resetModules()
  return await import('../ui-config')
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'claudeui-pi-allowlist-'))
  homedirHolder.current = testHome
})

afterEach(() => {
  rmSync(testHome, { recursive: true, force: true })
  vi.resetModules()
})

describe("loadEngineConfig('pi') — per-provider allowlist migration", () => {
  it('reads the legacy list as a record and leaves the file as it was', async () => {
    const onDisk = writeEngine('pi', {
      dispatch: { defaultModel: 'openrouter/z-ai/glm-5.3' },
      piConfig: {
        defaultModel: 'openrouter/z-ai/glm-5.3',
        modelAllowlist: ['openrouter/z-ai/glm-5.3', 'openrouter/moonshotai/kimi-k3']
      }
    })
    const { loadEngineConfig } = await freshModule()

    expect(loadEngineConfig('pi')).toEqual({
      dispatch: { defaultModel: 'openrouter/z-ai/glm-5.3' },
      piConfig: {
        defaultModel: 'openrouter/z-ai/glm-5.3',
        modelAllowlist: { openrouter: ['z-ai/glm-5.3', 'moonshotai/kimi-k3'] }
      }
    })
    expect(readFileSync(engineFile('pi'), 'utf-8')).toBe(onDisk)
  })

  it('persists the new shape on the next save', async () => {
    writeEngine('pi', { piConfig: { modelAllowlist: ['groq/llama-4'] } })
    const { loadEngineConfig, saveEngineConfig } = await freshModule()

    saveEngineConfig('pi', loadEngineConfig('pi'))

    expect(JSON.parse(readFileSync(engineFile('pi'), 'utf-8'))).toEqual({
      piConfig: { modelAllowlist: { groq: ['llama-4'] } }
    })
  })

  it('leaves another engine’s same-named field alone', async () => {
    writeEngine('opencode', { piConfig: { modelAllowlist: ['groq/llama-4'] } })
    const { loadEngineConfig } = await freshModule()

    expect(loadEngineConfig('opencode')).toEqual({
      piConfig: { modelAllowlist: ['groq/llama-4'] }
    })
  })

  it('an absent file is still {}', async () => {
    const { loadEngineConfig } = await freshModule()
    expect(loadEngineConfig('pi')).toEqual({})
  })
})
