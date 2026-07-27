/**
 * Local HTTP CONNECT proxy that tunnels traffic through a SOCKS5 proxy.
 *
 * The CLI bundles `https-proxy-agent` which only speaks HTTP proxies.
 * When the user configures a SOCKS5 proxy, we start a lightweight local
 * HTTP server that:
 *   1. Accepts CONNECT requests from the CLI (via HTTP_PROXY env var)
 *   2. Establishes a SOCKS5 tunnel to the target host through the user's proxy
 *   3. Pipes the two sockets together
 *
 * The CLI sees `HTTP_PROXY=http://127.0.0.1:<port>` and works normally.
 */

import * as http from 'node:http'
import * as net from 'node:net'
import { logger } from './logger'

export interface SocksBridgeConfig {
  socksHost: string
  socksPort: number
  username?: string
  password?: string
}

let server: http.Server | null = null
let bridgePort: number | null = null
let currentConfig: SocksBridgeConfig | null = null

/**
 * Length in bytes of a complete SOCKS5 CONNECT reply given the bytes seen so
 * far. Reply layout: VER REP RSV ATYP BND.ADDR BND.PORT(2).
 * Returns -1 when more bytes are needed, or null for an unsupported ATYP.
 */
function connectReplyLen(b: Buffer): number | null {
  if (b.length < 4) return -1
  const atyp = b[3]
  let addrLen: number
  if (atyp === 0x01)
    addrLen = 4 // IPv4
  else if (atyp === 0x04)
    addrLen = 16 // IPv6
  else if (atyp === 0x03) {
    // domain name: 1 length byte + N
    if (b.length < 5) return -1
    addrLen = 1 + b[4]
  } else return null
  const total = 4 + addrLen + 2
  return b.length < total ? -1 : total
}

/**
 * Connect to a target host:port through a SOCKS5 proxy. Resolves the tunneled
 * socket (paused) plus any `leftover` bytes that were coalesced into the same
 * chunk as the CONNECT reply — those are the start of the tunneled stream and
 * the caller must forward them to the client before piping the rest.
 *
 * Exported so the proxy connectivity test (session.ipc.ts) shares this
 * TCP-framing-correct handshake instead of hand-rolling its own.
 */
export function socks5Connect(
  config: SocksBridgeConfig,
  targetHost: string,
  targetPort: number
): Promise<{ socket: net.Socket; leftover: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: config.socksHost, port: config.socksPort })

    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error('SOCKS5 connect timed out'))
    }, 15_000)

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.removeListener('data', onData)
      socket.destroy()
      reject(err)
    }

    socket.on('error', fail)

    socket.once('connect', () => {
      // Step 1: greeting — offer no-auth (0x00) and user/pass (0x02)
      const hasAuth = config.username && config.username.length > 0
      const greeting = hasAuth
        ? Buffer.from([0x05, 0x02, 0x00, 0x02])
        : Buffer.from([0x05, 0x01, 0x00])
      socket.write(greeting)
    })

    let phase: 'greeting' | 'auth' | 'connect' = 'greeting'
    // Accumulate across 'data' events: SOCKS5 replies are tiny but TCP gives no
    // framing guarantees. The previous one-message-per-chunk assumption threw a
    // bogus error on a split reply and discarded any tunnel bytes that arrived
    // in the same chunk as the CONNECT reply. Parse only complete messages, and
    // hand any leftover (start of the tunneled stream) back to the caller.
    let buf: Buffer = Buffer.alloc(0)

    const onData = (chunk: Buffer): void => {
      try {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
        // A chunk can complete a phase transition or carry trailing tunnel
        // bytes after the CONNECT reply; loop until we need more bytes or settle.
        for (;;) {
          if (phase === 'greeting') {
            if (buf.length < 2) return
            if (buf[0] !== 0x05) throw new Error('Invalid SOCKS5 greeting response')
            const method = buf[1]
            buf = buf.subarray(2)
            if (method === 0x02 && config.username) {
              // Username/password auth (RFC 1929)
              phase = 'auth'
              const uBuf = Buffer.from(config.username, 'utf8')
              const pBuf = Buffer.from(config.password || '', 'utf8')
              const authBuf = Buffer.alloc(3 + uBuf.length + pBuf.length)
              authBuf[0] = 0x01
              authBuf[1] = uBuf.length
              uBuf.copy(authBuf, 2)
              authBuf[2 + uBuf.length] = pBuf.length
              pBuf.copy(authBuf, 3 + uBuf.length)
              socket.write(authBuf)
            } else if (method === 0x00) {
              phase = 'connect'
              socket.write(buildConnectRequest(targetHost, targetPort))
            } else if (method === 0xff) {
              throw new Error('SOCKS5 proxy rejected all auth methods')
            } else {
              // Server picked a method we don't support
              throw new Error(`SOCKS5 unsupported auth method: 0x${method.toString(16)}`)
            }
          } else if (phase === 'auth') {
            if (buf.length < 2) return
            if (buf[1] !== 0x00) throw new Error('SOCKS5 authentication failed')
            buf = buf.subarray(2)
            phase = 'connect'
            socket.write(buildConnectRequest(targetHost, targetPort))
          } else if (phase === 'connect') {
            if (buf.length < 2) return
            if (buf[0] !== 0x05) throw new Error('Invalid SOCKS5 connect response')
            if (buf[1] !== 0x00) {
              const errors: Record<number, string> = {
                0x01: 'general failure',
                0x02: 'connection not allowed',
                0x03: 'network unreachable',
                0x04: 'host unreachable',
                0x05: 'connection refused',
                0x06: 'TTL expired',
                0x07: 'command not supported',
                0x08: 'address type not supported'
              }
              throw new Error(`SOCKS5: ${errors[buf[1]] || `error 0x${buf[1].toString(16)}`}`)
            }
            const len = connectReplyLen(buf)
            if (len === null) throw new Error('SOCKS5 address type not supported')
            if (len === -1) return // reply header incomplete — wait for more
            // Tunnel established. Anything past the reply is the first of the
            // tunneled stream — hand it back as `leftover`. Pause before
            // detaching so the reader doesn't drop later bytes in flowing mode
            // (the caller's pipe() resumes it).
            const leftover = Buffer.from(buf.subarray(len))
            settled = true
            clearTimeout(timeout)
            socket.removeListener('data', onData)
            socket.pause()
            resolve({ socket, leftover })
            return
          }
        }
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)))
      }
    }

    socket.on('data', onData)
  })
}

