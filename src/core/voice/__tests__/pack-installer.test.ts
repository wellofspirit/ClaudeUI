/**
 * @vitest-environment node
 *
 * The speech-pack installer (ADR-101 §5–6) against a fake fetch serving a tiny
 * fake pack: the real download, hashing, extraction, staging and commit code runs
 * over a few hundred bytes. The manifest is mocked down to those bytes (the
 * digests it pins are the digests of what the fake serves) and the platform is
 * pinned, so the suite is the same on every CI host. Nothing touches the network
 * or the real `~/.claude/ui/voice`: the store is a temp dir (`CLAUDEUI_VOICE_STORE`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const mocks = vi.hoisted(() => ({ platform: 'linux-x64' as string | null }))

vi.mock('../../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }
}))

vi.mock('../../../shared/voice-pack', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/voice-pack')>()
  const { fakeVoicePack } = await import('./fake-voice-pack')
  return {
    ...actual,
    VOICE_PACK: fakeVoicePack(actual.VOICE_PACK),
    voicePackPlatformKey: () => mocks.platform
  }
})

import { VOICE_PACK, voicePackModelUrl, type VoicePackStatus } from '../../../shared/voice-pack'
import {
  fakeFetch,
  hangingBody,
  sha256,
  tarEntry,
  tgz,
  type Route
} from '../../harness/install/__tests__/fixtures'
import { cleanStaleEntriesIn } from '../../harness/install/store-writer'
import { logger } from '../../services/logger'
import {
  createVoicePackInstaller,
  sweepVoicePackStore,
  type VoicePackInstaller
} from '../pack-installer'
import {
  VOICE_STORE_ENV,
  resolveVoicePack,
  voicePackDir,
  type VoiceInstallRecord
} from '../pack-store'
import { MODEL_BODIES, PLATFORM_PACKAGE, WRAPPER, fakeTarball } from './fake-voice-pack'

const WRAPPER_URL = VOICE_PACK.runtime.wrapper.tarball
const PLATFORM_URL = VOICE_PACK.runtime.platforms['linux-x64'].tarball
const modelUrl = (name: string): string => voicePackModelUrl(name)
const ENCODER_EDGE = 'https://us.aws.cdn.hf.co/xet-bridge-us/encoder.int8.onnx?sig=secret'

/** Every URL the install makes at the origin (not redirect hops), in order. */
const FIRST_HOPS = [
  WRAPPER_URL,
  PLATFORM_URL,
  ...Object.keys(MODEL_BODIES).map((name) => modelUrl(name))
]

let root: string
let savedEnv: string | undefined

beforeEach(() => {
  savedEnv = process.env[VOICE_STORE_ENV]
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claudeui-voice-installer-')))
  process.env[VOICE_STORE_ENV] = root
  mocks.platform = 'linux-x64'
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env[VOICE_STORE_ENV]
  else process.env[VOICE_STORE_ENV] = savedEnv
  fs.rmSync(root, { recursive: true, force: true })
})

/**
 * What Hugging Face does, seen from here (2026-10-12): a large file answers 302 to
 * a regional CDN host, a small one 307 to a relative `/api/resolve-cache/…` path
 * on the same host.
 */
function goodRoutes(): Record<string, Route> {
  const routes: Record<string, Route> = {
    [WRAPPER_URL]: { body: fakeTarball(WRAPPER) },
    [PLATFORM_URL]: { body: fakeTarball(PLATFORM_PACKAGE) }
  }
  for (const [name, body] of Object.entries(MODEL_BODIES)) {
    if (name === 'tokens.txt') {
      const resolved = `https://huggingface.co/api/resolve-cache/models/x/${name}`
      routes[modelUrl(name)] = () =>
        new Response(null, {
          status: 307,
          headers: { location: `/api/resolve-cache/models/x/${name}?etag=%22abc%22` }
        })
      routes[`${resolved}?etag=%22abc%22`] = { body }
    } else {
      const edge = `https://us.aws.cdn.hf.co/xet-bridge-us/${name}?sig=secret`
      routes[modelUrl(name)] = { redirect: edge }
      routes[edge] = { body }
    }
  }
  return routes
}

/** Routes where a pack directory shows up (another process) while the encoder downloads. */
function racingRoutes(): Record<string, Route> {
  const routes = goodRoutes()
  routes[ENCODER_EDGE] = () => {
    fs.mkdirSync(path.join(voicePackDir(), 'model'), { recursive: true })
    fs.writeFileSync(path.join(voicePackDir(), 'model', 'raced'), 'x')
    return new Response(new Uint8Array(MODEL_BODIES['encoder.int8.onnx']))
  }
  return routes
}

