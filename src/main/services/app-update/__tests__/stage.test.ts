/**
 * @vitest-environment node
 *
 * Staging a release beside the install (`app-update/stage.ts`) in a temp
 * parent folder, through the extract container. macOS vets a real zip (crafted
 * names and links) and then runs a scripted `ditto` (it lays out what the test
 * describes) and an injected signature check; Windows extracts a real zip with
 * the harness reader. Each layout runs on its own kind of host (the install
 * paths are that platform's); nothing touches a real install.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('../../../../core/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import { zip } from '../../../../core/harness/install/__tests__/fixtures'
import { INSTALL_MARKER_PRODUCT } from '../../../../shared/install-marker'
import { removeOwnedDir } from '../../relaunch/delete-gate'
import type { Exec } from '../exec'
import { openExtractContainer } from '../extract-container'
import { DITTO, checkStagedBuild, stageArchive, stagedPathFor, type StageDeps } from '../stage'

const TOKEN = 'abcdef0123456789abcdef0123456789'

const markerJson = (version: string | null, entries: string[] = []): string =>
  JSON.stringify({
    schema: 1,
    product: INSTALL_MARKER_PRODUCT,
    kind: 'desktop',
    entries,
    ...(version === null ? {} : { version })
  })

/** A macOS bundle with (or without) a marker. */
function makeMacApp(dir: string, version: string | null, withMarker = true): string {
  fs.mkdirSync(path.join(dir, 'Contents', 'MacOS'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'Contents', 'Resources'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'Contents', 'MacOS', 'ClaudeUI'), 'binary')
  if (withMarker)
    fs.writeFileSync(
      path.join(dir, 'Contents', 'Resources', 'claudeui-install.json'),
      markerJson(version)
    )
  return dir
}

let root: string
let state: string
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'app-update-stage-')))
  state = path.join(root, 'state')
  fs.mkdirSync(state)
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const siblings = (install: string): string[] =>
  fs.readdirSync(path.dirname(install)).filter((n) => n.startsWith('.'))

