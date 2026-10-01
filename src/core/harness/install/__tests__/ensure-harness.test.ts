/**
 * @vitest-environment node
 *
 * `bun run ensure-{opencode,pi,codex}` / `update-*` (`scripts/ensure-harness.mjs`,
 * ADR-082 §8): a thin wrapper over the app's installer. Its own logic is the
 * arguments, the Codex host skip, `update-*`'s move-aside, and the exit code;
 * the installer is replaced here, so nothing downloads.
 */
import { describe, expect, it, vi } from 'vitest'
import { ensureHarness, parseEnsureArgs } from '../../../../../scripts/ensure-harness.mjs'

type Deps = NonNullable<Parameters<typeof ensureHarness>[2]>

function harness(overrides: Partial<Deps> = {}) {
  const out: string[] = []
  const err: string[] = []
  const deps = {
    tested: vi.fn(() => '1.2.3'),
    hostSupported: vi.fn(() => true),
    isValid: vi.fn(() => false),
    exists: vi.fn(() => false),
    dir: vi.fn((id: string, version: string) => `/store/${id}/${version}`),
    remove: vi.fn(async () => {}),
    install: vi.fn(async (id: string, version: string) => ({
      status: 'installed' as const,
      id,
      version,
      verified: 'reviewed' as const
    })),
    onProgress: vi.fn(() => () => {}),
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
    ...overrides
  }
  return { deps, out, err }
}

describe('parseEnsureArgs', () => {
  it('takes --force and --quiet, in any order, and nothing else', () => {
    expect(parseEnsureArgs([])).toEqual({ force: false, quiet: false })
    expect(parseEnsureArgs(['--quiet', '--force'])).toEqual({ force: true, quiet: true })
    expect(() => parseEnsureArgs(['--archive', 'x.tar.gz'])).toThrow(/unknown argument: --archive/)
    expect(() => parseEnsureArgs(['force'])).toThrow()
  })
})

describe('ensureHarness', () => {
  it('installs the tested version through the installer and exits 0', async () => {
    const { deps, out } = harness()
    expect(await ensureHarness('opencode', ['--quiet'], deps)).toBe(0)
    expect(deps.install).toHaveBeenCalledWith('opencode', '1.2.3')
    expect(deps.remove).not.toHaveBeenCalled()
    expect(out).toEqual([
      '[ensure-opencode] opencode 1.2.3 installed and verified (reviewed) in /store/opencode/1.2.3'
    ])
  })

  it('keeps a valid install without asking the installer', async () => {
    const { deps, out } = harness({ isValid: vi.fn(() => true), exists: vi.fn(() => true) })
    expect(await ensureHarness('pi', [], deps)).toBe(0)
    expect(deps.install).not.toHaveBeenCalled()
    expect(out).toEqual(['[ensure-pi] pi 1.2.3 is already installed (/store/pi/1.2.3)'])
  })

  it('--force (update-*) moves the installed version aside, then installs it again', async () => {
    const order: string[] = []
    const { deps } = harness({
      isValid: vi.fn(() => true),
      exists: vi.fn(() => true),
      remove: vi.fn(async () => {
        order.push('remove')
      }),
      install: vi.fn(async (id: string, version: string) => {
        order.push('install')
        return { status: 'installed' as const, id, version, verified: 'reviewed' as const }
      })
    })
    expect(await ensureHarness('opencode', ['--force', '--quiet'], deps)).toBe(0)
    expect(deps.remove).toHaveBeenCalledWith('opencode', '1.2.3')
    expect(order).toEqual(['remove', 'install'])
  })

  it('--force with nothing installed just installs', async () => {
    const { deps } = harness()
    expect(await ensureHarness('pi', ['--force', '--quiet'], deps)).toBe(0)
    expect(deps.remove).not.toHaveBeenCalled()
    expect(deps.install).toHaveBeenCalledOnce()
  })

  it('--force leaves a version it cannot move aside alone and fails, without installing', async () => {
    const busy = Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    const { deps, err } = harness({
      exists: vi.fn(() => true),
      remove: vi.fn(async () => {
        throw busy
      })
    })
    expect(await ensureHarness('codex', ['--force'], deps)).toBe(1)
    expect(deps.install).not.toHaveBeenCalled()
    expect(err[0]).toMatch(/Codex 1\.2\.3 could not be moved aside and was left as it is \(EPERM\)/)
  })

  it('exits 1 with the installer reason on a failed install', async () => {
    const { deps, err } = harness({
      install: vi.fn(async (id: string, version: string) => ({
        status: 'failed' as const,
        id,
        version,
        reason: 'the reviewed digest did not match'
      }))
    })
    expect(await ensureHarness('pi', ['--quiet'], deps)).toBe(1)
    expect(err).toEqual(['[ensure-pi] the reviewed digest did not match'])
  })

  it('skips Codex with one line and exit 0 on a host without a reviewed release', async () => {
    const { deps, out } = harness({ hostSupported: vi.fn(() => false) })
    expect(await ensureHarness('codex', [], deps)).toBe(0)
    expect(deps.install).not.toHaveBeenCalled()
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/^\[ensure-codex\] skipped: Codex has no reviewed release for /)
  })

  it('exits 2 on an unknown argument or a harness with no managed copy', async () => {
    const bad = harness()
    expect(await ensureHarness('opencode', ['--update'], bad.deps)).toBe(2)
    expect(bad.err[0]).toMatch(/unknown argument: --update/)
    expect(bad.deps.install).not.toHaveBeenCalled()
    const claude = harness()
    expect(await ensureHarness('claude', [], claude.deps)).toBe(2)
    expect(claude.deps.install).not.toHaveBeenCalled()
  })

  it('reports each phase of its own install unless --quiet', async () => {
    let listener: ((p: { id: string; version: string; phase: string }) => void) | null = null
    const { deps, out } = harness({
      onProgress: vi.fn((fn) => {
        listener = fn
        return () => {
          listener = null
        }
      }),
      install: vi.fn(async (id: string, version: string) => {
        for (const phase of ['resolving', 'downloading', 'downloading', 'verifying', 'done']) {
          listener?.({ id, version, phase })
        }
        listener?.({ id: 'pi', version, phase: 'downloading' })
        return { status: 'installed' as const, id, version, verified: 'reviewed' as const }
      })
    })
    expect(await ensureHarness('opencode', [], deps)).toBe(0)
    expect(out.slice(0, -1)).toEqual([
      '[ensure-opencode] resolving...',
      '[ensure-opencode] downloading...',
      '[ensure-opencode] verifying...'
    ])
    // Unsubscribed afterwards.
    expect(listener).toBeNull()
  })
})
