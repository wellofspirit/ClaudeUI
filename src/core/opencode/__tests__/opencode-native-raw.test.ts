/**
 * Tests for opencode-native-raw.ts — the NON-lossy raw leaf-patch writer.
 *
 * Guards:
 * - readOpencodeNativeRaw returns the parsed jsonc verbatim (no projection)
 * - a leaf set preserves sibling keys AND comments (.jsonc fixture)
 * - a delete under a missing parent is a NO-OP (not a throw)
 * - an excluded top-level key is rejected
 * - a schema-invalid result (attachment: "yes") is rejected by ajv, nothing written
 * - patches producing no textual change do not rewrite the file (byte no-op)
 * - the concrete story: patch attachment=true, apiKey + comment intact
 */

// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parse as jsoncParse } from 'jsonc-parser'
import {
  readOpencodeNativeRaw,
  patchOpencodeNativeRaw,
  __resetValidatorForTests
} from '../opencode-native-raw'

let tmpDir: string
let prevEnv: string | undefined

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-raw-test-'))
  prevEnv = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = tmpDir
  __resetValidatorForTests()
})

afterEach(() => {
  if (prevEnv === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = prevEnv
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeConfig(name: string, text: string): string {
  const p = path.join(tmpDir, name)
  fs.writeFileSync(p, text, 'utf8')
  return p
}

describe('readOpencodeNativeRaw', () => {
  it('returns {} and the resolved path when no file exists', () => {
    const { config, path: p } = readOpencodeNativeRaw()
    expect(config).toEqual({})
    expect(p).toBe(path.join(tmpDir, 'opencode.json'))
  })

  it('returns the parsed jsonc verbatim (no projection), including comments-stripped values', () => {
    writeConfig(
      'opencode.jsonc',
      `{
        // a comment
        "theme": "opencode",
        "provider": { "ec2": { "options": { "apiKey": "sekret" } } }
      }`
    )
    const { config } = readOpencodeNativeRaw()
    expect(config.theme).toBe('opencode')
    expect((config.provider as any).ec2.options.apiKey).toBe('sekret')
  })
})

describe('patchOpencodeNativeRaw (opencode 2.x schema, ADR-097 S8)', () => {
  it('sets a leaf while preserving sibling keys and comments', () => {
    const p = writeConfig(
      'opencode.jsonc',
      `{
  // keep me
  "theme": "opencode",
  "providers": {
    "ec2": {
      "settings": { "apiKey": "sekret" }
    }
  }
}`
    )
    patchOpencodeNativeRaw([
      {
        path: ['providers', 'ec2', 'models', 'qwen3.6:27b', 'capabilities', 'input'],
        value: ['text', 'image']
      }
    ])
    const text = fs.readFileSync(p, 'utf8')
    expect(text).toContain('// keep me')
    const parsed = jsoncParse(text)
    expect(parsed.theme).toBe('opencode')
    expect(parsed.providers.ec2.settings.apiKey).toBe('sekret')
    expect(parsed.providers.ec2.models['qwen3.6:27b'].capabilities.input).toEqual(['text', 'image'])
  })

  it('deleting under a MISSING parent is a no-op (not a throw)', () => {
    const p = writeConfig('opencode.json', `{ "theme": "opencode" }`)
    expect(() =>
      patchOpencodeNativeRaw([{ path: ['providers', 'ghost', 'models', 'x', 'variants'] }])
    ).not.toThrow()
    expect(jsoncParse(fs.readFileSync(p, 'utf8'))).toEqual({ theme: 'opencode' })
  })

  it('deletes an EXISTING leaf, preserving siblings', () => {
    const p = writeConfig(
      'opencode.json',
      `{ "providers": { "ec2": { "models": { "q": { "variants": [], "limit": { "context": 5 } } } } } }`
    )
    patchOpencodeNativeRaw([{ path: ['providers', 'ec2', 'models', 'q', 'variants'] }])
    expect(jsoncParse(fs.readFileSync(p, 'utf8')).providers.ec2.models.q).toEqual({
      limit: { context: 5 }
    })
  })

  it('rejects a patch under a protected path (defense in depth)', () => {
    writeConfig('opencode.json', `{}`)
    const refused: [(string | number)[], RegExp][] = [
      [['permissions', 0], /"permissions"/],
      [['permission', 'bash'], /"permission"/],
      [['model'], /"model"/],
      [['agents', 'build', 'model'], /"agents"/],
      [['mcp', 'servers', 'x'], /"mcp.servers"/],
      [['mcp'], /"mcp.servers"/],
      [['experimental', 'policies'], /"experimental.policies"/],
      [['experimental'], /"experimental.policies"/],
      [['provider', 'x', 'name'], /"provider"/]
    ]
    for (const [path, message] of refused)
      expect(() => patchOpencodeNativeRaw([{ path, value: 'x' }])).toThrow(message)
    // …but their writable siblings are fine.
    expect(() =>
      patchOpencodeNativeRaw([
        { path: ['mcp', 'timeout', 'execution'], value: 5000 },
        { path: ['experimental', 'subagent_depth'], value: 2 }
      ])
    ).not.toThrow()
  })

  it('refuses to SET a key opencode 2.x does not have (1.x keys included), allows deleting one', () => {
    const p = writeConfig(
      'opencode.json',
      `{ "logLevel": "DEBUG", "compaction": { "tail_turns": 2 }, "snapshot": true }`
    )
    const refused: (string | number)[][] = [
      ['logLevel'],
      ['snapshot'],
      ['attachment', 'image', 'max_width'],
      ['compaction', 'tail_turns'],
      ['providers', 'x', 'models', 'm', 'attachment'],
      ['providers', 'x', 'models', 'm', 'reasoning']
    ]
    for (const path of refused)
      expect(() => patchOpencodeNativeRaw([{ path, value: 1 }])).toThrow(/no such config key/)
    patchOpencodeNativeRaw([
      { path: ['logLevel'] },
      { path: ['compaction', 'tail_turns'] },
      { path: ['snapshot'] },
      { path: ['snapshots'], value: false }
    ])
    expect(jsoncParse(fs.readFileSync(p, 'utf8'))).toEqual({ compaction: {}, snapshots: false })
  })

  it('accepts the 2.x paths the panes and the capability editor write', () => {
    writeConfig('opencode.json', `{}`)
    const ok: [(string | number)[], unknown][] = [
      [['compaction', 'keep', 'tokens'], 1000],
      [['compaction', 'buffer'], 500],
      [['media', 'image', 'max_width'], 2000],
      [['tool_output', 'max_lines'], 100],
      [['plugins'], ['x']],
      [['skills'], ['/s']],
      [['formatter', 'prettier', 'disabled'], true],
      [['providers', 'x', 'models', 'm', 'body', 'temperature'], 0.2],
      [['providers', 'x', 'models', 'm', 'variants'], []],
      [['providers', 'x', 'models', 'm', 'cost'], { input: 1, output: 2 }]
    ]
    for (const [path, value] of ok)
      expect(() => patchOpencodeNativeRaw([{ path, value }]), path.join('.')).not.toThrow()
  })

  it('rejects a schema-invalid result and writes nothing', () => {
    const p = writeConfig('opencode.json', `{ "providers": { "ec2": { "models": { "q": {} } } } }`)
    const before = fs.readFileSync(p, 'utf8')
    expect(() =>
      patchOpencodeNativeRaw([
        { path: ['providers', 'ec2', 'models', 'q', 'capabilities', 'tools'], value: 'yes' }
      ])
    ).toThrow(/tools must be boolean/)
    expect(() =>
      patchOpencodeNativeRaw([
        { path: ['providers', 'ec2', 'models', 'q', 'cost'], value: { input: 1 } }
      ])
    ).toThrow(/would be invalid/)
    expect(fs.readFileSync(p, 'utf8')).toBe(before)
  })

  it('a 1.x value elsewhere in the file never blocks an unrelated edit', () => {
    const p = writeConfig(
      'opencode.json',
      `{ "skills": { "paths": ["/old"] }, "plugin": [["x", {}]], "compaction": { "prune": true } }`
    )
    patchOpencodeNativeRaw([{ path: ['compaction', 'auto'], value: false }])
    expect(jsoncParse(fs.readFileSync(p, 'utf8')).compaction).toEqual({ prune: true, auto: false })
  })

  it('a no-op patch (value already present) does not rewrite the file', () => {
    const p = writeConfig(
      'opencode.jsonc',
      `{
  // untouched
  "providers": { "ec2": { "models": { "q": { "variants": [] } } } }
}`
    )
    const mtimeBefore = fs.statSync(p).mtimeMs
    const before = fs.readFileSync(p, 'utf8')
    patchOpencodeNativeRaw([{ path: ['providers', 'ec2', 'models', 'q', 'variants'], value: [] }])
    expect(fs.readFileSync(p, 'utf8')).toBe(before)
    expect(fs.statSync(p).mtimeMs).toBe(mtimeBefore)
  })

  it('accepts unknown top-level keys in the existing config (schema not closed against them)', () => {
    const p = writeConfig('opencode.json', `{ "myFutureKey": 42 }`)
    expect(() => patchOpencodeNativeRaw([{ path: ['snapshots'], value: true }])).not.toThrow()
    const parsed = jsoncParse(fs.readFileSync(p, 'utf8'))
    expect(parsed.myFutureKey).toBe(42)
    expect(parsed.snapshots).toBe(true)
  })

  it('END-TO-END: a capability edit on a 1.x provider moves it to providers whole, apiKey + comment intact', () => {
    const p = writeConfig(
      'opencode.jsonc',
      `{
  // my custom EC2 provider
  "provider": {
    "ec2": {
      "name": "EC2 self-hosted",
      "options": { "apiKey": "sk-secret", "baseURL": "http://ec2/v1" },
      "models": { "qwen3.6:27b": { "attachment": false } }
    }
  }
}`
    )
    patchOpencodeNativeRaw([
      {
        path: ['providers', 'ec2', 'models', 'qwen3.6:27b', 'capabilities', 'input'],
        value: ['text', 'image']
      }
    ])
    const text = fs.readFileSync(p, 'utf8')
    expect(text).toContain('// my custom EC2 provider')
    const parsed = jsoncParse(text)
    expect(parsed.provider).toEqual({})
    expect(parsed.providers.ec2).toEqual({
      name: 'EC2 self-hosted',
      settings: { apiKey: 'sk-secret', baseURL: 'http://ec2/v1' },
      models: { 'qwen3.6:27b': { capabilities: { input: ['text', 'image'] } } }
    })
  })

  it('F5: an mcp.timeout edit moves the 1.x mcp_timeout into the other leaf too (probe3)', () => {
    const p = writeConfig('opencode.jsonc', `{ "experimental": { "mcp_timeout": 60000 } }`)
    patchOpencodeNativeRaw([
      { path: ['mcp', 'timeout', 'execution'], value: 120000 },
      { path: ['experimental', 'mcp_timeout'] }
    ])
    expect(jsoncParse(fs.readFileSync(p, 'utf8'))).toEqual({
      experimental: {},
      mcp: { timeout: { catalog: 60000, execution: 120000 } }
    })
  })
})