describe.skipIf(process.platform === 'win32')('macOS', () => {
  let parent: string
  let install: string
  beforeEach(() => {
    parent = path.join(root, 'Applications')
    install = makeMacApp(path.join(parent, 'ClaudeUI.app'), '1.0.0')
  })

  /** What the scripted ditto lays out for an archive, and whether it then fails. */
  interface Layout {
    apps: Array<{ name: string; version: string | null; marker?: boolean }>
    /** Extra top-level folders ditto leaves (e.g. `__MACOSX`). */
    extra?: string[]
    failWith?: number
  }
  const layouts = new Map<string, Layout>()
  /** A real zip whose names match the layout (the vetting reads them), and the layout for ditto. */
  const archive = (layout: Layout, rawEntries?: Parameters<typeof zip>[0]): string => {
    const file = path.join(root, `archive-${layouts.size}.zip`)
    const entries =
      rawEntries ??
      layout.apps.flatMap((a) => [
        { name: `${a.name}/` },
        { name: `${a.name}/Contents/MacOS/ClaudeUI`, body: 'exe' },
        ...(a.marker === false
          ? []
          : [
              {
                name: `${a.name}/Contents/Resources/claudeui-install.json`,
                body: markerJson(a.version)
              }
            ])
      ])
    fs.writeFileSync(file, zip(entries))
    layouts.set(file, layout)
    return file
  }
  const ditto = vi.fn<Exec>(async (file, args) => {
    expect(file).toBe(DITTO)
    expect(args.slice(0, 3)).toEqual(['-x', '-k', '--noqtn'])
    const [, , , zipFile, dest] = args
    const layout = layouts.get(zipFile)!
    for (const a of layout.apps) makeMacApp(path.join(dest, a.name), a.version, a.marker !== false)
    for (const x of layout.extra ?? []) fs.mkdirSync(path.join(dest, x))
    return { code: layout.failWith ?? 0, stdout: '', stderr: '' }
  })
  beforeEach(() => {
    layouts.clear()
    ditto.mockClear()
  })

  const deps = (over: Partial<StageDeps> = {}): StageDeps => ({
    platform: 'darwin',
    installPath: install,
    stateDir: state,
    exec: ditto,
    checkSignature: vi.fn(async () => ({ ok: true as const, identity: 'designated' as const })),
    newToken: () => TOKEN,
    ...over
  })
  const container = (): string => path.join(parent, '.ClaudeUI.app.extract-2.0.0-abcdef01')

  it('vets the zip, unpacks into the container, checks the app there, then renames it to the staging name', async () => {
    const onCreated = vi.fn()
    const d = deps({ onCreated })
    const staged = await stageArchive(
      d,
      archive({ apps: [{ name: 'ClaudeUI.app', version: '2.0.0' }] }),
      '2.0.0'
    )
    expect(staged).toBe(path.join(parent, '.ClaudeUI.app.update-2.0.0-abcdef01'))
    // The container is gone: only the staged build is left beside the install.
    expect(siblings(install)).toEqual(['.ClaudeUI.app.update-2.0.0-abcdef01'])
    expect(checkStagedBuild(staged, 'darwin', '2.0.0').ok).toBe(true)
    expect(ditto.mock.calls[0][1][4]).toBe(container())
    expect(d.checkSignature).toHaveBeenCalledWith(
      expect.objectContaining({
        installPath: install,
        stagedPath: path.join(container(), 'ClaudeUI.app')
      })
    )
    expect(onCreated).toHaveBeenCalledWith(container())
    expect(onCreated).toHaveBeenCalledWith(staged)
  })

  it.each<[string, Parameters<typeof zip>[0], RegExp]>([
    [
      'a second app',
      [
        { name: 'ClaudeUI.app/x', body: 'x' },
        { name: 'Other.app/x', body: 'x' }
      ],
      /outside ClaudeUI\.app: Other\.app\/x/
    ],
    ['another app name', [{ name: 'ClaudeUI 2.app/x', body: 'x' }], /outside ClaudeUI\.app/],
    ['an empty archive', [], /empty/],
    ['an absolute name', [{ name: '/ClaudeUI.app/x', body: 'x' }], /absolute/],
    ['a climbing name', [{ name: 'ClaudeUI.app/../../x', body: 'x' }], /climbs out/],
    [
      'a link out of the bundle',
      [{ name: 'ClaudeUI.app/Contents/l', body: '../../..', unixMode: 0o120777 }],
      /points outside/
    ],
    ['not a zip', null as never, /not a zip ClaudeUI can check/]
  ])('refuses %s before ditto runs, creating nothing', async (_name, entries, reason) => {
    const file =
      entries === null
        ? (() => {
            const f = path.join(root, 'junk.zip')
            fs.writeFileSync(f, 'not a zip at all')
            return f
          })()
        : archive({ apps: [] }, entries)
    await expect(stageArchive(deps(), file, '2.0.0')).rejects.toThrow(reason)
    expect(ditto).not.toHaveBeenCalled()
    expect(siblings(install)).toEqual([])
  })

  it.each<[string, Layout, RegExp]>([
    [
      'a wrong version',
      { apps: [{ name: 'ClaudeUI.app', version: '2.0.1' }] },
      /is 2\.0\.1, not 2\.0\.0/
    ],
    ['no version', { apps: [{ name: 'ClaudeUI.app', version: null }] }, /does not say its version/],
    [
      'no marker at all',
      { apps: [{ name: 'ClaudeUI.app', version: '2.0.0', marker: false }] },
      /no ClaudeUI install marker/
    ],
    [
      'ditto failing part-way (no marker landed yet)',
      { apps: [{ name: 'ClaudeUI.app', version: '2.0.0', marker: false }], failWith: 1 },
      /could not be unpacked/
    ],
    [
      'ditto failing after the marker landed',
      { apps: [{ name: 'ClaudeUI.app', version: '2.0.0' }], failWith: 1 },
      /could not be unpacked/
    ],
    [
      'ditto leaving more than the app',
      { apps: [{ name: 'ClaudeUI.app', version: '2.0.0' }], extra: ['__MACOSX'] },
      /exactly one ClaudeUI\.app/
    ]
  ])(
    'refuses %s and removes the container (its staging record proves it ours)',
    async (_n, layout, reason) => {
      await expect(
        stageArchive(deps(), archive(layout, [{ name: 'ClaudeUI.app/x', body: 'x' }]), '2.0.0')
      ).rejects.toThrow(reason)
      expect(ditto).toHaveBeenCalledTimes(1)
      expect(siblings(install)).toEqual([])
      expect(fs.existsSync(path.join(install, 'Contents', 'MacOS', 'ClaudeUI'))).toBe(true)
    }
  )

  it('a refused signature removes the container and says why; nothing was staged', async () => {
    const d = deps({
      checkSignature: vi.fn(async () => ({
        ok: false as const,
        reason: 'The update is not signed by the same developer as this ClaudeUI'
      }))
    })
    await expect(
      stageArchive(d, archive({ apps: [{ name: 'ClaudeUI.app', version: '2.0.0' }] }), '2.0.0')
    ).rejects.toThrow(/same developer/)
    expect(siblings(install)).toEqual([])
  })

  it('refuses when a folder of the staging name already exists, touching nothing', async () => {
    const existing = makeMacApp(path.join(parent, '.ClaudeUI.app.update-2.0.0-abcdef01'), '9.9.9')
    await expect(
      stageArchive(deps(), archive({ apps: [{ name: 'ClaudeUI.app', version: '2.0.0' }] }), '2.0.0')
    ).rejects.toThrow(/already exists/)
    expect(ditto).not.toHaveBeenCalled()
    expect(checkStagedBuild(existing, 'darwin', '9.9.9').ok).toBe(true)
    expect(siblings(install)).toEqual(['.ClaudeUI.app.update-2.0.0-abcdef01'])
  })

  it('an interrupted extract (the process died mid-ditto) is still removable by the gate', () => {
    const c = openExtractContainer({
      installPath: install,
      version: '2.0.0',
      token: TOKEN,
      platform: 'darwin',
      now: Date.now()
    })
    fs.mkdirSync(path.join(c.inner, 'Contents', 'Frameworks'), { recursive: true })
    fs.writeFileSync(path.join(c.inner, 'Contents', 'Frameworks', 'half'), 'x')
    expect(removeOwnedDir(install, c.dir, { platform: 'darwin', stateDir: state })).toEqual({
      removed: true
    })
    expect(siblings(install)).toEqual([])
  })

  it("stagedPathFor accepts only this install's staging names", () => {
    const ok = '.ClaudeUI.app.update-2.0.0-abcdef01'
    expect(stagedPathFor(install, ok, 'darwin')).toBe(path.join(parent, ok))
    for (const bad of [
      '.ClaudeUI.app.old-2.0.0-abcdef01',
      '.ClaudeUI.app.failed-2.0.0-abcdef01',
      '.ClaudeUI.app.extract-2.0.0-abcdef01',
      '.Other.app.update-2.0.0-abcdef01',
      `../${ok}`,
      `sub/${ok}`,
      ok + '/..',
      'ClaudeUI.app',
      ''
    ])
      expect(stagedPathFor(install, bad, 'darwin'), bad).toBeNull()
  })

  it('checkStagedBuild: real directory, marker, version', () => {
    const good = makeMacApp(path.join(parent, '.ClaudeUI.app.update-2.0.0-abcdef01'), '2.0.0')
    expect(checkStagedBuild(good, 'darwin', '2.0.0')).toMatchObject({ ok: true })
    expect(checkStagedBuild(good, 'darwin')).toMatchObject({ ok: true })
    expect(checkStagedBuild(good, 'darwin', '2.0.1')).toMatchObject({ ok: false })
    expect(checkStagedBuild(path.join(parent, 'nope'), 'darwin')).toMatchObject({
      ok: false,
      reason: 'The staged build is missing'
    })
    const link = path.join(parent, 'link.app')
    fs.symlinkSync(good, link)
    expect(checkStagedBuild(link, 'darwin')).toMatchObject({ ok: false })
  })
})

