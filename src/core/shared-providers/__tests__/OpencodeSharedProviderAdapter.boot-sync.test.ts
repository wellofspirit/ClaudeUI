// @vitest-environment node
/**
 * S10b B1: the boot-time shared-provider sync must not rewrite the user's
 * opencode config when nothing ClaudeUI manages changed. It runs the REAL
 * config reader/writer against a temp `OPENCODE_CONFIG_DIR` holding the 1.x
 * entries ClaudeUI 1.x wrote (the evidence shape), and asserts zero writes;
 * a real definition change makes exactly one write.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse as jsoncParse } from 'jsonc-parser'

vi.mock('../../services/ui-config', () => ({
  loadEngineConfig: () => ({}),
  saveEngineConfig: () => {}
}))

import { OpencodeSharedProviderAdapter } from '../OpencodeSharedProviderAdapter'
import {
  onOpencodeConfigWritten,
  readOpencodeNativeConfig,
  writeOpencodeNativeConfig
} from '../../opencode/opencode-config'
import type { SharedProviderDefinition } from '../../../shared/shared-provider'

const spark: SharedProviderDefinition = {
  id: 'spark',
  name: 'Spark',
  kind: 'custom',
  protocol: 'openai-completions',
  baseUrl: 'http://127.0.0.1:8888/v1',
  models: [{ id: 'mimo-v26-flash', name: 'Mimo 2.6 Flash' }],
  managed: true,
  routes: { pi: { enabled: false }, opencode: { enabled: true } }
}
const coding4: SharedProviderDefinition = {
  ...spark,
  id: 'coding4',
  name: 'Coding 4',
  baseUrl: 'http://127.0.0.1:9999/v1',
  models: [
    {
      id: 'qwen-coder',
      name: 'Qwen Coder',
      reasoning: true,
      vision: true,
      contextWindow: 262144,
      maxTokens: 32768
    }
  ]
}

/** The two entries as ClaudeUI 1.x wrote them (S10b evidence shape), with comments. */
const LEGACY = `{
  // my setup
  "model": "spark/mimo-v26-flash",
  "provider": {
    "spark": {
      "name": "Spark",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:8888/v1" },
      "models": {
        "mimo-v26-flash": {
          "name": "Mimo 2.6 Flash",
          "reasoning": false,
          "attachment": false,
          "tool_call": true,
          "limit": { "context": 0, "output": 0 }
        }
      }
    },
    "coding4": {
      "name": "Coding 4",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:9999/v1" },
      "models": {
        "qwen-coder": {
          "name": "Qwen Coder",
          "reasoning": true,
          "attachment": true,
          "tool_call": true,
          "modalities": { "input": ["text", "image"] },
          "limit": { "context": 262144, "output": 32768 }
        }
      }
    }
  }
}
`

let dir: string
let file: string
let prior: string | undefined
const writes: string[] = []
let off: () => void

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-boot-sync-'))
  file = path.join(dir, 'opencode.jsonc')
  fs.writeFileSync(file, LEGACY)
  prior = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = dir
  writes.length = 0
  off = onOpencodeConfigWritten((reason) => writes.push(reason))
})

afterEach(() => {
  off()
  if (prior === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = prior
  fs.rmSync(dir, { recursive: true, force: true })
})

function adapter(): OpencodeSharedProviderAdapter {
  return new OpencodeSharedProviderAdapter({
    invalidateModelCache: () => {},
    readModelAllowlist: () => ({}),
    authTarget: {
      setVendorApiKey: async () => {},
      removeVendorAuth: async () => {}
    }
  })
}

describe('boot-time definition sync over 1.x entries (S10b B1)', () => {
  it('an unchanged definition over the 1.x entries ClaudeUI wrote writes NOTHING', () => {
    const before = fs.readFileSync(file, 'utf8')
    const mtime = fs.statSync(file).mtimeMs
    const a = adapter()
    for (const definition of [spark, coding4]) {
      expect(a.hasDefinition(definition)).toBe(true)
      a.applyDefinitionRoute({
        definition,
        previouslyManaged: true,
        previousDefinition: definition
      })
      a.applyDefinitionRoute({ definition, previouslyManaged: true })
    }
    expect(writes).toEqual([])
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(fs.statSync(file).mtimeMs).toBe(mtime)
  })

  it('a real definition change makes exactly one minimal write, by the move rules', () => {
    const changed: SharedProviderDefinition = {
      ...spark,
      models: [{ ...spark.models[0], contextWindow: 131072 }]
    }
    adapter().applyDefinitionRoute({
      definition: changed,
      previouslyManaged: true,
      previousDefinition: spark
    })
    expect(writes).toEqual(['settings'])
    const text = fs.readFileSync(file, 'utf8')
    expect(text).toContain('// my setup')
    const parsed = jsoncParse(text)
    // Only spark moved (the edited entry), coding4 stays 1.x, byte for byte in meaning.
    expect(Object.keys(parsed.provider)).toEqual(['coding4'])
    expect(parsed.providers.spark.models['mimo-v26-flash']).toEqual({
      name: 'Mimo 2.6 Flash',
      // tool_call:true as 2.x reads it (upstream fills the defaults); the inert
      // 1.x reasoning/attachment stay inert: no `variants: []`, no text-only input.
      capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
      limit: { context: 131072, output: 0 }
    })
  })

  it('the default-model writer (a whole-projection save) touches only `model`', () => {
    const before = fs.readFileSync(file, 'utf8')
    // What SharedProviderService.setOpencodeDefault does at boot.
    writeOpencodeNativeConfig({ ...readOpencodeNativeConfig(), model: 'spark/mimo-v26-flash' })
    expect(writes).toEqual([])
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    writeOpencodeNativeConfig({ ...readOpencodeNativeConfig(), model: 'coding4/qwen-coder' })
    expect(writes).toEqual(['settings'])
    expect(fs.readFileSync(file, 'utf8')).toBe(
      before.replace('"spark/mimo-v26-flash"', '"coding4/qwen-coder"')
    )
  })
})