interface Harness {
  installer: VoicePackInstaller
  fetched: ReturnType<typeof fakeFetch>
  suspend: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
  events: VoicePackStatus[]
}

function harness(
  routes: Record<string, Route> = goodRoutes(),
  opts: { now?: () => number; suspend?: (reason: string) => Promise<() => void> } = {}
): Harness {
  const fetched = fakeFetch(routes)
  const release = vi.fn()
  const suspend = vi.fn(opts.suspend ?? (async () => release))
  const installer = createVoicePackInstaller({
    fetch: async () => fetched.fetch,
    suspend,
    ...(opts.now ? { now: opts.now } : {})
  })
  const events: VoicePackStatus[] = []
  installer.onChange((status) => events.push(status))
  return { installer, fetched, suspend, release, events }
}

const entries = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [])
const stagingEntries = (): string[] => entries(path.join(root, '.staging'))
const trashEntries = (): string[] => entries(path.join(root, '.trash'))
const originOf = (url: string): string => url.split('?')[0]

/** The real, installed `install.json`. */
function installedRecord(): VoiceInstallRecord {
  return JSON.parse(fs.readFileSync(path.join(voicePackDir(), 'install.json'), 'utf-8'))
}

describe('install: the good path', () => {
  it('downloads, verifies, extracts and publishes a pack that resolves', async () => {
    const h = harness()
    expect(h.installer.status().state).toBe('missing')

    await expect(h.installer.install()).resolves.toEqual({ status: 'installed' })

    const pack = resolveVoicePack()
    expect(pack).not.toBeNull()
    // The npm tarballs' `package/` prefix is stripped, and the platform package sits
    // BESIDE the wrapper so its `../sherpa-onnx-<plat>/sherpa-onnx.node` lookup resolves.
    const modules = path.join(voicePackDir(), 'runtime', 'node_modules')
    expect(pack!.addonDir).toBe(path.join(modules, WRAPPER))
    expect(fs.readFileSync(path.join(modules, WRAPPER, 'package.json'), 'utf-8')).toContain(WRAPPER)
    expect(fs.readFileSync(path.join(modules, PLATFORM_PACKAGE, 'sherpa-onnx.node'), 'utf-8')).toBe(
      'native-binary'
    )
    expect(fs.existsSync(path.join(modules, WRAPPER, 'package'))).toBe(false)
    for (const [name, body] of Object.entries(MODEL_BODIES)) {
      expect(fs.readFileSync(path.join(pack!.modelDir, name))).toEqual(body)
    }

    // The record names what was installed, with a sha256 per file.
    const record = installedRecord()
    expect(record).toMatchObject({
      packId: VOICE_PACK.id,
      runtimeVersion: VOICE_PACK.runtime.version,
      platform: 'linux-x64',
      model: { repo: VOICE_PACK.model.repo, revision: VOICE_PACK.model.revision }
    })
    expect(record.files[`model/tokens.txt`]).toBe(sha256(MODEL_BODIES['tokens.txt']))
    expect(record.files[`runtime/node_modules/${WRAPPER}/package.json`]).toBe(
      sha256(`{"name":"${WRAPPER}"}`)
    )
    expect(Object.keys(record.files).every((file) => !file.includes('\\'))).toBe(true)

    // Nothing is left behind, and a fresh slot needed no worker hold.
    expect(stagingEntries()).toEqual([])
    expect(entries(root).sort()).toEqual(['.staging', VOICE_PACK.id])
    expect(h.suspend).not.toHaveBeenCalled()
    expect(h.installer.status().state).toBe('ready')
  })

  it('takes the registry first, then the model smallest file first, following HF redirects', async () => {
    const h = harness()
    await h.installer.install()
    const origin = h.fetched.calls.map(originOf).filter((url) => FIRST_HOPS.includes(url))
    expect(origin).toEqual([
      WRAPPER_URL,
      PLATFORM_URL,
      modelUrl('tokens.txt'),
      modelUrl('joiner.int8.onnx'),
      modelUrl('decoder.int8.onnx'),
      modelUrl('encoder.int8.onnx')
    ])
    // Both redirect shapes were actually followed.
    expect(h.fetched.calls.some((url) => url.startsWith('https://us.aws.cdn.hf.co/'))).toBe(true)
    expect(h.fetched.calls.some((url) => url.includes('/api/resolve-cache/'))).toBe(true)
  })

  it('reports installing → ready, with progress that never runs backwards or past its total', async () => {
    let clock = 0
    // Every call is 300 ms later than the last, so no progress event is throttled away.
    const h = harness(goodRoutes(), { now: () => (clock += 300) })
    await h.installer.install()

    const states = h.events.map((e) => e.state)
    expect(states[0]).toBe('installing')
    expect(states.at(-1)).toBe('ready')
    expect(states.slice(0, -1).every((s) => s === 'installing')).toBe(true)
    const progress = h.events.flatMap((e) => (e.progress ? [e.progress] : []))
    expect(progress.length).toBeGreaterThan(4)
    for (const [i, p] of progress.entries()) {
      expect(p.receivedBytes).toBeLessThanOrEqual(p.totalBytes)
      if (i > 0) {
        expect(p.receivedBytes).toBeGreaterThanOrEqual(progress[i - 1].receivedBytes)
        expect(p.totalBytes).toBeGreaterThanOrEqual(progress[i - 1].totalBytes)
      }
    }
    expect(h.events.at(-1)).toMatchObject({
      packId: VOICE_PACK.id,
      label: VOICE_PACK.label,
      approxBytes: 700_000_000
    })
  })

  it('throttles progress to one event per interval but never swallows a state change', async () => {
    // A frozen clock: every progress event is inside the interval of the first.
    const h = harness(goodRoutes(), { now: () => 1_000 })
    await h.installer.install()
    expect(h.events.map((e) => e.state)).toEqual(['installing', 'ready'])
  })

  it('is satisfied, with no download, when a usable pack is already there', async () => {
    const first = harness()
    await first.installer.install()

    const second = harness()
    await expect(second.installer.install()).resolves.toEqual({ status: 'satisfied' })
    expect(second.fetched.calls).toEqual([])
    expect(second.events).toEqual([])
  })

  it('refuses on a host with no speech runtime, without a fetch', async () => {
    mocks.platform = null
    const h = harness()
    expect(h.installer.status().state).toBe('unsupported')
    await expect(h.installer.install()).resolves.toMatchObject({ status: 'failed' })
    expect(h.fetched.calls).toEqual([])
    expect(entries(root)).toEqual([])
  })
})

