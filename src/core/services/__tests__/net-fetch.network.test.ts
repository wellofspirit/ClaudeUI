import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('uses real Undici proxy routing, TLS validation, cancellation and error semantics', async () => {
  // Do not inherit the developer's proxy, TLS overrides or Node preload hooks.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/proxy|^NODE_OPTIONS$|^NODE_EXTRA_CA_CERTS$|^NODE_TLS_REJECT_UNAUTHORIZED$/i.test(key)
    )
  )
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/net-fetch-network.mts', import.meta.url))],
    { env, timeout: 10_000, maxBuffer: 1024 * 1024 }
  )
  expect(stderr).not.toContain('synthetic-secret')
  expect(stdout.trim().split(/\r?\n/)).toEqual([
    'HTTP proxy routing: ok',
    'NO_PROXY bypass: ok',
    'HTTPS CONNECT and untrusted TLS rejection: ok',
    'AbortSignal cancellation: ok',
    'connection and HTTP errors: ok'
  ])
}, 15_000)