function buildConnectRequest(host: string, port: number): Buffer {
  const hostBuf = Buffer.from(host, 'utf8')
  const buf = Buffer.alloc(7 + hostBuf.length)
  buf[0] = 0x05 // SOCKS version
  buf[1] = 0x01 // CONNECT command
  buf[2] = 0x00 // reserved
  buf[3] = 0x03 // domain name address type
  buf[4] = hostBuf.length
  hostBuf.copy(buf, 5)
  buf.writeUInt16BE(port, 5 + hostBuf.length)
  return buf
}

/** Start the local HTTP-to-SOCKS5 bridge. Returns the local port. */
export async function startSocksBridge(config: SocksBridgeConfig): Promise<number> {
  // If already running with same config, return existing port
  if (
    server &&
    bridgePort &&
    currentConfig &&
    currentConfig.socksHost === config.socksHost &&
    currentConfig.socksPort === config.socksPort &&
    currentConfig.username === config.username &&
    currentConfig.password === config.password
  ) {
    return bridgePort
  }

  // Stop existing bridge if config changed
  await stopSocksBridge()

  return new Promise((resolve, reject) => {
    const srv = http.createServer((_req, res) => {
      // Only handle CONNECT; reject regular requests
      res.writeHead(405)
      res.end('Only CONNECT is supported')
    })

    srv.on('connect', (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
      const [host, portStr] = (req.url || '').split(':')
      const port = parseInt(portStr, 10) || 443

      if (!host) {
        clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
        clientSocket.destroy()
        return
      }

      socks5Connect(config, host, port)
        .then(({ socket: proxySocket, leftover }) => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          // Forward any tunnel bytes that rode in with the CONNECT reply first,
          // then the head the client sent, then stream the rest both ways.
          if (leftover.length > 0) clientSocket.write(leftover)
          if (head.length > 0) proxySocket.write(head)
          proxySocket.pipe(clientSocket)
          clientSocket.pipe(proxySocket)

          proxySocket.on('error', () => clientSocket.destroy())
          clientSocket.on('error', () => proxySocket.destroy())
          proxySocket.on('close', () => clientSocket.destroy())
          clientSocket.on('close', () => proxySocket.destroy())
        })
        .catch((err) => {
          logger.warn('SocksBridge', `CONNECT to ${host}:${port} failed: ${err.message}`)
          clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\n\r\n`)
          clientSocket.destroy()
        })
    })

    srv.on('error', (err) => {
      logger.error('SocksBridge', `Server error: ${err.message}`)
      reject(err)
    })

    // Listen on random available port on loopback
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        srv.close()
        reject(new Error('Failed to get bridge address'))
        return
      }
      server = srv
      bridgePort = addr.port
      currentConfig = { ...config }
      logger.info(
        'SocksBridge',
        `SOCKS5 bridge listening on 127.0.0.1:${bridgePort} → ${config.socksHost}:${config.socksPort}`
      )
      resolve(bridgePort)
    })
  })
}

/** Stop the bridge server. */
export async function stopSocksBridge(): Promise<void> {
  if (!server) return
  const srv = server
  server = null
  bridgePort = null
  currentConfig = null
  return new Promise((resolve) => {
    srv.close(() => {
      logger.info('SocksBridge', 'Bridge stopped')
      resolve()
    })
    // Force-close any lingering connections
    srv.closeAllConnections?.()
  })
}

/** Get the current bridge port, or null if not running. */
export function getBridgePort(): number | null {
  return bridgePort
}