describe('install: one at a time', () => {
  it('joins a second request to the first', async () => {
    const h = harness()
    const [a, b] = await Promise.all([h.installer.install(), h.installer.install()])
    expect(a).toEqual({ status: 'installed' })
    expect(b).toEqual({ status: 'installed' })
    // One download of each file, not two.
    for (const url of FIRST_HOPS) {
      expect(h.fetched.calls.filter((call) => call === url)).toHaveLength(1)
    }
  })

  it('answers installing while it runs, and cancel ends it for every caller', async () => {
    let atEncoder!: () => void
    const reached = new Promise<void>((resolve) => (atEncoder = resolve))
    const routes = goodRoutes()
    routes[`https://us.aws.cdn.hf.co/xet-bridge-us/encoder.int8.onnx?sig=secret`] = hangingBody(
      'E',
      () => atEncoder()
    )
    const h = harness(routes)

    const a = h.installer.install()
    const b = h.installer.install()
    await reached

    expect(h.installer.status()).toMatchObject({ state: 'installing' })
    // An interrupted install (a quit here) leaves only `.staging`; no pack directory.
    expect(entries(root)).toEqual(['.staging'])
    expect(resolveVoicePack()).toBeNull()

    expect(h.installer.cancel()).toBe(true)
    await expect(a).resolves.toEqual({ status: 'cancelled' })
    await expect(b).resolves.toEqual({ status: 'cancelled' })

    expect(stagingEntries()).toEqual([])
    expect(entries(root)).toEqual(['.staging'])
    // A cancel is not a failure: the next status is plain "missing".
    expect(h.installer.status()).toMatchObject({ state: 'missing' })
    expect(h.events.at(-1)?.state).toBe('missing')
    expect(h.installer.cancel()).toBe(false)
  })

  it('can be installed again after a cancel', async () => {
    let atEncoder!: () => void
    const reached = new Promise<void>((resolve) => (atEncoder = resolve))
    const hanging = goodRoutes()
    hanging[`https://us.aws.cdn.hf.co/xet-bridge-us/encoder.int8.onnx?sig=secret`] = hangingBody(
      'E',
      () => atEncoder()
    )
    const h = harness(hanging)
    const first = h.installer.install()
    await reached
    h.installer.cancel()
    await first

    // The same installer, the network now healthy.
    for (const [url, route] of Object.entries(goodRoutes())) h.fetched.routes.set(url, route)
    await expect(h.installer.install()).resolves.toEqual({ status: 'installed' })
    expect(resolveVoicePack()).not.toBeNull()
  })
})

