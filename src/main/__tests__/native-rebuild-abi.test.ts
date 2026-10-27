/**
 * @vitest-environment node
 *
 * `rebuild:native` (`electron-builder install-app-deps`, also postinstall's
 * native stage) asks `node-abi` for the installed Electron's ABI before it
 * rebuilds node-pty. A node-abi older than the Electron major throws "Could
 * not detect abi". postinstall keeps going past it but exits non-zero at the
 * end, and an `--ignore-scripts` install never runs it. This pins the pair
 * together: an Electron bump without a node-abi that knows it fails here
 * first (package.json#overrides.node-abi carries the floor).
 */

import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

// Resolved the way Node resolves them (walking up), so a git worktree without its own
// node_modules finds the main checkout's, as the app itself does.
const rootRequire = createRequire(__filename)

describe('native rebuild ABI lookup', () => {
  it("node-abi, as @electron/rebuild resolves it, knows the installed Electron's ABI", () => {
    const electronVersion: string = JSON.parse(
      readFileSync(rootRequire.resolve('electron/package.json'), 'utf8')
    ).version
    // The copy the rebuilder itself loads, not whichever one the root hoists.
    // (its exports map hides package.json, so resolve from its entry point)
    const rebuildRequire = createRequire(rootRequire.resolve('@electron/rebuild'))
    const { getAbi } = rebuildRequire('node-abi') as {
      getAbi: (target: string, runtime: string) => string
    }
    expect(getAbi(electronVersion, 'electron')).toMatch(/^\d+$/)
  })
})
