/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseInstallMarker } from '../../shared/install-marker'

const { installMarkerFor, writeInstallMarker }: any =
  await import('../../../scripts/stamp-install-marker.mjs')

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-marker-'))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('stamp-install-marker', () => {
  it('windows: lists the packaged folder, sorted, and writes into resources/', () => {
    const dir = path.join(root, 'win-unpacked')
    fs.mkdirSync(path.join(dir, 'resources'), { recursive: true })
    for (const f of ['ClaudeUI.exe', 'LICENSES.chromium.html', 'd3dcompiler_47.dll'])
      fs.writeFileSync(path.join(dir, f), '')
    const target = writeInstallMarker(dir, 'win')
    expect(target).toBe(path.join(dir, 'resources', 'claudeui-install.json'))
    const marker = parseInstallMarker(JSON.parse(fs.readFileSync(target, 'utf8')))
    expect(marker?.entries).toEqual([
      'ClaudeUI.exe',
      'LICENSES.chromium.html',
      'd3dcompiler_47.dll',
      'resources'
    ])
  })

  it('mac: writes an empty entry list into Contents/Resources', () => {
    const app = path.join(root, 'ClaudeUI.app')
    fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true })
    const target = writeInstallMarker(app, 'mac')
    expect(target).toBe(path.join(app, 'Contents', 'Resources', 'claudeui-install.json'))
    expect(parseInstallMarker(JSON.parse(fs.readFileSync(target, 'utf8')))?.entries).toEqual([])
    expect(installMarkerFor(app, 'mac').entries).toEqual([])
  })

  it('refuses a bad platform, a non-.app on mac and a missing resources folder', () => {
    const dir = path.join(root, 'x')
    fs.mkdirSync(dir)
    expect(() => writeInstallMarker(dir, 'linux')).toThrow(/--platform/)
    expect(() => writeInstallMarker(dir, 'mac')).toThrow(/\.app/)
    expect(() => writeInstallMarker(dir, 'win')).toThrow()
  })
})