describe('install: verification', () => {
  it('fails a tarball that does not match its pinned sha512 integrity, and publishes nothing', async () => {
    const tampered = tgz([
      tarEntry('package/package.json', `{"name":"${WRAPPER}"}`),
      tarEntry('package/evil.js', 'process.exit(1)')
    ])
    const h = harness({ ...goodRoutes(), [WRAPPER_URL]: { body: tampered } })

    const result = await h.installer.install()
    expect(result).toMatchObject({ status: 'failed' })
    expect(result.message).toMatch(/does not match its pinned integrity/)
    expect(entries(root)).toEqual(['.staging'])
    expect(stagingEntries()).toEqual([])
    expect(resolveVoicePack()).toBeNull()
    // It stopped there: the platform package and the model were never requested.
    expect(h.fetched.calls).toEqual([WRAPPER_URL])
    expect(h.installer.status()).toMatchObject({ state: 'failed', error: result.message })
    expect(h.events.at(-1)).toMatchObject({ state: 'failed', error: result.message })
  })

  it('fails a model file whose bytes hash differently from the pinned sha256', async () => {
    const wrong = Buffer.from('X'.repeat(MODEL_BODIES['decoder.int8.onnx'].length))
    const edge = 'https://us.aws.cdn.hf.co/xet-bridge-us/decoder.int8.onnx?sig=secret'
    const h = harness({ ...goodRoutes(), [edge]: { body: wrong } })

    const result = await h.installer.install()
    expect(result).toMatchObject({ status: 'failed' })
    expect(result.message).toMatch(/decoder\.int8\.onnx does not match its pinned sha256/)
    expect(stagingEntries()).toEqual([])
    expect(resolveVoicePack()).toBeNull()
  })

  it('fails a model file shorter than its pinned size', async () => {
    const edge = 'https://us.aws.cdn.hf.co/xet-bridge-us/joiner.int8.onnx?sig=secret'
    const h = harness({
      ...goodRoutes(),
      [edge]: { body: MODEL_BODIES['joiner.int8.onnx'].subarray(1) }
    })
    const result = await h.installer.install()
    expect(result).toMatchObject({ status: 'failed' })
    expect(result.message).toMatch(/joiner\.int8\.onnx is \d+ bytes, expected 60/)
    expect(resolveVoicePack()).toBeNull()
  })

  it('cuts off a model file that keeps sending past its pinned size', async () => {
    const edge = 'https://us.aws.cdn.hf.co/xet-bridge-us/joiner.int8.onnx?sig=secret'
    const h = harness({
      ...goodRoutes(),
      [edge]: { body: Buffer.concat([MODEL_BODIES['joiner.int8.onnx'], Buffer.from('more')]) }
    })
    const result = await h.installer.install()
    expect(result).toMatchObject({ status: 'failed' })
    expect(result.message).toMatch(/over the 60 byte limit/)
    expect(stagingEntries()).toEqual([])
  })

  it('lets a failed install be retried, and a good retry clears the failure', async () => {
    const edge = 'https://us.aws.cdn.hf.co/xet-bridge-us/decoder.int8.onnx?sig=secret'
    const h = harness({ ...goodRoutes(), [edge]: { status: 503 } })
    await expect(h.installer.install()).resolves.toMatchObject({ status: 'failed' })
    expect(h.installer.status().state).toBe('failed')

    h.fetched.routes.set(edge, { body: MODEL_BODIES['decoder.int8.onnx'] })
    await expect(h.installer.install()).resolves.toEqual({ status: 'installed' })
    expect(h.installer.status()).toEqual(expect.objectContaining({ state: 'ready' }))
    expect(h.installer.status().error).toBeUndefined()
  })
})

