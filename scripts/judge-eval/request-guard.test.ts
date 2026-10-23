/**
 * The identity mask and the credential deny-list that sit in front of a
 * third-party judge call, and the policy that decides when they apply. Handles here are synthetic (`alice7`, `acme-org`):
 * the real ones are derived at run time and never written down. Credential-shaped
 * strings are assembled from parts so no scanner mistakes this file for a leak.
 */
import { describe, expect, it, vi } from 'vitest'
import type { JudgeRequest } from '../../src/core/automode/classifier'
import {
  CREDENTIAL_PATTERNS,
  credentialPatternIndex,
  emailPartsOf,
  githubOwnersOf,
  guardPolicy,
  guardTransport,
  identityMasks,
  makeIdentityMasker,
  maskRequest,
  nameWordsOf
} from './request-guard'

describe('githubOwnersOf', () => {
  const remotes = [
    'backup\thttps://github.com/zeta-co/repo.git (fetch)',
    'origin\tgit@github.com:acme-org/Widget.git (fetch)',
    'origin\tgit@github.com:acme-org/Widget.git (push)',
    'upstream\thttps://user@github.com/ACME-ORG/other.git (fetch)',
    'gitlab\thttps://gitlab.com/someone/else.git (fetch)'
  ].join('\n')

  it('lists origin first, each owner once (case-insensitive), github hosts only', () => {
    expect(githubOwnersOf(remotes)).toEqual(['acme-org', 'zeta-co'])
  })

  it('reads ssh:// and https:// forms and ignores output with no remote', () => {
    expect(githubOwnersOf('origin\tssh://git@github.com/acme-org/x.git (fetch)')).toEqual([
      'acme-org'
    ])
    expect(githubOwnersOf('')).toEqual([])
  })
})

describe('identityMasks', () => {
  it('maps the login and the USERPROFILE folder to user, the owner to owner', () => {
    const masks = identityMasks({
      username: 'Alice7',
      userProfile: 'C:\\Users\\alice7',
      remotes: 'origin\thttps://github.com/acme-org/x.git (fetch)'
    })
    expect(masks).toEqual([
      { handle: 'Alice7', replacement: 'user' },
      { handle: 'acme-org', replacement: 'owner' }
    ])
  })

  it('keeps a differing profile folder name as a second login handle', () => {
    const masks = identityMasks({ username: 'alice7', userProfile: 'C:\\Users\\alice.work\\' })
    expect(masks.map((m) => m.handle)).toEqual(['alice7', 'alice.work'])
    expect(masks.every((m) => m.replacement === 'user')).toBe(true)
  })

  it('keeps two distinct owners distinct and skips empty inputs', () => {
    const masks = identityMasks({
      username: '  ',
      remotes:
        'origin\thttps://github.com/acme-org/x.git (fetch)\nfork\thttps://github.com/bob-9/x.git (fetch)'
    })
    expect(masks).toEqual([
      { handle: 'acme-org', replacement: 'owner' },
      { handle: 'bob-9', replacement: 'owner2' }
    ])
  })
})

