/**
 * HTTP for harness installs (ADR-082 §4): an allowlist of hosts per source,
 * redirects followed by hand and checked against the source's redirect hosts,
 * a timeout until the response arrives and a stall timeout while the body
 * streams, and a size cap. Bodies stream to a file, hashed as they arrive.
 *
 * `fetch` is injected: the installer passes the proxy-aware one
 * (`services/net-fetch.ts`), tests a fake.
 *
 * Messages name the host and path, never a query string (GitHub's asset
 * redirects carry signed ones).
 */
import { createHash, type Hash } from 'node:crypto'
import * as fsp from 'node:fs/promises'

export class DownloadError extends Error {
  override name = 'DownloadError'
}

/** Which hosts a request may start at, and which it may be redirected to. */
export interface HostPolicy {
  hosts: readonly string[]
  redirectHosts: readonly string[]
}

/** opencode: package metadata and tarballs. The registry does not redirect. */
export const NPM_REGISTRY: HostPolicy = { hosts: ['registry.npmjs.org'], redirectHosts: [] }

/**
 * pi and Codex release assets: `github.com/<owner>/<repo>/releases/download/...`
 * answers 302 to its asset CDN. `release-assets.githubusercontent.com` is the
 * only host that redirect goes to (checked 2026-09-30 for pi 0.87.1 and Codex
 * 0.156.0 assets); any other target fails the download.
 */
export const GITHUB_RELEASES: HostPolicy = {
  hosts: ['github.com'],
  redirectHosts: ['release-assets.githubusercontent.com']
}

/** Codex's LICENSE at the pinned source commit, as `ensure-codex.mjs` fetches it. */
export const GITHUB_RAW: HostPolicy = { hosts: ['raw.githubusercontent.com'], redirectHosts: [] }

/** pi's release list (upstream versions only; nothing is downloaded from it). */
export const GITHUB_API: HostPolicy = { hosts: ['api.github.com'], redirectHosts: [] }

export const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000
export const DEFAULT_STALL_TIMEOUT_MS = 30_000
const MAX_REDIRECTS = 5

export interface RequestOptions {
  fetch: typeof fetch
  policy: HostPolicy
  signal?: AbortSignal
  headers?: Record<string, string>
  /** Until the response headers arrive, per hop. */
  responseTimeoutMs?: number
  /** The longest gap between two body chunks. */
  stallTimeoutMs?: number
}

/** `https://host/path` of a URL, for messages. */
export function describeUrl(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`
}

/** `url` as a URL whose host is one of `hosts`, over HTTPS, without credentials or a port. */
export function checkUrl(url: string | URL, hosts: readonly string[]): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new DownloadError('invalid download URL')
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    !hosts.includes(parsed.hostname)
  ) {
    throw new DownloadError(
      `${parsed.protocol}//${parsed.host} is not an allowed download host (allowed: ${
        hosts.length > 0 ? hosts.join(', ') : 'none'
      })`
    )
  }
  return parsed
}

interface Opened {
  response: Response
  url: URL
  /** Aborts the body with a stall; the caller arms it per chunk. */
  armStall: () => void
  stalled: () => boolean
  release: () => void
}

function isAbort(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** GET `url`, following redirects allowed by the policy. Throws on a non-2xx answer. */
async function open(url: string, opts: RequestOptions): Promise<Opened> {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(opts.signal?.reason)
  if (opts.signal?.aborted) onAbort()
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  let stalled = false
  const stallMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS
  const release = (): void => {
    opts.signal?.removeEventListener('abort', onAbort)
    clearTimeout(stallTimer)
  }

  let current = checkUrl(url, opts.policy.hosts)
  try {
    for (let hop = 0; ; hop++) {
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, opts.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS)
      let response: Response
      try {
        response = await opts.fetch(current, {
          redirect: 'manual',
          signal: controller.signal,
          ...(opts.headers ? { headers: opts.headers } : {})
        })
      } catch (err) {
        if (timedOut) throw new DownloadError(`${describeUrl(current)} did not answer in time`)
        if (isAbort(opts.signal)) throw err
        throw new DownloadError(
          `${describeUrl(current)}: ${err instanceof Error ? err.message : String(err)}`
        )
      } finally {
        clearTimeout(timer)
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {})
        const location = response.headers.get('location')
        if (!location) throw new DownloadError(`${describeUrl(current)} redirected nowhere`)
        if (hop >= MAX_REDIRECTS)
          throw new DownloadError(`${describeUrl(current)}: too many redirects`)
        let next: URL
        try {
          next = new URL(location, current)
        } catch {
          throw new DownloadError(`${describeUrl(current)} redirected to an invalid URL`)
        }
        try {
          current = checkUrl(next, opts.policy.redirectHosts)
        } catch {
          throw new DownloadError(
            `${describeUrl(current)} redirected to ${next.protocol}//${next.host}, which is not an allowed host`
          )
        }
        continue
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new DownloadError(`${describeUrl(current)} answered HTTP ${response.status}`)
      }
      return {
        response,
        url: current,
        armStall: () => {
          clearTimeout(stallTimer)
          stallTimer = setTimeout(() => {
            stalled = true
            controller.abort()
          }, stallMs)
        },
        stalled: () => stalled,
        release
      }
    }
  } catch (err) {
    release()
    throw err
  }
}

