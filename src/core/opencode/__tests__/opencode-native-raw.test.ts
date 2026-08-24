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

describe('patchOpencodeNativeRaw', () => {
  it('sets a leaf while preserving sibling keys and comments', () => {
    const p = writeConfig(
      'opencode.jsonc',
      `{
  // keep me
  "theme": "opencode",
  "provider": {
    "ec2": {
      "options": { "apiKey": "sekret" }
    }
  }
}`
    )
    patchOpencodeNativeRaw([
      { path: ['provider', 'ec2', 'models', 'qwen3.6:27b', 'attachment'], value: true }
    ])
    const text = fs.readFileSync(p, 'utf8')
    expect(text).toContain('// keep me')
    const parsed = jsoncParse(text)
    expect(parsed.theme).toBe('opencode')
    expect(parsed.provider.ec2.options.apiKey).toBe('sekret')
    expect(parsed.provider.ec2.models['qwen3.6:27b'].attachment).toBe(true)
  })

  it('deleting under a MISSING parent is a no-op (not a throw)', () => {
    const p = writeConfig('opencode.json', `{ "theme": "opencode" }`)
    expect(() =>
      patchOpencodeNativeRaw([{ path: ['provider', 'ghost', 'models', 'x', 'attachment'] }])
    ).not.toThrow()
    // File unchanged.
    expect(jsoncParse(fs.readFileSync(p, 'utf8'))).toEqual({ theme: 'opencode' })
  })

  it('deletes an EXISTING leaf, preserving siblings', () => {
    const p = writeConfig(
      'opencode.json',
      `{ "provider": { "ec2": { "models": { "q": { "attachment": true, "reasoning": false } } } } }`
    )
    patchOpencodeNativeRaw([{ path: ['provider', 'ec2', 'models', 'q', 'attachment'] }])
    const parsed = jsoncParse(fs.readFileSync(p, 'utf8'))
    expect(parsed.provider.ec2.models.q.attachment).toBeUndefined()
    expect(parsed.provider.ec2.models.q.reasoning).toBe(false)
  })

  it('rejects a patch whose top-level key is excluded (defense in depth)', () => {
    writeConfig('opencode.json', `{}`)
    expect(() => patchOpencodeNativeRaw([{ path: ['permission', 'bash'], value: 'ask' }])).toThrow(
      /protected opencode config key "permission"/
    )
    expect(() => patchOpencodeNativeRaw([{ path: ['model'], value: 'x' }])).toThrow(/"model"/)
  })

  it('allows provider leaf patches (provider is NOT excluded — capability editing needs it)', () => {
    writeConfig('opencode.json', `{ "provider": { "ec2": { "models": { "q": {} } } } }`)
    expect(() =>
      patchOpencodeNativeRaw([
        { path: ['provider', 'ec2', 'models', 'q', 'reasoning'], value: true }
      ])
    ).not.toThrow()
  })

  it('rejects a schema-invalid result and writes nothing', () => {
    const p = writeConfig('opencode.json', `{ "provider": { "ec2": { "models": { "q": {} } } } }`)
    const before = fs.readFileSync(p, 'utf8')
    expect(() =>
      patchOpencodeNativeRaw([
        { path: ['provider', 'ec2', 'models', 'q', 'attachment'], value: 'yes' }
      ])
    ).toThrow(/attachment must be boolean/)
    // Nothing written.
    expect(fs.readFileSync(p, 'utf8')).toBe(before)
  })

  it('a no-op patch (value already present) does not rewrite the file', () => {
    const p = writeConfig(
      'opencode.jsonc',
      `{
  // untouched
  "provider": { "ec2": { "models": { "q": { "attachment": true } } } }
}`
    )
    const mtimeBefore = fs.statSync(p).mtimeMs
    const before = fs.readFileSync(p, 'utf8')
    patchOpencodeNativeRaw([
      { path: ['provider', 'ec2', 'models', 'q', 'attachment'], value: true }
    ])
    expect(fs.readFileSync(p, 'utf8')).toBe(before)
    // Byte no-op → not rewritten (mtime unchanged).
    expect(fs.statSync(p).mtimeMs).toBe(mtimeBefore)
  })

  it('accepts unknown top-level keys in the existing config (schema not closed against them)', () => {
    const p = writeConfig('opencode.json', `{ "myFutureKey": 42 }`)
    expect(() => patchOpencodeNativeRaw([{ path: ['snapshot'], value: true }])).not.toThrow()
    const parsed = jsoncParse(fs.readFileSync(p, 'utf8'))
    expect(parsed.myFutureKey).toBe(42)
    expect(parsed.snapshot).toBe(true)
  })

  it('END-TO-END: enabling attachment on qwen keeps apiKey + comment intact', () => {
    const p = writeConfig(
      'opencode.jsonc',
      `{
  // my custom EC2 provider
  "provider": {
    "ec2": {
      "name": "EC2 self-hosted",
      "options": { "apiKey": "sk-secret", "baseURL": "http://ec2/v1" },
      "models": { "qwen3.6:27b": {} }
    }
  }
}`
    )
    patchOpencodeNativeRaw([
      { path: ['provider', 'ec2', 'models', 'qwen3.6:27b', 'attachment'], value: true }
    ])
    const text = fs.readFileSync(p, 'utf8')
    expect(text).toContain('// my custom EC2 provider')
    const parsed = jsoncParse(text)
    expect(parsed.provider.ec2.models['qwen3.6:27b'].attachment).toBe(true)
    expect(parsed.provider.ec2.options.apiKey).toBe('sk-secret')
    expect(parsed.provider.ec2.options.baseURL).toBe('http://ec2/v1')
    expect(parsed.provider.ec2.name).toBe('EC2 self-hosted')
  })
})
