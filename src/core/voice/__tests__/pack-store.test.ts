/**
 * @vitest-environment node
 *
 * `voiceStoreRoot` and `resolveVoicePack` against temp directories. The manifest
 * is mocked down to a few bytes so no test writes 650 MB, and the platform is
 * pinned so the same fixtures hold on every CI host.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const mocks = vi.hoisted(() => ({ platform: 'linux-x64' as string | null }))

vi.mock('../../../shared/voice-pack', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/voice-pack')>()
  return {
    ...actual,
    VOICE_PACK: {
      ...actual.VOICE_PACK,
      model: {
        ...actual.VOICE_PACK.model,
        files: [
          { name: 'encoder.int8.onnx', size: 10, sha256: 'x' },
          { name: 'tokens.txt', size: 3, sha256: 'y' }
        ]
      }
    },
    voicePackPlatformKey: () => mocks.platform
  }
})

import { VOICE_PACK } from '../../../shared/voice-pack'
import {
  VOICE_STORE_ENV,
  resolveVoicePack,
  voicePackDir,
  voiceStoreRoot,
  type VoiceInstallRecord
} from '../pack-store'

/** The platform package for the pinned 'linux-x64'. */
const ADDON_PACKAGE = 'sherpa-onnx-linux-x64'

let root: string
let savedEnv: string | undefined

function record(overrides: Partial<VoiceInstallRecord> = {}): VoiceInstallRecord {
  return {
    packId: VOICE_PACK.id,
    runtimeVersion: VOICE_PACK.runtime.version,
    platform: 'linux-x64',
    model: { repo: VOICE_PACK.model.repo, revision: VOICE_PACK.model.revision },
    files: {},
    installedAt: '2026-10-12T00:00:00.000Z',
    ...overrides
  }
}

/** A complete install; callers then break one thing. */
function install(rec: unknown = record()): string {
  const dir = voicePackDir()
  fs.mkdirSync(path.join(dir, 'model'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'model', 'encoder.int8.onnx'), Buffer.alloc(10))
  fs.writeFileSync(path.join(dir, 'model', 'tokens.txt'), Buffer.alloc(3))
  const modules = path.join(dir, 'runtime', 'node_modules')
  fs.mkdirSync(path.join(modules, 'sherpa-onnx-node'), { recursive: true })
  fs.writeFileSync(path.join(modules, 'sherpa-onnx-node', 'package.json'), '{}')
  fs.mkdirSync(path.join(modules, ADDON_PACKAGE), { recursive: true })
  fs.writeFileSync(path.join(modules, ADDON_PACKAGE, 'sherpa-onnx.node'), 'binary')
  fs.writeFileSync(path.join(dir, 'install.json'), JSON.stringify(rec))
  return dir
}

beforeEach(() => {
  savedEnv = process.env[VOICE_STORE_ENV]
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeui-voice-store-'))
  process.env[VOICE_STORE_ENV] = root
  mocks.platform = 'linux-x64'
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env[VOICE_STORE_ENV]
  else process.env[VOICE_STORE_ENV] = savedEnv
  // Our own mkdtemp directory, removed entry by entry.
  const remove = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, e.name)
      if (e.isDirectory()) remove(child)
      else fs.unlinkSync(child)
    }
    fs.rmdirSync(dir)
  }
  remove(root)
})

describe('voiceStoreRoot', () => {
  it('honours CLAUDEUI_VOICE_STORE, resolved', () => {
    expect(voiceStoreRoot()).toBe(path.resolve(root))
  })

  it('defaults to ~/.claude/ui/voice, apart from the harness store', () => {
    delete process.env[VOICE_STORE_ENV]
    expect(voiceStoreRoot()).toBe(path.join(os.homedir(), '.claude', 'ui', 'voice'))
    expect(voiceStoreRoot()).not.toContain('harnesses')
  })
})

describe('resolveVoicePack', () => {
  it('is null on a store that has nothing in it', () => {
    expect(resolveVoicePack()).toBeNull()
  })

  it('resolves a complete install to the addon and model directories', () => {
    const dir = install()
    expect(resolveVoicePack()).toEqual({
      addonDir: path.join(dir, 'runtime', 'node_modules', 'sherpa-onnx-node'),
      modelDir: path.join(dir, 'model')
    })
  })

  it('is null without install.json (an interrupted install is not a pack)', () => {
    const dir = install()
    fs.unlinkSync(path.join(dir, 'install.json'))
    expect(resolveVoicePack()).toBeNull()
  })

  it('is null for an unreadable or non-object install.json', () => {
    const dir = install()
    for (const text of ['{not json', 'null', '"text"']) {
      fs.writeFileSync(path.join(dir, 'install.json'), text)
      expect(resolveVoicePack()).toBeNull()
    }
  })

  it.each([
    ['another pack id', { packId: 'other' }],
    ['another runtime version', { runtimeVersion: '0.0.1' }],
    ['another platform', { platform: 'darwin-arm64' }],
    ['another model revision', { model: { repo: VOICE_PACK.model.repo, revision: 'deadbeef' } }]
  ])('is null for %s', (_name, overrides) => {
    install(record(overrides))
    expect(resolveVoicePack()).toBeNull()
  })

  it('is null on a platform the pack has no runtime for', () => {
    install()
    mocks.platform = null
    expect(resolveVoicePack()).toBeNull()
  })

  it("is null when the wrapper's package.json is missing", () => {
    const dir = install()
    fs.unlinkSync(path.join(dir, 'runtime', 'node_modules', 'sherpa-onnx-node', 'package.json'))
    expect(resolveVoicePack()).toBeNull()
  })

  it("is null when the platform package's native binary is missing (quarantined)", () => {
    const dir = install()
    fs.unlinkSync(path.join(dir, 'runtime', 'node_modules', ADDON_PACKAGE, 'sherpa-onnx.node'))
    expect(resolveVoicePack()).toBeNull()
  })

  it('is null when the platform package is for another platform', () => {
    // A binary sitting under the wrong package name does not satisfy this host.
    const dir = install()
    const modules = path.join(dir, 'runtime', 'node_modules')
    fs.renameSync(path.join(modules, ADDON_PACKAGE), path.join(modules, 'sherpa-onnx-win-x64'))
    expect(resolveVoicePack()).toBeNull()
  })

  it('is null when a model file is missing', () => {
    const dir = install()
    fs.unlinkSync(path.join(dir, 'model', 'tokens.txt'))
    expect(resolveVoicePack()).toBeNull()
  })

  it('is null when a model file has the wrong size', () => {
    const dir = install()
    fs.writeFileSync(path.join(dir, 'model', 'encoder.int8.onnx'), Buffer.alloc(9))
    expect(resolveVoicePack()).toBeNull()
  })

  it('is null when a model "file" is a directory', () => {
    const dir = install()
    fs.unlinkSync(path.join(dir, 'model', 'tokens.txt'))
    fs.mkdirSync(path.join(dir, 'model', 'tokens.txt'))
    expect(resolveVoicePack()).toBeNull()
  })
})