describe('install: hosts', () => {
  it('refuses a redirect to a host outside the policy, without fetching it', async () => {
    const evil = 'https://models.evil.example/encoder.int8.onnx'
    const h = harness({ ...goodRoutes(), [modelUrl('encoder.int8.onnx')]: { redirect: evil } })
    const result = await h.installer.install()
    expect(result).toMatchObject({ status: 'failed' })
    expect(result.message).toMatch(
      /redirected to https:\/\/models\.evil\.example, which is not an allowed host/
    )
    expect(h.fetched.calls).not.toContain(evil)
    expect(stagingEntries()).toEqual([])
  })

  it.each([
    'https://evil.cdn.hf.co.attacker.com/encoder.int8.onnx',
    'https://hf.co.evil/encoder.int8.onnx',
    'https://evilhf.co/encoder.int8.onnx',
    'https://hf.co/encoder.int8.onnx',
    'https://huggingface.co.attacker.com/encoder.int8.onnx',
    'http://us.aws.cdn.hf.co/encoder.int8.onnx'
  ])('refuses a redirect to %s', async (target) => {
    const h = harness({ ...goodRoutes(), [modelUrl('encoder.int8.onnx')]: { redirect: target } })
    const result = await h.installer.install()
    expect(result).toMatchObject({ status: 'failed' })
    expect(result.message).toMatch(/not an allowed host/)
    expect(h.fetched.calls).not.toContain(target)
  })

  it.each([
    'https://cas-bridge.xethub.hf.co/xet-bridge-us/encoder.int8.onnx?sig=1',
    'https://cdn-lfs.hf.co/repos/encoder.int8.onnx?sig=1',
    'https://cdn-lfs.huggingface.co/repos/encoder.int8.onnx?sig=1'
  ])('follows a redirect to the other Hugging Face CDN generations (%s)', async (edge) => {
    const h = harness({
      ...goodRoutes(),
      [modelUrl('encoder.int8.onnx')]: { redirect: edge },
      [edge]: { body: MODEL_BODIES['encoder.int8.onnx'] }
    })
    await expect(h.installer.install()).resolves.toEqual({ status: 'installed' })
  })

  it('refuses a registry tarball that redirects anywhere (the registry does not redirect)', async () => {
    const h = harness({
      ...goodRoutes(),
      [WRAPPER_URL]: { redirect: 'https://registry.evil.example/x.tgz' }
    })
    const result = await h.installer.install()
    expect(result.message).toMatch(/not an allowed host/)
  })
})

