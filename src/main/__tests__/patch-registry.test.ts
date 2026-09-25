/**
 * @vitest-environment node
 *
 * `patch/lib/patch-registry.mjs`: which patches a build carries, as recorded in
 * `vendor/claude-cli/version.json` `patches` and read back by
 * `src/core/sdk/harness.ts` to gate voice (and later streaming) on the binary.
 *
 * A marker regex that misses its patch's markers would record a patched build as
 * unpatched and switch voice off for everyone; one that claims another patch's
 * markers would light a surface on a binary that cannot serve it. Both are
 * checked against the markers the apply scripts actually write.
 */

import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  PATCH_REGISTRY,
  patchesPresent,
  mergeIntoVersionJson
} from '../../../patch/lib/patch-registry.mjs'
import { cliJsExists, readCliJs, findMarkers } from '../../test/helpers/patch-harness'

type RegistryEntry = { name: string; apply: string; marker: RegExp }
const registry = PATCH_REGISTRY as ReadonlyArray<RegistryEntry>

const PATCH_DIR = path.resolve(process.cwd(), 'patch')

/** Every `/*PATCHED:<name>*\/` literal an apply script writes, by patch name. */
function markersWrittenBy(name: string): string[] {
  const src = fs.readFileSync(path.join(PATCH_DIR, name, 'apply.mjs'), 'utf8')
  return [...new Set(src.match(/\/\*PATCHED:[\w-]+\*\//g) ?? [])]
}

const claimants = (marker: string): string[] =>
  registry.filter((e) => marker.search(e.marker) !== -1).map((e) => e.name)

describe('patchesPresent', () => {
  it('names the patches whose markers occur, in registry order', () => {
    const src =
      'a();/*PATCHED:voice-server*/b();/*PATCHED:subagent-F2*/c();' +
      '/*PATCHED:bash-early-poll*/d();/*PATCHED:skip-securestorage*/'
    expect(patchesPresent(src)).toEqual([
      'subagent-streaming',
      'voice-server',
      'bash-output-streaming',
      'skip-securestorage'
    ])
  })

  it('reports nothing for an unpatched cli.js', () => {
    expect(patchesPresent('function voiceServer(){return"voice-server"}')).toEqual([])
  })

  it('needs the whole comment, not just the name', () => {
    // A string in upstream code that happens to read like a marker name.
    expect(patchesPresent('"PATCHED:voice-server" /*PATCHED:voice-server')).toEqual([])
  })

  it('does not let one patch claim a sibling family with a shared prefix', () => {
    expect(patchesPresent('/*PATCHED:subprocess-proxy-strip*/')).toEqual(['subprocess-proxy-strip'])
    expect(patchesPresent('/*PATCHED:subagent-A*/')).toEqual(['subagent-streaming'])
  })

  it('gives the same answer on every call, even for a global-flag marker', () => {
    const custom = [{ name: 'x', marker: /\/\*PATCHED:x\*\//g }]
    const src = '/*PATCHED:x*/'
    expect(patchesPresent(src, custom)).toEqual(['x'])
    expect(patchesPresent(src, custom)).toEqual(['x'])
  })
})

describe('PATCH_REGISTRY', () => {
  it('registers every patch directory that has an apply script, and only those', () => {
    const onDisk = fs
      .readdirSync(PATCH_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(PATCH_DIR, d.name, 'apply.mjs')))
      .map((d) => d.name)
      .sort()
    expect(registry.map((e) => e.name).sort()).toEqual(onDisk)
    for (const e of registry) expect(fs.existsSync(e.apply), e.apply).toBe(true)
  })

  it.each(registry.map((e) => e.name))(
    "claims every marker %s's apply script writes, and nothing claims them twice",
    (name) => {
      const markers = markersWrittenBy(name)
      expect(markers.length, `${name}/apply.mjs defines no marker`).toBeGreaterThan(0)
      for (const marker of markers) expect(claimants(marker), marker).toEqual([name])
    }
  )

  it.skipIf(!cliJsExists())('claims every marker in the vendored cli.js exactly once', () => {
    const markers = [...new Set(findMarkers(readCliJs()))]
    expect(markers.length).toBeGreaterThan(0)
    for (const marker of markers) expect(claimants(marker), marker).toHaveLength(1)
  })
})

describe('mergeIntoVersionJson', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  function versionFile(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-registry-'))
    dirs.push(dir)
    const file = path.join(dir, 'version.json')
    fs.writeFileSync(file, content)
    return file
  }

  it('adds `patches` and keeps every field extract-cli wrote', () => {
    const meta = {
      version: '2.1.280',
      sourceBinary: '.cache/claude-cli/claude-2.1.280-win32-x64.exe',
      cliSha256: 'abc',
      form: 'chunked',
      chunkCount: 1973
    }
    const file = versionFile(JSON.stringify(meta, null, 2) + '\n')
    mergeIntoVersionJson(file, { patches: ['voice-server'] })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      ...meta,
      patches: ['voice-server']
    })
    expect(fs.readdirSync(path.dirname(file))).toEqual(['version.json'])
  })

  it('replaces a stale list rather than appending to it', () => {
    const file = versionFile(JSON.stringify({ version: '1', patches: ['usage-relay'] }))
    mergeIntoVersionJson(file, { patches: [] })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: '1', patches: [] })
  })

  it('refuses a missing or non-object file', () => {
    expect(() => mergeIntoVersionJson(path.join(os.tmpdir(), 'nope', 'version.json'), {})).toThrow()
    const file = versionFile('[1, 2]')
    expect(() => mergeIntoVersionJson(file, { patches: [] })).toThrow(/JSON object/)
    expect(fs.readFileSync(file, 'utf8')).toBe('[1, 2]')
  })
})
