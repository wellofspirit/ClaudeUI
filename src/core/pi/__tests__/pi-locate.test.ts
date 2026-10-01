/**
 * @vitest-environment node
 *
 * pi-locate.ts is a thin delegate to the harness resolver (ADR-082). pi is not
 * bundled (§8): it runs from ClaudeUI's managed store (or a System install,
 * resolve-system.test.ts), and a vendored copy an old checkout left behind is
 * never picked up. A real temp store stands in; the resolver caches, so each
 * test starts from `invalidateHarness()`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { setHostPaths } from '../../host'
import { invalidateHarness } from '../../harness/resolve'
import { harnessManifest } from '../../harness/manifests'
import { HARNESS_STORE_ENV } from '../../harness/store'
import {
  exeName,
  fakeHarnessInstall,
  writeHarnessPayload
} from '../../../test/helpers/fake-harness'
import {
  locatePiBinary,
  locatePiDisplayPath,
  locatePiLaunch,
  piBinaryAvailable
} from '../pi-locate'

const TESTED = harnessManifest('pi').tested
let tmp: string
let store: string
const saved = { store: process.env[HARNESS_STORE_ENV], override: process.env.CLAUDEUI_PI_CLI }

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-locate-'))
  store = path.join(tmp, 'store')
  process.env[HARNESS_STORE_ENV] = store
  delete process.env.CLAUDEUI_PI_CLI
  setHostPaths({ getAppPath: () => path.join(tmp, 'app') })
  invalidateHarness()
})

afterEach(() => {
  setHostPaths(null)
  if (saved.store === undefined) delete process.env[HARNESS_STORE_ENV]
  else process.env[HARNESS_STORE_ENV] = saved.store
  if (saved.override === undefined) delete process.env.CLAUDEUI_PI_CLI
  else process.env.CLAUDEUI_PI_CLI = saved.override
  fs.rmSync(tmp, { recursive: true, force: true })
  invalidateHarness()
})

describe('locatePiBinary', () => {
  it("runs the tested version from ClaudeUI's store", () => {
    const dir = fakeHarnessInstall(store, 'pi', TESTED)
    const bin = path.join(dir, exeName('pi'))
    expect(locatePiBinary()).toBe(bin)
    expect(locatePiDisplayPath()).toBe(bin)
    expect(locatePiLaunch()).toEqual({ command: bin, args: [] })
    expect(piBinaryAvailable()).toBe(true)
  })

  it('finds the nested release executable (`<version>/pi/pi`)', () => {
    const dir = fakeHarnessInstall(store, 'pi', TESTED, { nested: true })
    expect(locatePiBinary()).toBe(path.join(dir, 'pi', exeName('pi')))
  })

  it('never picks up a vendored or packaged copy', () => {
    writeHarnessPayload(path.join(tmp, 'app', 'vendor', 'pi-cli'), 'pi')
    expect(locatePiBinary()).toBeNull()
    expect(locatePiLaunch()).toBeNull()
    expect(piBinaryAvailable()).toBe(false)

    const resources = path.join(tmp, 'Resources')
    setHostPaths({ getAppPath: () => path.join(resources, 'app.asar') })
    writeHarnessPayload(path.join(resources, 'pi-cli'), 'pi')
    invalidateHarness()
    expect(locatePiBinary()).toBeNull()
  })

  it('returns null, never throwing, with an empty store', () => {
    expect(() => locatePiBinary()).not.toThrow()
    expect(locatePiBinary()).toBeNull()
    expect(locatePiDisplayPath()).toBeNull()
    expect(piBinaryAvailable()).toBe(false)
  })
})
