/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import * as os from 'os'

// Mock fs and logger before importing the module under test
vi.mock('fs')
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), warn: vi.fn() }
}))

import * as fs from 'fs'
import { scanCustomCommands, _resetCache } from '../../../core/services/custom-command-scanner'

const HOME = os.homedir()
const PROJECT_CWD = '/projects/my-app'
const PROJECT_CMD_DIR = path.join(PROJECT_CWD, '.claude', 'commands')
const USER_CMD_DIR = path.join(HOME, '.claude', 'commands')

// Helper: build a mock Dirent. `isSymbolicLink` is part of the contract the
// scanner reads (symlinked command files / skill dirs are accepted) — a Dirent
// without it makes the scanner throw, not fall through.
function dirent(name: string, isFile = true): fs.Dirent {
  return {
    name,
    isFile: () => isFile,
    isDirectory: () => !isFile,
    isSymbolicLink: () => false
  } as fs.Dirent
}

function setupDirs(dirs: Record<string, fs.Dirent[]>) {
  vi.mocked(fs.existsSync).mockImplementation((p) => p.toString() in dirs)
  vi.mocked(fs.readdirSync).mockImplementation((p) => {
    const entries = dirs[p.toString()]
    if (!entries) throw new Error(`ENOENT: ${p}`)
    return entries as unknown as ReturnType<typeof fs.readdirSync>
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  _resetCache()
  vi.mocked(fs.existsSync).mockReturnValue(false)
  vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('scanCustomCommands', () => {
  it('returns empty array when no command directories exist', () => {
    expect(scanCustomCommands(PROJECT_CWD)).toEqual([])
  })

  it('scans project .claude/commands/ for .md files', () => {
    setupDirs({
      [PROJECT_CMD_DIR]: [dirent('refactor.md'), dirent('deploy.md')]
    })

    const result = scanCustomCommands(PROJECT_CWD)
    expect(result).toEqual(['/refactor', '/deploy'])
  })

  it('scans user ~/.claude/commands/ for .md files', () => {
    setupDirs({
      [USER_CMD_DIR]: [dirent('global-lint.md')]
    })

    const result = scanCustomCommands(PROJECT_CWD)
    expect(result).toEqual(['/global-lint'])
  })

  it('merges project and user commands, project takes precedence', () => {
    setupDirs({
      [PROJECT_CMD_DIR]: [dirent('refactor.md'), dirent('test.md')],
      [USER_CMD_DIR]: [dirent('refactor.md'), dirent('lint.md')]
    })

    const result = scanCustomCommands(PROJECT_CWD)
    expect(result).toEqual(['/refactor', '/test', '/lint'])
  })

  it('ignores non-.md files', () => {
    setupDirs({
      [PROJECT_CMD_DIR]: [
        dirent('refactor.md'),
        dirent('.DS_Store'),
        dirent('notes.txt'),
        dirent('subdir', false)
      ]
    })

    const result = scanCustomCommands(PROJECT_CWD)
    expect(result).toEqual(['/refactor'])
  })

  it('strips .md extension from command names', () => {
    setupDirs({
      [PROJECT_CMD_DIR]: [dirent('my-complex-command.md')]
    })

    const result = scanCustomCommands(PROJECT_CWD)
    expect(result).toEqual(['/my-complex-command'])
  })

  describe('caching', () => {
    it('returns cached results within 30s TTL', () => {
      setupDirs({
        [PROJECT_CMD_DIR]: [dirent('refactor.md')]
      })

      const first = scanCustomCommands(PROJECT_CWD)
      expect(first).toEqual(['/refactor'])

      // Change filesystem — add a new command
      setupDirs({
        [PROJECT_CMD_DIR]: [dirent('refactor.md'), dirent('new-cmd.md')]
      })

      // Still within TTL — should return cached result
      vi.advanceTimersByTime(15_000)
      const second = scanCustomCommands(PROJECT_CWD)
      expect(second).toEqual(['/refactor'])
    })

    it('rescans after 30s TTL expires', () => {
      setupDirs({
        [PROJECT_CMD_DIR]: [dirent('refactor.md')]
      })

      scanCustomCommands(PROJECT_CWD)

      // Change filesystem
      setupDirs({
        [PROJECT_CMD_DIR]: [dirent('refactor.md'), dirent('new-cmd.md')]
      })

      // Advance past TTL
      vi.advanceTimersByTime(31_000)
      const result = scanCustomCommands(PROJECT_CWD)
      expect(result).toEqual(['/refactor', '/new-cmd'])
    })

    it('caches per cwd independently', () => {
      const otherCwd = '/projects/other-app'
      const otherCmdDir = path.join(otherCwd, '.claude', 'commands')

      setupDirs({
        [PROJECT_CMD_DIR]: [dirent('refactor.md')],
        [otherCmdDir]: [dirent('deploy.md')]
      })

      expect(scanCustomCommands(PROJECT_CWD)).toEqual(['/refactor'])
      expect(scanCustomCommands(otherCwd)).toEqual(['/deploy'])
    })

    it('reflects deleted commands after cache expires', () => {
      setupDirs({
        [PROJECT_CMD_DIR]: [dirent('refactor.md'), dirent('old-cmd.md')]
      })

      expect(scanCustomCommands(PROJECT_CWD)).toEqual(['/refactor', '/old-cmd'])

      // User deletes old-cmd.md
      setupDirs({
        [PROJECT_CMD_DIR]: [dirent('refactor.md')]
      })

      // Still cached
      vi.advanceTimersByTime(15_000)
      expect(scanCustomCommands(PROJECT_CWD)).toEqual(['/refactor', '/old-cmd'])

      // Cache expired — deletion visible
      vi.advanceTimersByTime(20_000)
      expect(scanCustomCommands(PROJECT_CWD)).toEqual(['/refactor'])
    })
  })

  describe('error handling', () => {
    it('returns empty array when directory read throws', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readdirSync).mockImplementation(() => {
        throw new Error('EACCES: permission denied')
      })

      const result = scanCustomCommands(PROJECT_CWD)
      expect(result).toEqual([])
    })

    it('still returns user commands when project dir fails', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return p.toString() === PROJECT_CMD_DIR || p.toString() === USER_CMD_DIR
      })
      vi.mocked(fs.readdirSync).mockImplementation((p) => {
        if (p.toString() === PROJECT_CMD_DIR) throw new Error('EACCES')
        if (p.toString() === USER_CMD_DIR)
          return [dirent('lint.md')] as unknown as ReturnType<typeof fs.readdirSync>
        throw new Error(`ENOENT: ${p}`)
      })

      const result = scanCustomCommands(PROJECT_CWD)
      expect(result).toEqual(['/lint'])
    })
  })
})
