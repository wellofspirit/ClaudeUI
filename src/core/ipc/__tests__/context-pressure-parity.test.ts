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
import { API_INVOKES } from '../../../shared/api-invoke-table'

const CHANNEL = 'session:context-pressure:respond'
const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf-8')

/** The registration block that names the channel, up to its handler. */
function registrationOf(source: string): string {
  const at = source.indexOf(`channel: '${CHANNEL}'`)
  expect(at, 'registered').toBeGreaterThan(-1)
  return source.slice(at, at + 400)
}

describe('session:context-pressure:respond has the same shape everywhere', () => {
  it('is declared once, as a chat command on the session that calls the service', () => {
    const block = registrationOf(read('src/core/ipc/session-commands.ts'))
    expect(block).toContain("capability: 'chat'")
    expect(block).toContain("kind: 'command'")
    expect(block).toContain('sessionIdArg: 0')
    expect(block).toContain('respondContextPressure(routingId, answer)')
  })

  it.each([
    [
      'desktop',
      'src/core/ipc/session.ipc.ts',
      /sessionCommands\(manager, 'desktop'\)[^]*?handleIpc\(/
    ],
    [
      'remote',
      'src/core/ipc/remote-handlers.ts',
      /sessionCommands\(manager, 'remote'\)[^]*?handleRemote\(/
    ]
  ])('the %s registrar spreads that declaration', (_, file, spread) => {
    expect(read(file)).toMatch(spread)
  })

  it('the desktop channel list unbinds it on re-registration', () => {
    expect(read('src/core/ipc/session.ipc.ts')).toContain(`'${CHANNEL}',\n`)
  })

  it('the preload and the web adapter expose the same method with the same arguments', () => {
    // One table entry: the preload, the web adapter and the test helper all build the member
    // from it, over their own transport (`shared/api-invoke-table.ts`).
    expect(API_INVOKES.respondContextPressure).toEqual({
      channel: CHANNEL,
      arity: 2,
      mode: 'invoke'
    })
    for (const file of [
      'src/preload/index.ts',
      'src/web/api-adapter.ts',
      'src/test/helpers/boot-test-app.ts'
    ]) {
      expect(read(file), file).toMatch(/buildInvokeApi\(API_INVOKES,/)
    }
  })

  it('the API type carries it too', () => {
    expect(read('src/shared/types.ts')).toContain('respondContextPressure(')
  })
})
