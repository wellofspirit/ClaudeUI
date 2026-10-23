// Run in a bounded subprocess: pickNetFetch intentionally owns its cached agents.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { connect, type Socket } from 'node:net'
import { inspect } from 'node:util'
// Node executes this fixture directly; resolve TS at runtime without changing tsconfig.
const { pickNetFetch }: typeof import('../../net-fetch') = await import(
  new URL('../../net-fetch.ts', import.meta.url).href
)

const sockets = new Set<Socket>()
const servers: Server[] = []
function track(socket: Socket): void {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
}
async function listen(server: Server): Promise<number> {
  servers.push(server)
  server.on('connection', track)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  return address.port
}

try {
  const origin = createServer((req, res) => {
    if (req.url === '/hang') return
    if (req.url === '/disconnect') {
      req.socket.destroy()
      return
    }
    res.writeHead(req.url === '/error' ? 503 : 200)
    res.end(req.url === '/error' ? 'unavailable' : 'origin')
  })
  const originPort = await listen(origin)
  const targets: string[] = []
  const forwarded: string[] = []
  const proxy = createServer((req, res) => {
    const url = new URL(req.url!)
    assert.equal(url.hostname, '127.0.0.1')
    assert.equal(url.port, String(originPort))
    forwarded.push(url.href)
    const upstream = httpRequest(url, (reply) => {
      res.writeHead(reply.statusCode!)
      reply.pipe(res)
    })
    upstream.on('socket', track)
    upstream.on('error', () => res.destroy())
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  })
  proxy.on('connect', (req, client, head) => {
    targets.push(req.url!)
    const [host, port] = req.url!.split(':')
    // The fixture must never become an outbound proxy.
    assert.equal(host, '127.0.0.1')
    const upstream = connect(Number(port), host)
    track(upstream)
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
    upstream.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      client.pipe(upstream).pipe(client)
    })
  })
  const proxyPort = await listen(proxy)
  const proxyUrl = `http://synthetic-user:synthetic-secret@127.0.0.1:${proxyPort}`
  const request = await pickNetFetch({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl })
  const base = `http://127.0.0.1:${originPort}`
  assert.equal(await (await request(base)).text(), 'origin')
  assert.deepEqual(forwarded, [`${base}/`])
  console.log('HTTP proxy routing: ok')

  const bypass = await pickNetFetch({ HTTP_PROXY: proxyUrl, NO_PROXY: '127.0.0.1' })
  const before = forwarded.length
  assert.equal(await (await bypass(base)).text(), 'origin')
  assert.equal(forwarded.length, before)
  console.log('NO_PROXY bypass: ok')

  // Synthetic self-signed localhost fixture (OpenSSL req -x509, RSA-2048).
  // It is deliberately never installed in a trust store.
  const tls = createTlsServer(
    {
      key: readFileSync(new URL('./net-fetch-key.pem', import.meta.url)),
      cert: readFileSync(new URL('./net-fetch-cert.pem', import.meta.url))
    },
    (_req, res) => res.end('must not be trusted')
  )
  const tlsPort = await listen(tls)
  await assert.rejects(request(`https://127.0.0.1:${tlsPort}`), (error: unknown) => {
    const failure = error as Error & { cause?: { code?: string } }
    assert.equal(failure.cause?.code, 'DEPTH_ZERO_SELF_SIGNED_CERT')
    assert(!inspect(failure, { depth: 10 }).includes('synthetic-secret'))
    return true
  })
  assert.deepEqual(targets, [`127.0.0.1:${tlsPort}`])
  console.log('HTTPS CONNECT and untrusted TLS rejection: ok')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 50)
  try {
    await assert.rejects(request(`${base}/hang`, { signal: controller.signal }), {
      name: 'AbortError'
    })
  } finally {
    clearTimeout(timer)
  }
  console.log('AbortSignal cancellation: ok')

  await assert.rejects(request(`${base}/disconnect`), (error: unknown) => {
    const failure = error as Error & { cause?: { code?: string } }
    assert.equal(failure.cause?.code, 'UND_ERR_SOCKET')
    assert(!inspect(failure, { depth: 10 }).includes('synthetic-secret'))
    return true
  })
  const response = await request(`${base}/error`)
  assert.equal(response.status, 503)
  assert.equal(response.ok, false)
  assert.equal(await response.text(), 'unavailable')
  console.log('connection and HTTP errors: ok')
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  for (const socket of sockets) socket.destroy()
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
  // Cached dispatchers are private to production; exiting releases their pools.
  process.exit(process.exitCode ?? 0)
}