describe.skipIf(process.platform !== 'win32')('Windows', () => {
  const ENTRIES = ['ClaudeUI.exe', 'resources']
  let parent: string
  let install: string
  beforeEach(() => {
    parent = path.join(root, 'Tools')
    install = path.join(parent, 'ClaudeUI')
    fs.mkdirSync(path.join(install, 'resources'), { recursive: true })
    fs.writeFileSync(path.join(install, 'ClaudeUI.exe'), 'exe')
    fs.writeFileSync(
      path.join(install, 'resources', 'claudeui-install.json'),
      markerJson('1.0.0', ENTRIES)
    )
  })

  const winZip = (version: string, extra: string[] = []): string => {
    const file = path.join(root, `release-${version}.zip`)
    fs.writeFileSync(
      file,
      zip([
        { name: 'ClaudeUI.exe', body: 'new exe' },
        { name: 'resources/app.asar', body: 'asar' },
        { name: 'resources/claudeui-install.json', body: markerJson(version, ENTRIES) },
        ...extra.map((name) => ({ name, body: 'x' }))
      ])
    )
    return file
  }
  const deps = (): StageDeps => ({
    platform: 'win32',
    installPath: install,
    stateDir: state,
    exec: async () => {
      throw new Error('no tool runs on Windows staging')
    },
    newToken: () => TOKEN
  })

  it('extracts the zip into the container, then renames it to the staging folder', async () => {
    const staged = await stageArchive(deps(), winZip('2.0.0'), '2.0.0')
    expect(path.basename(staged)).toBe('.ClaudeUI.update-2.0.0-abcdef01')
    expect(siblings(install)).toEqual(['.ClaudeUI.update-2.0.0-abcdef01'])
    expect(fs.readFileSync(path.join(staged, 'ClaudeUI.exe'), 'utf8')).toBe('new exe')
    expect(checkStagedBuild(staged, 'win32', '2.0.0').ok).toBe(true)
  })

  it('refuses a build holding files its marker does not list, and removes it', async () => {
    await expect(stageArchive(deps(), winZip('2.0.0', ['stray.txt']), '2.0.0')).rejects.toThrow(
      /does not list: stray\.txt/
    )
    expect(siblings(install)).toEqual([])
  })

  it('refuses a wrong version, and removes it', async () => {
    await expect(stageArchive(deps(), winZip('2.0.1'), '2.0.0')).rejects.toThrow(/not 2\.0\.0/)
    expect(siblings(install)).toEqual([])
  })

  it('an extraction that fails part-way (no marker yet) is removed by its staging record', async () => {
    const d = {
      ...deps(),
      extractZip: vi.fn(async (_file: string, dest: string) => {
        fs.writeFileSync(path.join(dest, 'ClaudeUI.exe'), 'half')
        throw new Error('zip is truncated')
      })
    } as StageDeps
    await expect(stageArchive(d, winZip('2.0.0'), '2.0.0')).rejects.toThrow(/truncated/)
    expect(d.extractZip).toHaveBeenCalledWith(
      expect.any(String),
      path.join(parent, '.ClaudeUI.extract-2.0.0-abcdef01', 'app'),
      expect.anything()
    )
    expect(siblings(install)).toEqual([])
  })
})
