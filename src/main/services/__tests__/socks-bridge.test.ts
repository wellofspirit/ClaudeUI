/**
 * @vitest-environment node
 *
 * Layer 1 unit tests for the SOCKS5 HTTP-CONNECT bridge.
 *
 * The bridge is a small exported module (start/stop/getBridgePort) that runs
 * a local HTTP server translating CONNECT requests into SOCKS5 tunnels. The
 * tests here exercise it end-to-end against a minimal in-process SOCKS5
 * server so we do not depend on an external proxy.
 *
 * No child processes are spawned by this module, so there's no `child_process`
 * mock needed here — the wrapper just runs raw `net`/`http` servers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as net from 'node:net'
import * as http from 'node:http'

vi.mock('../logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

import { startSocksBridge, stopSocksBridge, getBridgePort } from '../socks-bridge'

// ---------------------------------------------------------------------------
// Minimal SOCKS5 server for tests
// ---------------------------------------------------------------------------

interface FakeSocks5Server {
  port: number
  close: () => Promise<void>
  /** Captured CONNECT targets the SOCKS server was asked to reach. */
  connects: Array<{ host: string; port: number }>
}

/**
 * Spin up a tiny SOCKS5 server that:
 *   - Accepts the no-auth greeting (method 0x00).
 *   - Responds OK to a CONNECT request, extracting the domain + port.
 *   - Echoes any data written on the tunnel back to the client.
 *
 * Everything we need to observe is captured in `connects`.
 */
interface FakeSocks5Opts {
  /** Split the greeting reply across two writes (exercises split-frame handling). */
  fragmentGreeting?: boolean
  /** Bytes to append to the CONNECT reply write (start-of-tunnel coalesced with the reply). */
  connectReplyTrailer?: Buffer
}

async function startFakeSocks5Server(opts: FakeSocks5Opts = {}): Promise<FakeSocks5Server> {
  const connects: Array<{ host: string; port: number }> = []

  const server = net.createServer((socket) => {
    let phase: 'greeting' | 'connect' | 'tunnel' = 'greeting'

    socket.on('data', (data: Buffer) => {
      if (phase === 'greeting') {
        // [VER, NMETHODS, METHODS...] — reply with [VER=5, METHOD=0 (no-auth)].
        if (opts.fragmentGreeting) {
          socket.write(Buffer.from([0x05]))
          setImmediate(() => socket.write(Buffer.from([0x00])))
        } else {
          socket.write(Buffer.from([0x05, 0x00]))
        }
        phase = 'connect'
        return
      }
      if (phase === 'connect') {
        // Parse domain-name CONNECT: [VER, CMD, RSV, ATYP=3, LEN, HOST..., PORT(2)]
        if (data[0] !== 0x05 || data[1] !== 0x01 || data[3] !== 0x03) {
          socket.end()
          return
        }
        const hostLen = data[4]
        const host = data.slice(5, 5 + hostLen).toString('utf8')
        const port = data.readUInt16BE(5 + hostLen)
        connects.push({ host, port })

        // Reply success: [VER, REP=0, RSV, ATYP=1, BND.ADDR=0.0.0.0, BND.PORT=0].
        // Optionally coalesce the first tunnel bytes into the same write.
        const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        socket.write(opts.connectReplyTrailer ? Buffer.concat([reply, opts.connectReplyTrailer]) : reply)
        phase = 'tunnel'
        return
      }
      if (phase === 'tunnel') {
        // Echo back whatever was written to verify piping.
        socket.write(data)
      }
    })
  })

  const port: number = await new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') resolve(addr.port)
      else reject(new Error('Could not bind fake SOCKS5 server'))
    })
  })

  return {
    port,
    connects,
    close: (): Promise<void> =>
      new Promise((resolve) => {
        // closeAllConnections is Node 18.2+; tolerate absence on older typings.
        ;(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
        server.close(() => resolve())
      })
  }
}

/**
 * Issue an HTTP CONNECT through the bridge and return the resulting socket
 * once the bridge replies `200 Connection Established`.
 */
