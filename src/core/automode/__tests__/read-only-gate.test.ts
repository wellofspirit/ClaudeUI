/**
 * ADR-084 §1/§2 — the shared engine glue in front of the auto-mode judge.
 *
 * `read-only.ts` owns WHAT is read-only (its own suite); this suite owns the
 * gate around it: the auto-mode and opt-out switches, the repo-armed git
 * config capture (armed or unverifiable → refuse), the `workdir` contract per
 * engine, the host realpath mapping, and the log lines.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockLogger, mockLoadShared } = vi.hoisted(() => ({
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockLoadShared: vi.fn(() => ({}))
}))
vi.mock('../../services/logger', () => ({ logger: mockLogger }))
vi.mock('../../services/ui-config', () => ({ loadSharedAutoModeConfig: mockLoadShared }))

import {
  effectiveShellCwd,
  hostRealpath,
  readOnlyGate,
  type ReadOnlyGateInput
} from '../read-only-gate'
import { READ_ONLY_REVIEW_RATIONALE, readOnlyReviewBlock } from '../denial-tracker'

const clean = vi.fn(async (_cwd: string): Promise<string[] | null> => [])

function input(command: string, extra: Partial<ReadOnlyGateInput> = {}): ReadOnlyGateInput {
  return {
    action: { toolName: 'bash', input: { command } },
    cwd: '/repo',
    permissions: { allow: [], ask: [], deny: [], additionalDirectories: [] },
    shared: {},
    autoModeActive: () => true,
    honoursWorkdir: true,
    logSource: 'TestSession',
    platform: 'linux',
    // Every path exists and is itself (no symlinks).
    realpath: (p) => p,
    captureGitConfig: clean,
    ...extra
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  clean.mockResolvedValue([])
})

describe('readOnlyGate — allow', () => {
  it('allows a plainly read-only command and logs the static verdict line', async () => {
    expect(await readOnlyGate(input('ls src'))).toEqual({ allow: true, summary: 'ls src' })
    expect(mockLogger.info).toHaveBeenCalledWith(
      'TestSession',
      'auto-mode allow (stage=static) bash — read-only'
    )
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'TestSession',
      'auto-mode read-only allow: ls src'
    )
    // No git segment → no capture.
    expect(clean).not.toHaveBeenCalled()
  })

  it('allows git status only after a clean capture in the session cwd', async () => {
    expect(await readOnlyGate(input('git status'))).toMatchObject({ allow: true })
    expect(clean).toHaveBeenCalledWith('/repo')
  })

  it('never puts the command text in an info line (echo/rg literals are allowlisted)', async () => {
    const secret = 'sk-live-0123456789abcdef'
    for (const cmd of [`echo ${secret}`, `rg ${secret} src`]) {
      mockLogger.info.mockClear()
      expect(await readOnlyGate(input(cmd)), cmd).toMatchObject({ allow: true })
      expect(mockLogger.info).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(mockLogger.info.mock.calls)).not.toContain(secret)
    }
  })

  it('runs the capture where opencode runs the command: workdir, resolved against cwd', async () => {
    const r = await readOnlyGate({
      ...input('git status'),
      action: { toolName: 'bash', input: { command: 'git status', workdir: 'packages/app' } }
    })
    expect(r).toMatchObject({ allow: true })
    expect(clean).toHaveBeenCalledWith('/repo/packages/app')
  })
})

describe('readOnlyGate — refusals fall through to the judge', () => {
  it('refuses what the checker refuses, with its reason at debug', async () => {
    const r = await readOnlyGate(input('cat .npmrc'))
    expect(r).toEqual({ allow: false, reason: expect.stringMatching(/^path:/) })
    expect(mockLogger.info).not.toHaveBeenCalled()
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'TestSession',
      expect.stringMatching(/^auto-mode read-only bypass refused \(path:/)
    )
  })

  it('refuses git in a repo whose config is armed, naming the keys', async () => {
    clean.mockResolvedValueOnce(['core.fsmonitor', 'diff.external'])
    expect(await readOnlyGate(input('git diff'))).toEqual({
      allow: false,
      reason: 'git-config-armed core.fsmonitor,diff.external'
    })
  })

  it('refuses git when the capture cannot tell (null) or throws', async () => {
    clean.mockResolvedValueOnce(null)
    expect(await readOnlyGate(input('git status'))).toEqual({
      allow: false,
      reason: 'git-config-unverified'
    })
    clean.mockRejectedValueOnce(new Error('spawn EPERM'))
    expect(await readOnlyGate(input('git status'))).toEqual({
      allow: false,
      reason: 'git-config-unverified'
    })
  })

  it('refuses when the user left auto mode while the capture ran', async () => {
    let active = true
    clean.mockImplementationOnce(async () => {
      active = false
      return []
    })
    const r = await readOnlyGate({ ...input('git status'), autoModeActive: () => active })
    expect(r).toEqual({ allow: false, reason: 'auto-mode-off' })
  })

  it('refuses a workdir on an engine whose shell has none (pi)', async () => {
    const r = await readOnlyGate({
      ...input('ls'),
      honoursWorkdir: false,
      action: { toolName: 'bash', input: { command: 'ls', workdir: '.git' } }
    })
    expect(r).toEqual({ allow: false, reason: 'input:workdir-unsupported' })
  })

  it('refuses a non-shell tool without logging', async () => {
    const r = await readOnlyGate({ ...input(''), action: { toolName: 'webfetch', input: {} } })
    expect(r).toEqual({ allow: false, reason: 'not-shell' })
    expect(mockLogger.debug).not.toHaveBeenCalled()
  })

  it('decides a non-shell tool before reading automode.json or the auto-mode flag', async () => {
    const { shared: _drop, ...rest } = input('')
    const autoModeActive = vi.fn(() => true)
    for (const toolName of ['edit', 'write', 'webfetch', 'read']) {
      const r = await readOnlyGate({
        ...rest,
        autoModeActive,
        action: { toolName, input: { filePath: 'a.ts' } }
      })
      expect(r, toolName).toEqual({ allow: false, reason: 'not-shell' })
    }
    expect(mockLoadShared).not.toHaveBeenCalled()
    expect(autoModeActive).not.toHaveBeenCalled()
  })

  it("re-checks the user's Bash ask rules per segment", async () => {
    const r = await readOnlyGate(
      input('ls && git log', {
        permissions: { allow: [], ask: ['Bash(git log:*)'], deny: [], additionalDirectories: [] }
      })
    )
    expect(r).toEqual({ allow: false, reason: expect.stringMatching(/^rule:Bash/) })
  })

  it('honours additionalDirectories as scope', async () => {
    const outside = input('ls /data/logs')
    expect(await readOnlyGate(outside)).toMatchObject({ allow: false })
    const granted = input('ls /data/logs', {
      permissions: { allow: [], ask: [], deny: [], additionalDirectories: ['/data'] }
    })
    expect(await readOnlyGate(granted)).toMatchObject({ allow: true })
  })
})

describe('readOnlyGate — switches', () => {
  it('is not used outside auto mode: nothing runs, nothing is logged', async () => {
    const r = await readOnlyGate({ ...input('git status'), autoModeActive: () => false })
    expect(r).toEqual({ allow: false, reason: 'auto-mode-off' })
    expect(clean).not.toHaveBeenCalled()
    expect(mockLogger.debug).not.toHaveBeenCalled()
    expect(mockLogger.info).not.toHaveBeenCalled()
  })

  it('readOnlyBypass: false opts out; true and absent are on', async () => {
    const off = await readOnlyGate({ ...input('ls'), shared: { readOnlyBypass: false } })
    expect(off).toEqual({ allow: false, reason: 'opted-out' })
    expect(mockLogger.debug).not.toHaveBeenCalled()
    expect(await readOnlyGate({ ...input('ls'), shared: { readOnlyBypass: true } })).toMatchObject({
      allow: true
    })
  })

  it('a hand-edited non-boolean readOnlyBypass fails closed toward off', async () => {
    // The file is user-editable; IPC and save normalise, a text editor does not.
    for (const v of ['false', 'true', 0, 1, null, 'off', {}]) {
      const shared = { readOnlyBypass: v } as unknown as ReadOnlyGateInput['shared']
      expect(await readOnlyGate({ ...input('ls'), shared }), JSON.stringify(v)).toEqual({
        allow: false,
        reason: 'opted-out'
      })
    }
    // Absent is on, from a fresh read too.
    const { shared: _drop, ...rest } = input('ls')
    mockLoadShared.mockReturnValueOnce({ readOnlyBypass: 'false' } as never)
    expect(await readOnlyGate(rest)).toEqual({ allow: false, reason: 'opted-out' })
    expect(await readOnlyGate({ ...input('ls'), shared: {} })).toMatchObject({ allow: true })
  })

  it('reads automode.json FRESH on every call when no config is passed', async () => {
    const { shared: _drop, ...rest } = input('ls')
    mockLoadShared.mockReturnValueOnce({ readOnlyBypass: false })
    expect(await readOnlyGate(rest)).toEqual({ allow: false, reason: 'opted-out' })
    mockLoadShared.mockReturnValueOnce({})
    expect(await readOnlyGate(rest)).toMatchObject({ allow: true })
    expect(mockLoadShared).toHaveBeenCalledTimes(2)
  })

  it('a thrown config read is a refusal, never an exception', async () => {
    const { shared: _drop, ...rest } = input('ls')
    mockLoadShared.mockImplementationOnce(() => {
      throw new Error('EACCES')
    })
    expect(await readOnlyGate(rest)).toEqual({ allow: false, reason: 'internal' })
  })
})

describe('readOnlyReviewBlock', () => {
  it('is an auto-mode approval with the fixed rationale and no rule', () => {
    expect(readOnlyReviewBlock('call_1', 'rev_1')).toEqual({
      type: 'tool_review',
      toolUseId: 'call_1',
      reviewId: 'rev_1',
      reviewer: 'auto-mode',
      decision: 'approved',
      rationale: 'Read-only command in the workspace — allowed without a judge call'
    })
    expect(READ_ONLY_REVIEW_RATIONALE).toBe(
      'Read-only command in the workspace — allowed without a judge call'
    )
  })
})

describe('effectiveShellCwd', () => {
  it('is the session cwd unless the engine honours a workdir', () => {
    expect(effectiveShellCwd('/repo', { command: 'ls' }, true, 'linux')).toBe('/repo')
    expect(effectiveShellCwd('/repo', { workdir: 'a/b' }, true, 'linux')).toBe('/repo/a/b')
    expect(effectiveShellCwd('/repo', { workdir: '/elsewhere' }, true, 'linux')).toBe('/elsewhere')
    expect(effectiveShellCwd('/repo', { workdir: 'a/b' }, false, 'linux')).toBe('/repo')
    expect(effectiveShellCwd('/repo', { workdir: 7 }, true, 'linux')).toBeNull()
  })

  it('folds the Git-Bash spelling on win32', () => {
    expect(effectiveShellCwd('D:\\repo', { workdir: '/d/other' }, true, 'win32')).toBe('d:/other')
    expect(effectiveShellCwd('D:\\repo', { workdir: 'sub' }, true, 'win32')).toBe('d:/repo/sub')
  })
})

describe('hostRealpath', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claudeui-ro-gate-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('resolves an existing path, and says undefined for ENOENT and ENOTDIR', () => {
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'x')
    expect(typeof hostRealpath(file)).toBe('string')
    expect(hostRealpath(join(dir, 'missing'))).toBeUndefined()
    expect(hostRealpath(join(file, 'under-a-file'))).toBeUndefined()
  })
})