/**
 * Stream `opened`'s body to `sink`, capped at `maxBytes`, with the stall
 * timeout armed between chunks.
 */
async function pump(
  opened: Opened,
  maxBytes: number,
  signal: AbortSignal | undefined,
  sink: (chunk: Uint8Array) => Promise<void> | void
): Promise<number> {
  const { response, url } = opened
  try {
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {})
      throw new DownloadError(
        `${describeUrl(url)} is ${declared} bytes, over the ${maxBytes} byte limit`
      )
    }
    if (!response.body) throw new DownloadError(`${describeUrl(url)} sent no body`)
    const reader = response.body.getReader()
    let received = 0
    try {
      for (;;) {
        opened.armStall()
        let chunk: ReadableStreamReadResult<Uint8Array>
        try {
          chunk = await reader.read()
        } catch (err) {
          if (opened.stalled()) {
            throw new DownloadError(`${describeUrl(url)} stopped sending data`)
          }
          if (isAbort(signal)) throw err
          throw new DownloadError(
            `${describeUrl(url)}: ${err instanceof Error ? err.message : String(err)}`
          )
        }
        if (chunk.done) return received
        received += chunk.value.length
        if (received > maxBytes) {
          throw new DownloadError(`${describeUrl(url)} is over the ${maxBytes} byte limit`)
        }
        await sink(chunk.value)
      }
    } catch (err) {
      await reader.cancel().catch(() => {})
      throw err
    }
  } finally {
    opened.release()
  }
}

export interface DownloadFileOptions extends RequestOptions {
  maxBytes: number
  /** Called after each chunk with the bytes so far and the declared total, if any. */
  onProgress?: (receivedBytes: number, totalBytes: number | undefined) => void
}

export interface DownloadedFile {
  bytes: number
  /** Hex. */
  sha256: string
  /** Base64, as npm's `integrity` carries it. */
  sha512: string
}

/** GET `url` into `dest` (created, never overwritten), hashing as it streams. */
export async function downloadToFile(
  url: string,
  dest: string,
  opts: DownloadFileOptions
): Promise<DownloadedFile> {
  const opened = await open(url, opts)
  const declared = Number(opened.response.headers.get('content-length'))
  const total = Number.isFinite(declared) && declared > 0 ? declared : undefined
  let handle: fsp.FileHandle
  try {
    handle = await fsp.open(dest, 'wx')
  } catch (err) {
    await opened.response.body?.cancel().catch(() => {})
    opened.release()
    throw err
  }
  const sha256: Hash = createHash('sha256')
  const sha512: Hash = createHash('sha512')
  let bytes = 0
  try {
    bytes = await pump(opened, opts.maxBytes, opts.signal, async (chunk) => {
      sha256.update(chunk)
      sha512.update(chunk)
      await handle.write(chunk)
      opts.onProgress?.(bytes + chunk.length, total)
      bytes += chunk.length
    })
  } finally {
    await handle.close()
  }
  return { bytes, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') }
}

/** GET `url` into memory, capped at `maxBytes` (metadata, checksums, a LICENSE). */
export async function fetchBytes(
  url: string,
  opts: RequestOptions & { maxBytes: number }
): Promise<Buffer> {
  const opened = await open(url, opts)
  const chunks: Uint8Array[] = []
  await pump(opened, opts.maxBytes, opts.signal, (chunk) => {
    chunks.push(chunk)
  })
  return Buffer.concat(chunks)
}

/** GET `url` as UTF-8 text, capped at `maxBytes`. */
export async function fetchText(
  url: string,
  opts: RequestOptions & { maxBytes: number }
): Promise<string> {
  return (await fetchBytes(url, opts)).toString('utf8')
}

/** GET `url` as JSON, capped at `maxBytes`. */
export async function fetchJson(
  url: string,
  opts: RequestOptions & { maxBytes: number }
): Promise<unknown> {
  const text = await fetchText(url, opts)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new DownloadError(`${describeUrl(new URL(url))} did not answer with JSON`)
  }
}
