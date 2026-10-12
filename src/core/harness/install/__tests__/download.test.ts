/**
 * @vitest-environment node
 *
 * Harness downloads (ADR-082 §4): host allowlists, redirects checked hop by
 * hop, size caps, the response and stall timeouts, and hashing while
 * streaming. `fetch` is a fake; nothing touches the network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  GITHUB_RELEASES,
  HUGGING_FACE,
  NPM_REGISTRY,
  checkUrl,
  downloadToFile,
  fetchJson,
  fetchText
} from '../download'
import { fakeFetch, hangingBody, sha256, sha512b64 } from './fixtures'

const ASSET = 'https://github.com/earendil-works/pi/releases/download/v1.0.0/pi.zip'
const CDN = 'https://release-assets.githubusercontent.com/x/pi.zip?sig=secret'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-download-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('checkUrl', () => {
  it('accepts an allowed host over https', () => {
    expect(checkUrl('https://registry.npmjs.org/x', ['registry.npmjs.org']).host).toBe(
      'registry.npmjs.org'
    )
  })

  it.each([
    'http://registry.npmjs.org/x',
    'https://registry.npmjs.org.evil.test/x',
    'https://evil.test/registry.npmjs.org',
    'https://user:pass@registry.npmjs.org/x',
    'https://registry.npmjs.org:8443/x',
    'file:///etc/passwd',
    'not a url'
  ])('refuses %s', (url) => {
    expect(() => checkUrl(url, ['registry.npmjs.org'])).toThrow()
  })
})

describe('checkUrl with host suffixes', () => {
  const check = (url: string): unknown =>
    checkUrl(url, HUGGING_FACE.redirectHosts, HUGGING_FACE.redirectHostSuffixes)

  it.each([
    'https://us.aws.cdn.hf.co/xet-bridge-us/abc',
    'https://eu.cdn.hf.co/x',
    'https://a.b.c.cdn.hf.co/x',
    'https://cas-bridge.xethub.hf.co/xet-bridge-us/abc',
    'https://cdn-lfs.hf.co/repos/x',
    'https://cdn-lfs.huggingface.co/repos/x',
    'https://huggingface.co/api/resolve-cache/x'
  ])('accepts %s', (url) => {
    expect(check(url)).toBeInstanceOf(URL)
  })

  it.each([
    'https://evil.cdn.hf.co.attacker.com/x',
    'https://hf.co.evil/x',
    'https://evilhf.co/x',
    'https://evilhuggingface.co/x',
    'https://hf.co/x',
    'https://huggingface.co.attacker.com/x',
    'https://huggingface.co.evil.test/x',
    'https://us.aws.cdn.hf.co./x',
    'http://us.aws.cdn.hf.co/x',
    'https://us.aws.cdn.hf.co:8443/x',
    'https://user:pw@us.aws.cdn.hf.co/x'
  ])('refuses %s', (url) => {
    expect(() => check(url)).toThrow(/not an allowed download host/)
  })

  it('names the suffix as a wildcard in the refusal', () => {
    expect(() => check('https://evil.test/x')).toThrow(
      /huggingface\.co, \*\.hf\.co, \*\.huggingface\.co/
    )
  })

  it('does not widen anything for a caller that passes no suffixes', () => {
    expect(() => checkUrl('https://us.aws.cdn.hf.co/x', ['huggingface.co'])).toThrow()
  })
})

describe('downloadToFile with a suffix policy', () => {
  const MODEL = 'https://huggingface.co/org/repo/resolve/abc/model.onnx'
  const get = (f: ReturnType<typeof fakeFetch>) =>
    downloadToFile(MODEL, path.join(tmp, 'model'), {
      fetch: f.fetch,
      policy: HUGGING_FACE,
      maxBytes: 64
    })

  it('follows a redirect chain through huggingface.co to a regional CDN host', async () => {
    const edge = 'https://us.aws.cdn.hf.co/xet-bridge-us/abc?sig=secret'
    const f = fakeFetch({
      [MODEL]: {
        redirect: 'https://huggingface.co/api/resolve-cache/models/org/repo/abc/model.onnx'
      },
      'https://huggingface.co/api/resolve-cache/models/org/repo/abc/model.onnx': { redirect: edge },
      [edge]: { body: 'weights' }
    })
    const result = await get(f)
    expect(result.bytes).toBe(7)
    expect(f.calls).toHaveLength(3)
  })

  it.each([
    'https://evil.cdn.hf.co.attacker.com/x',
    'https://hf.co.evil/x',
    'https://evilhf.co/x',
    'https://huggingface.co.attacker.com/x'
  ])('refuses a redirect to %s without requesting it', async (target) => {
    const f = fakeFetch({ [MODEL]: { redirect: target }, [target]: { body: 'x' } })
    await expect(get(f)).rejects.toThrow(/which is not an allowed host/)
    expect(f.calls).toEqual([MODEL])
  })

  it('applies the suffix to redirects only: a request may not START at a CDN host', async () => {
    const f = fakeFetch({ 'https://us.aws.cdn.hf.co/x': { body: 'x' } })
    await expect(
      downloadToFile('https://us.aws.cdn.hf.co/x', path.join(tmp, 'a'), {
        fetch: f.fetch,
        policy: HUGGING_FACE,
        maxBytes: 64
      })
    ).rejects.toThrow(/not an allowed download host/)
    expect(f.calls).toEqual([])
  })

  it('leaves exact-match policies exact: a subdomain of a redirect host is still refused', async () => {
    const f = fakeFetch({
      [ASSET]: { redirect: 'https://cdn.release-assets.githubusercontent.com/x' }
    })
    await expect(
      downloadToFile(ASSET, path.join(tmp, 'a'), {
        fetch: f.fetch,
        policy: GITHUB_RELEASES,
        maxBytes: 64
      })
    ).rejects.toThrow(/not an allowed host/)
  })
})

describe('downloadToFile', () => {
  it('follows an allowed redirect and hashes while streaming', async () => {
    const body = Buffer.from('archive bytes')
    const f = fakeFetch({ [ASSET]: { redirect: CDN }, [CDN]: { body } })
    const progress: number[] = []
    const dest = path.join(tmp, 'pi.zip')
    const result = await downloadToFile(ASSET, dest, {
      fetch: f.fetch,
      policy: GITHUB_RELEASES,
      maxBytes: 1024,
      onProgress: (received) => progress.push(received)
    })
    expect(result).toEqual({ bytes: body.length, sha256: sha256(body), sha512: sha512b64(body) })
    expect(fs.readFileSync(dest)).toEqual(body)
    expect(f.calls).toEqual([ASSET, CDN])
    expect(progress.at(-1)).toBe(body.length)
  })

  it('refuses a redirect to a host outside the policy, without fetching it', async () => {
    const evil = 'https://objects.evil.test/pi.zip'
    const f = fakeFetch({ [ASSET]: { redirect: evil }, [evil]: { body: 'x' } })
    await expect(
      downloadToFile(ASSET, path.join(tmp, 'a'), {
        fetch: f.fetch,
        policy: GITHUB_RELEASES,
        maxBytes: 1024
      })
    ).rejects.toThrow(/redirected to https:\/\/objects\.evil\.test, which is not an allowed host/)
    expect(f.calls).toEqual([ASSET])
  })

  it('refuses a redirect back to an http URL and a registry redirect of any kind', async () => {
    const f = fakeFetch({
      [ASSET]: { redirect: 'http://release-assets.githubusercontent.com/x' },
      'https://registry.npmjs.org/p': { redirect: 'https://registry.npmjs.org/q' }
    })
    await expect(
      downloadToFile(ASSET, path.join(tmp, 'a'), {
        fetch: f.fetch,
        policy: GITHUB_RELEASES,
        maxBytes: 1024
      })
    ).rejects.toThrow(/not an allowed host/)
    await expect(
      fetchText('https://registry.npmjs.org/p', {
        fetch: f.fetch,
        policy: NPM_REGISTRY,
        maxBytes: 1024
      })
    ).rejects.toThrow(/not an allowed host/)
  })

  it('refuses a starting URL outside the policy without requesting it', async () => {
    const f = fakeFetch()
    await expect(
      downloadToFile('https://evil.test/x', path.join(tmp, 'a'), {
        fetch: f.fetch,
        policy: GITHUB_RELEASES,
        maxBytes: 1024
      })
    ).rejects.toThrow(/not an allowed download host/)
    expect(f.calls).toEqual([])
  })

  it('stops after too many redirects', async () => {
    const hop = (n: number): string => `https://release-assets.githubusercontent.com/${n}`
    const routes: Record<string, { redirect: string }> = { [ASSET]: { redirect: hop(0) } }
    for (let i = 0; i < 10; i++) routes[hop(i)] = { redirect: hop(i + 1) }
    const f = fakeFetch(routes)
    await expect(
      downloadToFile(ASSET, path.join(tmp, 'a'), {
        fetch: f.fetch,
        policy: GITHUB_RELEASES,
        maxBytes: 1024
      })
    ).rejects.toThrow(/too many redirects/)
  })

  it('fails on an HTTP error, naming the URL without its query', async () => {
    const f = fakeFetch({ [ASSET]: { redirect: CDN }, [CDN]: { status: 403, body: 'no' } })
    const err = await downloadToFile(ASSET, path.join(tmp, 'a'), {
      fetch: f.fetch,
      policy: GITHUB_RELEASES,
      maxBytes: 1024
    }).catch((e: Error) => e)
    expect((err as Error).message).toBe(
      'https://release-assets.githubusercontent.com/x/pi.zip answered HTTP 403'
    )
    expect((err as Error).message).not.toContain('secret')
  })

  it('refuses a body over the cap, declared or streamed', async () => {
    const declared = fakeFetch({
      [ASSET]: { body: 'x'.repeat(10), headers: { 'content-length': '5000' } }
    })
    await expect(
      downloadToFile(ASSET, path.join(tmp, 'a'), {
        fetch: declared.fetch,
        policy: GITHUB_RELEASES,
        maxBytes: 100
      })
    ).rejects.toThrow(/5000 bytes, over the 100 byte limit/)
    const streamed = fakeFetch({ [ASSET]: { body: 'x'.repeat(500) } })
    await expect(
      downloadToFile(ASSET, path.join(tmp, 'b'), {
        fetch: streamed.fetch,
        policy: GITHUB_RELEASES,
        maxBytes: 100
      })
    ).rejects.toThrow(/over the 100 byte limit/)
  })

  it('times out a request that never answers, and a body that stalls', async () => {
    const silent = fakeFetch({
      [ASSET]: (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    })
    await expect(
      downloadToFile(ASSET, path.join(tmp, 'a'), {
        fetch: silent.fetch,
        policy: GITHUB_RELEASES,
        maxBytes: 100,
        responseTimeoutMs: 20
      })
    ).rejects.toThrow(/did not answer in time/)

    const stalling = fakeFetch({ [ASSET]: hangingBody('start') })
    await expect(
      downloadToFile(ASSET, path.join(tmp, 'b'), {
        fetch: stalling.fetch,
        policy: GITHUB_RELEASES,
        maxBytes: 100,
        stallTimeoutMs: 20
      })
    ).rejects.toThrow(/stopped sending data/)
  })

  it('stops when the caller aborts', async () => {
    const controller = new AbortController()
    const f = fakeFetch({
      [ASSET]: hangingBody('start', () => setTimeout(() => controller.abort(), 5))
    })
    await expect(
      downloadToFile(ASSET, path.join(tmp, 'a'), {
        fetch: f.fetch,
        policy: GITHUB_RELEASES,
        maxBytes: 100,
        signal: controller.signal
      })
    ).rejects.toThrow()
    expect(controller.signal.aborted).toBe(true)
  })

  it('never overwrites an existing file', async () => {
    const dest = path.join(tmp, 'a')
    fs.writeFileSync(dest, 'keep')
    const f = fakeFetch({ [ASSET]: { body: 'new' } })
    await expect(
      downloadToFile(ASSET, dest, { fetch: f.fetch, policy: GITHUB_RELEASES, maxBytes: 100 })
    ).rejects.toThrow(/EEXIST/)
    expect(fs.readFileSync(dest, 'utf8')).toBe('keep')
  })
})

describe('fetchJson', () => {
  it('parses JSON and reports a non-JSON answer', async () => {
    const f = fakeFetch({
      'https://registry.npmjs.org/a': { body: '{"ok":true}' },
      'https://registry.npmjs.org/b': { body: '<html>' }
    })
    const opts = { fetch: f.fetch, policy: NPM_REGISTRY, maxBytes: 100 }
    expect(await fetchJson('https://registry.npmjs.org/a', opts)).toEqual({ ok: true })
    await expect(fetchJson('https://registry.npmjs.org/b', opts)).rejects.toThrow(
      /not answer with JSON/
    )
  })
})
