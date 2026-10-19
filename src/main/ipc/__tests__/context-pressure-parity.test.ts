/**
 * @vitest-environment node
 *
 * `session:context-pressure:respond` (session tools, slice 4) — the banner's Hand off / Not now.
 * The banner is on every client, so the verb must exist on BOTH transports with the same
 * shape, in the desktop preload and in the browser's api-adapter: a static source scan, in the
 * style of `remote-channel-parity.test.ts` (importing the Electron-free and the browser module
 * graphs into one test is the fragile part this avoids).
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const CHANNEL = 'session:context-pressure:respond'
const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf-8')

/** The registration block that names the channel, up to its handler. */
function registrationOf(source: string): string {
  const at = source.indexOf(`channel: '${CHANNEL}'`)
  expect(at, 'registered').toBeGreaterThan(-1)
  return source.slice(at, at + 400)
}

describe('session:context-pressure:respond has the same shape everywhere', () => {
  it.each([
    ['desktop', 'src/core/ipc/session.ipc.ts'],
    ['remote', 'src/core/ipc/remote-handlers.ts']
  ])('%s registers a chat command on the session that calls the service', (_, file) => {
    const block = registrationOf(read(file))
    expect(block).toContain("capability: 'chat'")
    expect(block).toContain("kind: 'command'")
    expect(block).toContain('sessionIdArg: 0')
    expect(block).toContain('respondContextPressure(routingId, answer)')
  })

  it('the desktop channel list unbinds it on re-registration', () => {
    expect(read('src/core/ipc/session.ipc.ts')).toContain(`'${CHANNEL}',\n`)
  })

  it('the preload and the web adapter expose the same method with the same arguments', () => {
    expect(read('src/preload/index.ts')).toMatch(
      /respondContextPressure: \(routingId: string, answer: 'handoff' \| 'dismiss'\) =>\s*ipcRenderer\.invoke\('session:context-pressure:respond', routingId, answer\)/
    )
    expect(read('src/web/api-adapter.ts')).toMatch(
      /respondContextPressure: \(routingId, answer\) =>\s*connection\.invoke\('session:context-pressure:respond', routingId, answer\)/
    )
  })

  it('the API type and the test boot helper carry it too', () => {
    expect(read('src/shared/types.ts')).toContain('respondContextPressure(')
    expect(read('src/test/helpers/boot-test-app.ts')).toContain(`'${CHANNEL}'`)
  })
})