describe('install: the store', () => {
  it('removes staging entries older than an hour and leaves a fresh one', async () => {
    const stale = path.join(root, '.staging', 'parakeet-old')
    const fresh = path.join(root, '.staging', 'parakeet-fresh')
    const staleTrash = path.join(root, '.trash', 'parakeet-old')
    for (const dir of [stale, fresh, staleTrash]) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'partial'), 'x')
    }
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    for (const dir of [stale, staleTrash]) {
      fs.utimesSync(path.join(dir, 'partial'), twoHoursAgo, twoHoursAgo)
      fs.utimesSync(dir, twoHoursAgo, twoHoursAgo)
    }

    await harness().installer.install()
    expect(stagingEntries()).toEqual(['parakeet-fresh'])
    expect(trashEntries()).toEqual([])
  })

  /** Make `entry` (a directory) look untouched for two hours. */
  function age(entry: string): void {
    fs.mkdirSync(entry, { recursive: true })
    fs.writeFileSync(path.join(entry, 'partial'), 'x')
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    fs.utimesSync(path.join(entry, 'partial'), twoHoursAgo, twoHoursAgo)
    fs.utimesSync(entry, twoHoursAgo, twoHoursAgo)
  }

  it('moves an unusable pack aside BEFORE downloading: under the hold, rename, release, then delete', async () => {
    const dir = voicePackDir()
    fs.mkdirSync(path.join(dir, 'model'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'model', 'leftover'), 'interrupted')
    const order: string[] = []
    const ref: { h?: Harness } = {}
    const routes = goodRoutes()
    routes[WRAPPER_URL] = () => {
      order.push(`first-fetch:old-present=${fs.existsSync(dir)}`)
      return new Response(new Uint8Array(fakeTarball(WRAPPER)))
    }
    const h = harness(routes, {
      suspend: async (reason) => {
        order.push(`suspend:${reason}`)
        // The old directory is still there when the hold is taken, and nothing has been fetched.
        order.push(`old-present=${fs.existsSync(path.join(dir, 'model', 'leftover'))}`)
        order.push(`fetched=${ref.h!.fetched.calls.length}`)
        return () => {
          // Released with the old pack renamed into the trash, not yet deleted.
          order.push(`release:trash=${trashEntries().length}:slot-empty=${!fs.existsSync(dir)}`)
        }
      }
    })
    ref.h = h

    await expect(h.installer.install()).resolves.toEqual({ status: 'installed' })
    expect(order).toEqual([
      'suspend:replacing the speech pack',
      'old-present=true',
      'fetched=0',
      'release:trash=1:slot-empty=true',
      'first-fetch:old-present=false'
    ])
    expect(fs.existsSync(path.join(dir, 'model', 'leftover'))).toBe(false)
    expect(resolveVoicePack()).not.toBeNull()
    expect(trashEntries()).toEqual([])
    expect(h.suspend).toHaveBeenCalledTimes(1)
  })

  it('fails before downloading anything, leaving the old directory, when the hold cannot be taken', async () => {
    const dir = voicePackDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'leftover'), 'interrupted')
    const h = harness(goodRoutes(), {
      suspend: async () => {
        throw new Error('The speech model is already being updated (removing)')
      }
    })
    const result = await h.installer.install()
    expect(result).toMatchObject({ status: 'failed' })
    expect(result.message).toMatch(/already being updated/)
    expect(fs.readFileSync(path.join(dir, 'leftover'), 'utf-8')).toBe('interrupted')
    expect(h.fetched.calls).toEqual([])
    expect(stagingEntries()).toEqual([])
  })

  it('re-checks at commit: an unusable pack that appeared meanwhile is replaced under the hold', async () => {
    const order: string[] = []
    const h = harness(racingRoutes(), {
      suspend: async () => {
        order.push('suspend')
        return () =>
          order.push(
            `release:new-pack-in-place=${resolveVoicePack() !== null}:trash=${trashEntries().length}`
          )
      }
    })
    await expect(h.installer.install()).resolves.toEqual({ status: 'installed' })
    expect(order).toEqual(['suspend', 'release:new-pack-in-place=true:trash=1'])
    expect(fs.existsSync(path.join(voicePackDir(), 'model', 'raced'))).toBe(false)
    expect(trashEntries()).toEqual([])
  })

  it('is satisfied, discarding its work, when a usable pack appeared meanwhile', async () => {
    // A finished pack, built in a second store, stands in for "another process finished first".
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claudeui-voice-other-')))
    try {
      process.env[VOICE_STORE_ENV] = other
      await harness().installer.install()
      const finished = voicePackDir()
      process.env[VOICE_STORE_ENV] = root

      const routes = goodRoutes()
      routes[ENCODER_EDGE] = () => {
        fs.cpSync(finished, voicePackDir(), { recursive: true })
        return new Response(new Uint8Array(MODEL_BODIES['encoder.int8.onnx']))
      }
      const h = harness(routes)
      await expect(h.installer.install()).resolves.toEqual({ status: 'satisfied' })
      expect(resolveVoicePack()).not.toBeNull()
      expect(stagingEntries()).toEqual([])
      expect(h.suspend).not.toHaveBeenCalled()
    } finally {
      process.env[VOICE_STORE_ENV] = root
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  it('sweeps orphans after a successful install, not only before it', async () => {
    const orphan = path.join(root, '.staging', 'parakeet-crashed')
    const routes = goodRoutes()
    routes[WRAPPER_URL] = () => {
      // Appears after the install's opening sweep has run, and is already old.
      age(orphan)
      return new Response(new Uint8Array(fakeTarball(WRAPPER)))
    }
    await harness(routes).installer.install()
    expect(fs.existsSync(orphan)).toBe(false)
  })

  it('sweeps stale staging and trash entries by itself (the boot sweep), leaving fresh ones', async () => {
    age(path.join(root, '.staging', 'parakeet-crashed'))
    age(path.join(root, '.trash', 'parakeet-stuck'))
    fs.mkdirSync(path.join(root, '.staging', 'parakeet-fresh'), { recursive: true })

    await expect(sweepVoicePackStore()).resolves.toBe(2)
    expect(stagingEntries()).toEqual(['parakeet-fresh'])
    expect(trashEntries()).toEqual([])
  })

  it('does not sweep a live install: its payload stays fresh while its downloads directory is', async () => {
    let during: string[] = []
    const routes = goodRoutes()
    routes[ENCODER_EDGE] = async () => {
      // Another process sweeps the shared store mid-install and finds the payload
      // old (nothing is written into it while the big file streams elsewhere).
      const staging = path.join(root, '.staging')
      const payload = fs.readdirSync(staging).find((name) => !name.endsWith('.downloads'))!
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
      const dir = path.join(staging, payload)
      for (const entry of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, entry), old, old)
      fs.utimesSync(dir, old, old)
      await cleanStaleEntriesIn(root, new Set())
      during = stagingEntries()
      return new Response(new Uint8Array(MODEL_BODIES['encoder.int8.onnx']))
    }
    await expect(harness(routes).installer.install()).resolves.toEqual({ status: 'installed' })
    expect(during).toHaveLength(2)
  })
})

