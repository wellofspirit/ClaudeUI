/**
 * @vitest-environment node
 *
 * The `claudeui-xeng` plugin cannot import ClaudeUI code (it runs inside the
 * external opencode process), so its subagent model gate carries a copy of
 * `opencodeModelAllowed` (ADR-111). This pins the two together over one set of
 * fixtures: a drift would let a model through the gate that the picker and the
 * parent spawn gate refuse (or the reverse).
 */
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { opencodeModelAllowed } from '../model-allowlist'

const FILE = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'resources',
  'opencode',
  'claudeui-xeng',
  'index.js'
)

type Allowlist = Record<string, string[]>
interface Plugin {
  modelAllowed: (allowlist: Allowlist, value: string) => boolean
  readAllowlist: (options: unknown) => Allowlist | null
}

const ALLOWLISTS: Record<string, Allowlist> = {
  none: {},
  restricted: { openai: ['gpt-a', 'gpt-b'] },
  nothing: { openai: [] },
  two: { openai: ['gpt-a'], anthropic: ['claude-x'] },
  // An id with a slash of its own: everything after the FIRST slash is the id.
  nested: { openrouter: ['meta/llama-3', 'deepseek/r1:free'] }
}

const VALUES = [
  'openai/gpt-a',
  'openai/gpt-b#high',
  'openai/gpt-z',
  'openai/gpt-z#high',
  'openai/',
  'openai',
  '/gpt-a',
  'anthropic/claude-x#thinking',
  'anthropic/claude-y',
  'local/anything',
  'local/with/slashes',
  'openrouter/meta/llama-3',
  'openrouter/meta/llama-3#x',
  'openrouter/meta',
  'openrouter/deepseek/r1:free',
  // Names Object.prototype also has must not read as an entry.
  'constructor/x',
  'toString/x',
  '__proto__/x',
  'hasOwnProperty/x',
  'p#v/id',
  ''
]

describe('claudeui-xeng plugin model gate vs opencodeModelAllowed', () => {
  it('agrees on every fixture', async () => {
    const plugin = (await import(pathToFileURL(FILE).href)) as Plugin
    let compared = 0
    for (const [name, allowlist] of Object.entries(ALLOWLISTS)) {
      for (const value of VALUES) {
        expect(plugin.modelAllowed(allowlist, value), `${name} / ${JSON.stringify(value)}`).toBe(
          opencodeModelAllowed(allowlist, value)
        )
        compared++
      }
    }
    expect(compared).toBe(Object.keys(ALLOWLISTS).length * VALUES.length)
  })

  it('the fixtures exercise both verdicts (the comparison is not vacuous)', async () => {
    const plugin = (await import(pathToFileURL(FILE).href)) as Plugin
    const verdicts = new Set(
      Object.values(ALLOWLISTS).flatMap((allowlist) =>
        VALUES.map((value) => plugin.modelAllowed(allowlist, value))
      )
    )
    expect(verdicts).toEqual(new Set([true, false]))
  })

  it('readAllowlist accepts exactly what ClaudeUI injects (the engine config shape)', async () => {
    const plugin = (await import(pathToFileURL(FILE).href)) as Plugin
    for (const allowlist of Object.values(ALLOWLISTS)) {
      expect(plugin.readAllowlist({ modelAllowlist: allowlist })).toEqual(allowlist)
    }
  })
})