function httpConnectThrough(bridgePort: number, target: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: bridgePort,
      method: 'CONNECT',
      path: target
    })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`CONNECT failed: ${res.statusCode}`))
        return
      }
      resolve(socket)
    })
    req.on('error', reject)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('socks-bridge', () => {
  let socks: FakeSocks5Server

  beforeEach(async () => {
    socks = await startFakeSocks5Server()
  })

  afterEach(async () => {
    await stopSocksBridge()
    await socks.close()
  })

  it('starts, listens on a 127.0.0.1 port, and exposes it via getBridgePort()', async () => {
    const port = await startSocksBridge({
      socksHost: '127.0.0.1',
      socksPort: socks.port
    })

    expect(typeof port).toBe('number')
    expect(port).toBeGreaterThan(0)
    expect(getBridgePort()).toBe(port)

    // Sanity: actually accepting TCP connections at that address.
    await new Promise<void>((resolve, reject) => {
      const s = net.connect({ host: '127.0.0.1', port }, () => {
        s.destroy()
        resolve()
      })
      s.on('error', reject)
    })
  })

  it('forwards an HTTP CONNECT through the SOCKS5 proxy to the requested host:port', async () => {
    const bridgePort = await startSocksBridge({
      socksHost: '127.0.0.1',
      socksPort: socks.port
    })

    const tunneled = await httpConnectThrough(bridgePort, 'example.com:443')

    // The fake SOCKS server should have been asked to CONNECT to example.com:443.
    expect(socks.connects).toEqual([{ host: 'example.com', port: 443 }])

    // Write some bytes through the tunnel and expect the fake SOCKS server's
    // echo to come back through the bridge.
    const echoed: Buffer = await new Promise((resolve, reject) => {
      tunneled.once('data', (chunk) => resolve(chunk))
      tunneled.once('error', reject)
      tunneled.write(Buffer.from('ping'))
    })

    expect(echoed.toString()).toBe('ping')
    tunneled.destroy()
  })

  it('completes the handshake when the SOCKS5 greeting reply arrives split across chunks', async () => {
    // The old one-message-per-chunk parser threw "Invalid SOCKS5 greeting
    // response" on a 1-byte first chunk. The buffered parser must wait for both.
    const frag = await startFakeSocks5Server({ fragmentGreeting: true })
    try {
      const bridgePort = await startSocksBridge({ socksHost: '127.0.0.1', socksPort: frag.port })
      const tunneled = await httpConnectThrough(bridgePort, 'example.com:443')
      expect(frag.connects).toEqual([{ host: 'example.com', port: 443 }])
      tunneled.destroy()
    } finally {
      await frag.close()
    }
  })

  it('does not drop tunnel bytes coalesced into the same chunk as the CONNECT reply', async () => {
    // The old code did removeAllListeners('data') + resolve, discarding any
    // bytes past the CONNECT reply in that chunk. The fix forwards them to the
    // client as the true start of the tunneled stream. Node's http CONNECT
    // client may surface those first bytes either in the `head` arg or as a
    // subsequent 'data' event depending on segmentation — collect both.
    const expected = 'HELLO-FROM-TARGET'
    const coalesced = await startFakeSocks5Server({
      connectReplyTrailer: Buffer.from(expected)
    })
    try {
      const bridgePort = await startSocksBridge({
        socksHost: '127.0.0.1',
        socksPort: coalesced.port
      })

      const received: string = await new Promise((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: bridgePort,
          method: 'CONNECT',
          path: 'example.com:443'
        })
        req.on('connect', (res, socket, head: Buffer) => {
          if (res.statusCode !== 200) {
            socket.destroy()
            reject(new Error(`CONNECT failed: ${res.statusCode}`))
            return
          }
          let acc = Buffer.from(head ?? [])
          const done = (): void => {
            socket.destroy()
            resolve(acc.toString())
          }
          if (acc.length >= expected.length) return done()
          socket.on('data', (c) => {
            acc = Buffer.concat([acc, c])
            if (acc.length >= expected.length) done()
          })
          socket.once('error', reject)
        })
        req.on('error', reject)
        req.end()
      })

      expect(received).toBe(expected)
    } finally {
      await coalesced.close()
    }
  })

  it('stopSocksBridge() closes the listener and clears getBridgePort()', async () => {
    const port = await startSocksBridge({
      socksHost: '127.0.0.1',
      socksPort: socks.port
    })
    expect(getBridgePort()).toBe(port)

    await stopSocksBridge()
    expect(getBridgePort()).toBeNull()

    // New connections should now fail (ECONNREFUSED).
    await expect(
      new Promise<void>((resolve, reject) => {
        const s = net.connect({ host: '127.0.0.1', port }, () => {
          s.destroy()
          resolve()
        })
        s.on('error', reject)
      })
    ).rejects.toBeInstanceOf(Error)
  })

  it('does not leak: start → stop → start again succeeds and yields a working port', async () => {
    const p1 = await startSocksBridge({
      socksHost: '127.0.0.1',
      socksPort: socks.port
    })
    expect(p1).toBeGreaterThan(0)

    await stopSocksBridge()
    expect(getBridgePort()).toBeNull()

    const p2 = await startSocksBridge({
      socksHost: '127.0.0.1',
      socksPort: socks.port
    })
    expect(p2).toBeGreaterThan(0)
    expect(getBridgePort()).toBe(p2)

    // Second bridge must actually be reachable and still forward correctly.
    const tunneled = await httpConnectThrough(p2, 'anthropic.com:443')
    expect(socks.connects.at(-1)).toEqual({ host: 'anthropic.com', port: 443 })
    tunneled.destroy()
  })
})