describe('install: what a client may read', () => {
  it('reduces a filesystem failure to its code: no host path in the result, the status or an event', async () => {
    // A FILE where the staging directory should be: `mkdir` fails with the full path in its text.
    fs.writeFileSync(path.join(root, '.staging'), 'not a directory')
    const h = harness()

    const result = await h.installer.install()

    expect(result).toMatchObject({ status: 'failed' })
    expect(result.message).toMatch(/\((EEXIST|ENOTDIR)\)/)
    const surfaced = [result.message, h.installer.status().error, ...h.events.map((e) => e.error)]
    const texts = surfaced.filter((text): text is string => typeof text === 'string')
    expect(texts.length).toBeGreaterThan(2)
    for (const text of texts) {
      expect(text).not.toContain(root)
      expect(text).not.toContain(os.tmpdir())
    }
    // The detail is not lost: it went to the log.
    expect(logger.warn).toHaveBeenCalledWith('VoicePack', expect.stringContaining(root))
  })

  it('passes download errors through (they name a URL, never a filesystem path)', async () => {
    const h = harness({ ...goodRoutes(), [WRAPPER_URL]: { status: 503 } })
    const result = await h.installer.install()
    expect(result.message).toContain('registry.npmjs.org')
    expect(result.message).toContain('HTTP 503')
  })

  it('reads both integrity pins before fetching anything', async () => {
    const platformPin = VOICE_PACK.runtime.platforms['linux-x64'] as { integrity: string }
    const saved = platformPin.integrity
    platformPin.integrity = 'sha1-not-a-sha512-pin'
    try {
      const h = harness()
      const result = await h.installer.install()
      expect(result).toMatchObject({ status: 'failed' })
      expect(result.message).toMatch(/no usable sha512 integrity pin/)
      expect(h.fetched.calls).toEqual([])
      expect(stagingEntries()).toEqual([])
    } finally {
      platformPin.integrity = saved
    }
  })
})

describe('install: the point of no return', () => {
  it('cannot be cancelled once committing, and still publishes', async () => {
    const seen: boolean[] = []
    const ref: { h?: Harness } = {}
    const h = harness(racingRoutes(), {
      suspend: async () => {
        // The commit has started: it is holding the worker for the rename-in.
        seen.push(ref.h!.installer.cancel())
        return () => undefined
      }
    })
    ref.h = h
    await expect(h.installer.install()).resolves.toEqual({ status: 'installed' })
    expect(seen).toEqual([false])
    expect(resolveVoicePack()).not.toBeNull()
  })

  it('reports a failure after that point as a failure, not as cancelled', async () => {
    const seen: boolean[] = []
    const ref: { h?: Harness } = {}
    const h = harness(racingRoutes(), {
      suspend: async () => {
        seen.push(ref.h!.installer.cancel())
        throw new Error('The speech model is already being updated (removing)')
      }
    })
    ref.h = h
    const result = await h.installer.install()
    expect(seen).toEqual([false])
    expect(result).toMatchObject({ status: 'failed' })
    expect(result.message).toMatch(/already being updated/)
    expect(h.installer.status().state).toBe('failed')
  })

  it('lets a removal wait for a committing install instead of aborting it', async () => {
    const ref: { h?: Harness } = {}
    let removed: Promise<unknown> | undefined
    const h = harness(racingRoutes(), {
      suspend: async (reason) => {
        if (!removed && reason.includes('replacing')) removed = ref.h!.installer.remove()
        return () => undefined
      }
    })
    ref.h = h
    await expect(h.installer.install()).resolves.toEqual({ status: 'installed' })
    await expect(removed).resolves.toEqual({ status: 'removed' })
    expect(resolveVoicePack()).toBeNull()
  })
})