describe('makeIdentityMasker', () => {
  const mask = makeIdentityMasker(
    identityMasks({
      username: 'alice7',
      userProfile: 'C:\\Users\\alice7',
      remotes: 'origin\tgit@github.com:acme-org/widget.git (fetch)'
    })
  )

  it('replaces the handle in Windows and POSIX-style paths, any case', () => {
    expect(mask('C:\\Users\\alice7\\proj and /c/Users/Alice7/proj and C:/USERS/ALICE7')).toBe(
      'C:\\Users\\user\\proj and /c/Users/user/proj and C:/USERS/user'
    )
  })

  it('replaces the owner in remote URLs, so a path-and-remote comparison stays consistent', () => {
    const text =
      'origin git@github.com:acme-org/widget.git; trusted https://github.com/ACME-ORG/widget'
    expect(mask(text)).toBe(
      'origin git@github.com:owner/widget.git; trusted https://github.com/owner/widget'
    )
    // The same handle always becomes the same stand-in.
    expect(mask('a alice7 b')).toBe(mask('a Alice7 b'))
  })

  it('treats a hyphen, dot or quote as a token edge', () => {
    expect(mask('C--Users-alice7-Work and alice7.txt and "alice7"')).toBe(
      'C--Users-user-Work and user.txt and "user"'
    )
  })

  it('leaves a longer word that merely contains the handle alone', () => {
    expect(mask('alice7s malice7 alice7_x')).toBe('alice7s malice7 alice7_x')
  })

  it('replaces a whole email local part that embeds the handle, keeping the domain', () => {
    expect(mask('mail alice70042@example.org, first.Alice7+tag@example.org and alice7@host')).toBe(
      'mail user@example.org, user@example.org and user@host'
    )
    // The same address inside a regex-escaped scrub script (a real leak this rule closes).
    expect(mask('re.compile(r"alice70042@example\\.org")')).toBe(
      're.compile(r"user@example\\.org")'
    )
    // Other people's addresses and a bare word without an @ are not touched.
    expect(mask('bob@example.org alice70042 and git@github.com:acme-org/x.git')).toBe(
      'bob@example.org alice70042 and git@github.com:owner/x.git'
    )
  })

  it('does not go quadratic on a long run of address characters with no @', () => {
    const run = 'a1-'.repeat(60_000)
    const started = performance.now()
    expect(mask(run)).toBe(run)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('is one pass: a stand-in is never re-masked and the longer handle wins', () => {
    const once = makeIdentityMasker([
      { handle: 'owner', replacement: 'user' },
      { handle: 'owner-x', replacement: 'o' },
      { handle: 'a.b', replacement: 'owner' }
    ])
    expect(once('owner-x and owner and a.b')).toBe('o and user and owner')
    // A dot in a handle is literal, not "any character".
    expect(once('aXb')).toBe('aXb')
  })

  it('is the identity function when there is nothing to mask', () => {
    expect(makeIdentityMasker([])('C:\\Users\\whoever')).toBe('C:\\Users\\whoever')
  })

  it('maskRequest masks system and user and keeps every other field', () => {
    const signal = new AbortController().signal
    const req: JudgeRequest = {
      system: 'sys /c/Users/alice7',
      user: 'usr acme-org',
      maxTokens: 64,
      stopSequences: ['</x>'],
      signal,
      stage: 'fast'
    }
    expect(maskRequest(req, mask)).toEqual({
      ...req,
      system: 'sys /c/Users/user',
      user: 'usr owner'
    })
  })
})

describe('git identity masks', () => {
  // Synthetic: nothing here is a real person, login or company.
  const inputs = {
    username: 'zorro42',
    gitEmail: 'zed.quill@acme-widgets.co.nz',
    gitName: 'Zed Q. Quillan'
  }

  it('reads the local part and the non-suffix domain labels of an address', () => {
    expect(emailPartsOf('zed.quill@acme-widgets.co.nz')).toEqual({
      local: 'zed.quill',
      labels: ['acme-widgets']
    })
    expect(emailPartsOf('a@mail.example.com')).toEqual({ local: 'a', labels: ['mail', 'example'] })
    expect(emailPartsOf('no-at-sign')).toEqual({ local: '', labels: [] })
    expect(emailPartsOf('@example.com')).toEqual({ local: '', labels: [] })
  })

  it('reads each word of 3+ letters of a name', () => {
    expect(nameWordsOf('Zed Q. Quillan')).toEqual(['Zed', 'Quillan'])
    expect(nameWordsOf("Jo-Ann O'Neil")).toEqual(['Ann', 'Neil'])
    expect(nameWordsOf('')).toEqual([])
  })

  it('maps local part to user, domain labels to org and name words to name', () => {
    expect(identityMasks(inputs)).toEqual([
      { handle: 'zorro42', replacement: 'user' },
      { handle: 'zed.quill', replacement: 'user' },
      { handle: 'acme-widgets', replacement: 'org' },
      { handle: 'Zed', replacement: 'name' },
      { handle: 'Quillan', replacement: 'name' }
    ])
  })

  it('masks every part whole-token and case-insensitively, and an address as one identity', () => {
    const mask = makeIdentityMasker(identityMasks(inputs))
    expect(mask('Author: ZED Quillan <zed.quill@acme-widgets.co.nz>')).toBe(
      'Author: name name <user@org.co.nz>'
    )
    expect(mask('https://acme-widgets.example.org/zed.quill and acme-widgets')).toBe(
      'https://org.example.org/user and org'
    )
    // A longer word that merely contains a token stays.
    expect(mask('zedge quillans acme-widgetsx')).toBe('zedge quillans acme-widgetsx')
  })

  it('keeps the first claim when a name word equals the login', () => {
    const masks = identityMasks({ username: 'quillan', gitName: 'Zed Quillan' })
    expect(masks).toEqual([
      { handle: 'quillan', replacement: 'user' },
      { handle: 'Zed', replacement: 'name' }
    ])
  })

  it('is empty without a git identity', () => {
    expect(identityMasks({ gitEmail: '', gitName: '  ' })).toEqual([])
  })
})

describe('login prefix after a Users segment', () => {
  const mask = makeIdentityMasker(identityMasks({ username: 'zorro42' }))

  it('masks a prefix of 3+ characters in a regex-like path, in every slash style', () => {
    // An escaped regex source: doubled backslashes.
    expect(mask('C:\\\\Users\\\\zor[0-9]+\\\\.claude')).toBe('C:\\\\Users\\\\user[0-9]+\\\\.claude')
    expect(mask('/c/Users/zorro*/x and C:\\Users\\zorro4.')).toBe(
      '/c/Users/user*/x and C:\\Users\\user.'
    )
    expect(mask('r"[/\\\\]Users[/\\\\]zorr\\w+"')).toBe('r"[/\\\\]Users[/\\\\]user\\w+"')
  })

  it('leaves a shorter prefix, another login and a prefix outside a Users segment alone', () => {
    expect(mask('C:\\Users\\zo\\x')).toBe('C:\\Users\\zo\\x')
    expect(mask('C:\\Users\\zorro420\\x')).toBe('C:\\Users\\zorro420\\x')
    expect(mask('/home/zorro/x and zor.txt')).toBe('/home/zorro/x and zor.txt')
  })

  it('still prefers the whole handle', () => {
    expect(mask('C:\\Users\\zorro42\\x')).toBe('C:\\Users\\user\\x')
  })
})

describe('credential deny-list', () => {
  const rep = (ch: string, n: number): string => ch.repeat(n)
  // One synthetic hit per pattern, by index.
  const hits: string[] = [
    `key sk-${rep('a', 24)}`,
    `key sk-ant-${rep('B', 24)}`,
    `tok ghp_${rep('1', 24)}`,
    `tok github_pat_${rep('x', 24)}`,
    `tok glpat-${rep('y', 18)}`,
    `tok xoxb-${rep('1', 12)}`,
    `aws AKIA${rep('A', 16)}`,
    `aws ASIA${rep('B', 16)}`,
    `goog AIza${rep('z', 35)}`,
    `jwt eyJ${rep('a', 9)}.eyJ${rep('b', 9)}.${rep('c', 5)}`,
    `Authorization: Bearer ${rep('t', 30)}`,
    `-----BEGIN ${'RSA '}PRIVATE KEY-----`
  ]

  it('has one hit for each of the ten patterns', () => {
    const indices = new Set(hits.map((text) => credentialPatternIndex(text)))
    expect([...indices].sort((a, b) => a - b)).toEqual(
      Array.from({ length: CREDENTIAL_PATTERNS.length }, (_, i) => i)
    )
  })

  it.each(hits.map((text) => [text.slice(0, 24), text]))('matches %s...', (_name, text) => {
    expect(credentialPatternIndex(text)).toBeGreaterThanOrEqual(0)
  })

  it('does not match ordinary prompt text, a redacted bearer, or a short token', () => {
    expect(credentialPatternIndex('Authorization: Bearer [REDACTED]')).toBe(-1)
    expect(credentialPatternIndex('Bearer short')).toBe(-1)
    expect(credentialPatternIndex('the task-runner risk-assessment sk-short ghp_abc')).toBe(-1)
    expect(credentialPatternIndex('git push origin feature/skills-and-things')).toBe(-1)
    expect(credentialPatternIndex('C:\\Users\\user\\proj -----BEGIN CERTIFICATE-----')).toBe(-1)
  })

  it('returns the first matching pattern, and tests each text alone', () => {
    expect(credentialPatternIndex('clean', hits[2])).toBe(1)
    // A match may not span the end of one text and the start of the next.
    expect(credentialPatternIndex('Bearer', rep('t', 30))).toBe(-1)
    // Repeated calls give the same answer (no sticky lastIndex).
    expect(credentialPatternIndex(hits[0])).toBe(0)
    expect(credentialPatternIndex(hits[0])).toBe(0)
  })
})

describe('guardTransport', () => {
  const req = (over: Partial<JudgeRequest> = {}): JudgeRequest => ({
    system: 'sys',
    user: 'usr',
    maxTokens: 64,
    ...over
  })
  const mask = makeIdentityMasker([{ handle: 'alice7', replacement: 'user' }])

  it('hands the inner transport the MASKED request and returns its reply', async () => {
    const inner = vi.fn(async (r: JudgeRequest) => `<block>no</block> ${r.user}`)
    const out = await guardTransport(inner, { mask, scan: true })(
      req({ system: '/c/Users/alice7', user: 'cd /c/Users/Alice7', stage: 'fast' })
    )
    expect(inner).toHaveBeenCalledTimes(1)
    expect(inner.mock.calls[0][0]).toEqual({
      system: '/c/Users/user',
      user: 'cd /c/Users/user',
      maxTokens: 64,
      stage: 'fast'
    })
    expect(out).toContain('cd /c/Users/user')
  })

  it('withholds a request with a credential in the system OR the user text, and counts it', async () => {
    const inner = vi.fn(async () => 'x')
    const onWithheld = vi.fn()
    const send = guardTransport(inner, { scan: true, onWithheld })
    const key = `sk-${'a'.repeat(24)}`
    await expect(send(req({ user: `export K=${key}` }))).rejects.toThrow(
      'request withheld: matched credential pattern 0'
    )
    await expect(send(req({ system: `Bearer ${'t'.repeat(30)}` }))).rejects.toThrow(
      'request withheld: matched credential pattern 8'
    )
    expect(inner).not.toHaveBeenCalled()
    expect(onWithheld.mock.calls).toEqual([[0], [8]])
  })

  it('never puts the matched text in the error', async () => {
    const key = `ghp_${'q'.repeat(24)}`
    const send = guardTransport(async () => 'x', { scan: true })
    const err = await send(req({ user: key })).catch((e: unknown) => e)
    expect(String(err)).not.toContain(key)
  })

  it('does not scan when scan is off (a route that stays on the machine)', async () => {
    const inner = vi.fn(async () => 'ok')
    const send = guardTransport(inner, { scan: false })
    await expect(send(req({ user: `sk-${'a'.repeat(24)}` }))).resolves.toBe('ok')
  })

  it('passes a request through untouched when there is neither mask nor scan', async () => {
    const inner = vi.fn(async () => 'ok')
    const original = req({ system: '/c/Users/alice7' })
    await guardTransport(inner, { scan: false })(original)
    expect(inner).toHaveBeenCalledWith(original)
  })
})

describe('guardPolicy', () => {
  // `describeJudgeRoute` marks only the owner's ChatGPT subscription `chatgpt: true`
  // (whether or not the account is signed in); every other route says nothing.
  const chatgpt = { chatgpt: true as const }

  it('leaves a ChatGPT-subscription run unmasked and unscanned: the production judge', () => {
    expect(guardPolicy({ customRoute: false, described: chatgpt })).toEqual({
      thirdParty: false,
      maskIdentity: false,
      scanCredentials: false
    })
  })

  it.each([
    // OpenRouter, OpenAI, a catalog or custom provider, or a route the resolver refuses
    // (no key, unsupported protocol): described, but never marked `chatgpt`.
    ['a route the resolver describes without the chatgpt flag', {}],
    ['a check that could not be made', undefined]
  ])('masks and scans %s by default', (_label, described) => {
    expect(guardPolicy({ customRoute: false, described })).toEqual({
      thirdParty: true,
      maskIdentity: true,
      scanCredentials: true
    })
  })

  it('treats --route-url as a third party even for a model the resolver would call ChatGPT', () => {
    expect(guardPolicy({ customRoute: true, described: chatgpt })).toMatchObject({
      thirdParty: true,
      maskIdentity: true,
      scanCredentials: true
    })
  })

  it('--mask-identity forces masking on a ChatGPT run, still without the deny-list', () => {
    expect(guardPolicy({ customRoute: false, described: chatgpt, mask: true })).toEqual({
      thirdParty: false,
      maskIdentity: true,
      scanCredentials: false
    })
  })

  it('--no-mask-identity lowers the mask on a third party but never the deny-list', () => {
    expect(guardPolicy({ customRoute: false, described: {}, noMask: true })).toEqual({
      thirdParty: true,
      maskIdentity: false,
      scanCredentials: true
    })
  })

  it('refuses both mask flags at once', () => {
    expect(() =>
      guardPolicy({ customRoute: false, described: chatgpt, mask: true, noMask: true })
    ).toThrow('cannot be combined')
  })
})
