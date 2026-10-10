/**
 * opencode's own directories as `external_directory` allows (`own-dirs.ts`,
 * ADR-097 §3 2026-10-10 amendment): the derivation mirrors the server's
 * `util/src/global-roots.ts` + `global.ts`, and the resolver prefers the
 * server's own `paths.tmp`.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  opencodeGlobalDirs,
  opencodeOwnDirAllows,
  resolveOpencodeOwnDirAllows,
  type OwnDirClient
} from '../own-dirs'

const allow = (resource: string) => ({ action: 'external_directory', resource, effect: 'allow' })

describe('opencodeGlobalDirs', () => {
  it('defaults to ~/.local/share and ~/.config under the home, and os.tmpdir()/opencode', () => {
    expect(
      opencodeGlobalDirs({ env: {}, home: '/home/u', tmpdir: '/tmp', platform: 'linux' })
    ).toEqual({
      data: '/home/u/.local/share/opencode',
      config: '/home/u/.config/opencode',
      tmp: '/tmp/opencode'
    })
  })

  it('XDG_DATA_HOME / XDG_CONFIG_HOME move data and config; an empty one falls back', () => {
    expect(
      opencodeGlobalDirs({
        env: { XDG_DATA_HOME: '/x/data', XDG_CONFIG_HOME: '/x/config' },
        home: '/home/u',
        tmpdir: '/tmp',
        platform: 'linux'
      })
    ).toMatchObject({ data: '/x/data/opencode', config: '/x/config/opencode' })
    expect(
      opencodeGlobalDirs({
        env: { XDG_DATA_HOME: '', XDG_CONFIG_HOME: '' },
        home: '/home/u',
        tmpdir: '/tmp',
        platform: 'linux'
      })
    ).toMatchObject({
      data: '/home/u/.local/share/opencode',
      config: '/home/u/.config/opencode'
    })
  })

  it('OPENCODE_CONFIG_DIR is the config dir itself (no `opencode` appended); data is unaffected', () => {
    expect(
      opencodeGlobalDirs({
        env: { OPENCODE_CONFIG_DIR: '/etc/oc', XDG_CONFIG_HOME: '/x/config' },
        home: '/home/u',
        tmpdir: '/tmp',
        platform: 'linux'
      })
    ).toMatchObject({ config: '/etc/oc', data: '/home/u/.local/share/opencode' })
  })

  it('joins with the platform separator (Windows keeps backslashes until the allow is slashed)', () => {
    expect(
      opencodeGlobalDirs({
        env: {},
        home: 'C:\\Users\\Dev',
        tmpdir: 'C:\\Users\\Dev\\AppData\\Local\\Temp',
        platform: 'win32'
      })
    ).toEqual({
      data: 'C:\\Users\\Dev\\.local\\share\\opencode',
      config: 'C:\\Users\\Dev\\.config\\opencode',
      tmp: 'C:\\Users\\Dev\\AppData\\Local\\Temp\\opencode'
    })
  })

  it('no home and no XDG: data and config are absent rather than invented', () => {
    expect(opencodeGlobalDirs({ env: {}, home: '', tmpdir: '/tmp', platform: 'linux' })).toEqual({
      tmp: '/tmp/opencode'
    })
  })
})

describe('opencodeOwnDirAllows', () => {
  it('shell/<project>/<file>, tool-output, every tmp spelling, config — slashed, once each', () => {
    expect(
      opencodeOwnDirAllows(
        {
          data: 'C:\\d\\opencode',
          config: 'C:\\c\\opencode\\',
          tmp: ['C:\\t\\opencode', 'C:\\t\\opencode', 'C:\\Real\\t\\opencode']
        },
        'win32'
      )
    ).toEqual([
      allow('C:/d/opencode/shell/*/*'),
      allow('C:/d/opencode/tool-output/*'),
      allow('C:/t/opencode/*'),
      allow('C:/Real/t/opencode/*'),
      allow('C:/c/opencode/*')
    ])
  })

  it('folds case for the duplicate check on Windows only', () => {
    expect(opencodeOwnDirAllows({ tmp: ['C:/T/oc', 'c:/t/oc'] }, 'win32')).toHaveLength(1)
    expect(opencodeOwnDirAllows({ tmp: ['/T/oc', '/t/oc'] }, 'linux')).toHaveLength(2)
  })

  it('is deterministic and empty without directories', () => {
    expect(opencodeOwnDirAllows({}, 'linux')).toEqual([])
    const dirs = { data: '/d', config: '/c', tmp: ['/t'] }
    expect(JSON.stringify(opencodeOwnDirAllows(dirs, 'linux'))).toBe(
      JSON.stringify(opencodeOwnDirAllows(dirs, 'linux'))
    )
  })
})

describe('resolveOpencodeOwnDirAllows', () => {
  const base = {
    env: {},
    homedir: '/home/u',
    tmpdir: '/tmp',
    platform: 'linux' as const
  }
  const client = (answer: () => Promise<unknown>): OwnDirClient => ({ call: vi.fn(answer) })

  it("takes the server's own raw tmp (GET /api/info) and its canonical spelling", async () => {
    const info = client(async () => ({ paths: { tmp: '/var/folders/T/opencode' } }))
    const rules = await resolveOpencodeOwnDirAllows(info, {
      ...base,
      realpath: (dir) => dir.replace('/var/', '/private/var/')
    })
    expect(info.call).toHaveBeenCalledWith('server.info', {})
    expect(rules.map((r) => r.resource)).toEqual([
      '/home/u/.local/share/opencode/shell/*/*',
      '/home/u/.local/share/opencode/tool-output/*',
      '/var/folders/T/opencode/*',
      '/private/var/folders/T/opencode/*',
      '/home/u/.config/opencode/*'
    ])
  })

  it('falls back to the derived tmp when /api/info fails, and reports it', async () => {
    const onError = vi.fn()
    const rules = await resolveOpencodeOwnDirAllows(
      client(async () => {
        throw new Error('boom')
      }),
      { ...base, realpath: (dir) => dir, onError }
    )
    expect(onError).toHaveBeenCalledOnce()
    expect(rules.map((r) => r.resource)).toContain('/tmp/opencode/*')
  })

  it('a client without the call, or an answer without paths.tmp, derives quietly', async () => {
    const onError = vi.fn()
    for (const answer of [undefined, {}, { paths: {} }, { paths: { tmp: 7 } }]) {
      const rules = await resolveOpencodeOwnDirAllows(
        client(async () => answer),
        {
          ...base,
          realpath: (dir) => dir,
          onError
        }
      )
      expect(rules.map((r) => r.resource)).toContain('/tmp/opencode/*')
    }
    expect(await resolveOpencodeOwnDirAllows(undefined, { ...base, realpath: (d) => d })).toEqual(
      await resolveOpencodeOwnDirAllows(
        client(async () => undefined),
        { ...base, realpath: (d) => d }
      )
    )
    expect(onError).not.toHaveBeenCalled()
  })

  it('an unresolvable tmp keeps the raw spelling alone', async () => {
    const rules = await resolveOpencodeOwnDirAllows(
      client(async () => ({ paths: { tmp: '/gone/opencode' } })),
      {
        ...base,
        realpath: () => {
          throw new Error('ENOENT')
        }
      }
    )
    expect(rules.filter((r) => r.resource.startsWith('/gone/'))).toEqual([
      allow('/gone/opencode/*')
    ])
  })
})