describe('remove', () => {
  it('stops the worker, deletes the pack, and says so', async () => {
    const h = harness()
    await h.installer.install()
    h.events.length = 0

    await expect(h.installer.remove()).resolves.toEqual({ status: 'removed' })

    expect(h.suspend).toHaveBeenCalledWith('removing the speech pack')
    expect(h.release).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(voicePackDir())).toBe(false)
    expect(trashEntries()).toEqual([])
    expect(resolveVoicePack()).toBeNull()
    expect(h.installer.status().state).toBe('missing')
    expect(h.events.map((e) => e.state)).toEqual(['missing'])
  })

  it('reports not-installed, without stopping the worker, when there is nothing to remove', async () => {
    const h = harness()
    await expect(h.installer.remove()).resolves.toEqual({ status: 'not-installed' })
    expect(h.suspend).not.toHaveBeenCalled()
  })

  it('also clears a half-installed directory, and forgets a failure', async () => {
    const dir = voicePackDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'leftover'), 'x')
    const h = harness({ ...goodRoutes(), [WRAPPER_URL]: { status: 500 } })
    // The install moves the unusable directory aside before it fails…
    await h.installer.install()
    expect(h.installer.status().state).toBe('failed')
    expect(fs.existsSync(dir)).toBe(false)
    // …so put one back: remove clears whatever is in the slot.
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'leftover'), 'x')

    await expect(h.installer.remove()).resolves.toEqual({ status: 'removed' })
    expect(fs.existsSync(dir)).toBe(false)
    expect(h.installer.status().state).toBe('missing')
  })

  it('sweeps stale store entries when it ends, even with nothing to remove', async () => {
    const stale = path.join(root, '.trash', 'parakeet-stuck')
    fs.mkdirSync(stale, { recursive: true })
    fs.writeFileSync(path.join(stale, 'partial'), 'x')
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    fs.utimesSync(path.join(stale, 'partial'), twoHoursAgo, twoHoursAgo)
    fs.utimesSync(stale, twoHoursAgo, twoHoursAgo)

    await expect(harness().installer.remove()).resolves.toEqual({ status: 'not-installed' })
    expect(trashEntries()).toEqual([])
  })

  it('deletes the trash only after the worker hold is released', async () => {
    const h = harness()
    await h.installer.install()
    const atRelease: number[] = []
    h.suspend.mockImplementationOnce(async () => () => atRelease.push(trashEntries().length))
    await h.installer.remove()
    expect(atRelease).toEqual([1])
    expect(trashEntries()).toEqual([])
  })

  it('words a rename that will not go without the host path, and keeps the pack', async () => {
    const h = harness()
    await h.installer.install()
    // A FILE where the trash directory should be: the move-aside cannot start.
    fs.writeFileSync(path.join(root, '.trash'), 'not a directory')
    const err = await h.installer.remove().then(
      () => null,
      (e: Error) => e
    )
    expect(err?.message).toMatch(/could not be removed \((EEXIST|ENOTDIR)\)/)
    expect(err?.message).not.toContain(root)
    expect(resolveVoicePack()).not.toBeNull()
    expect(h.release).toHaveBeenCalledTimes(1)
  })

  it('leaves the pack in place and throws when the worker hold is refused', async () => {
    const h = harness()
    await h.installer.install()
    h.suspend.mockRejectedValueOnce(new Error('The speech model is already being updated (x)'))
    await expect(h.installer.remove()).rejects.toThrow(/already being updated/)
    expect(resolveVoicePack()).not.toBeNull()
  })

  it('ends an install in flight first, so no pack lands behind the removal', async () => {
    let atEncoder!: () => void
    const reached = new Promise<void>((resolve) => (atEncoder = resolve))
    const routes = goodRoutes()
    routes[`https://us.aws.cdn.hf.co/xet-bridge-us/encoder.int8.onnx?sig=secret`] = hangingBody(
      'E',
      () => atEncoder()
    )
    const h = harness(routes)
    const installing = h.installer.install()
    await reached

    await expect(h.installer.remove()).resolves.toEqual({ status: 'not-installed' })
    await expect(installing).resolves.toEqual({ status: 'cancelled' })
    expect(resolveVoicePack()).toBeNull()
    expect(stagingEntries()).toEqual([])
  })

  it('joins concurrent removals', async () => {
    const h = harness()
    await h.installer.install()
    const [a, b] = await Promise.all([h.installer.remove(), h.installer.remove()])
    expect(a).toEqual({ status: 'removed' })
    expect(b).toEqual({ status: 'removed' })
    expect(h.suspend).toHaveBeenCalledTimes(1)
  })
})

describe('status', () => {
  it('is a cheap read: ready from the store, with no listener or job needed', async () => {
    await harness().installer.install()
    const fresh = harness().installer
    expect(fresh.status()).toEqual({
      state: 'ready',
      packId: VOICE_PACK.id,
      label: VOICE_PACK.label,
      approxBytes: 700_000_000
    })
  })

  it('reads missing for a directory without a readable record', () => {
    fs.mkdirSync(voicePackDir(), { recursive: true })
    expect(harness().installer.status().state).toBe('missing')
  })
})
