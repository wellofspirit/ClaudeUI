/**
 * @vitest-environment node
 *
 * `rebuild:native` (`electron-builder install-app-deps`, also postinstall's
 * native stage) asks `node-abi` for the installed Electron's ABI before it
 * rebuilds node-pty. A node-abi older than the Electron major throws "Could
 * not detect abi", which postinstall records as a soft failure and CI only
 * reaches in its explicit rebuild step. This pins the pair together: an
 * Electron bump without a node-abi that knows it fails here first
 * (package.json#overrides.node-abi carries the floor).
 */

import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(__dirname, '../../..')

describe('native rebuild ABI lookup', () => {
  it("node-abi, as @electron/rebuild resolves it, knows the installed Electron's ABI", () => {
    const electronVersion: string = JSON.parse(
      readFileSync(resolve(root, 'node_modules/electron/package.json'), 'utf8')
    ).version
    // The copy the rebuilder itself loads, not whichever one the root hoists.
    const rebuildRequire = createRequire(
      resolve(root, 'node_modules/@electron/rebuild/package.json')
    )
    const { getAbi } = rebuildRequire('node-abi') as {
      getAbi: (target: string, runtime: string) => string
    }
    expect(getAbi(electronVersion, 'electron')).toMatch(/^\d+$/)
  })
})
