/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { LOG_TEXT_CAP, redactSecrets } from '../redact-secrets'

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
const jwt = `${b64url({ alg: 'RS256' })}.${b64url({ sub: 'user', exp: 1 })}.c2lnbmF0dXJlLXZhbHVl`

describe('redactSecrets', () => {
  it('removes bearers, JWTs, provider keys, secret JSON fields and long opaque runs', () => {
    const text = [
      `Authorization: Bearer ${jwt}`,
      `token ${jwt}`,
      'key sk-ant-api03-abcdefghijk',
      'gh ghp_abcdefghijklmnop',
      '{"refresh":"rt_short","access_token":"x"}',
      'blob QWxhZGRpbjpvcGVuIHNlc2FtZSBhbmQgbW9yZSBieXRlcw=='
    ].join(' | ')
    const out = redactSecrets(text, 10_000)
    for (const secret of [
      jwt,
      'sk-ant-api03-abcdefghijk',
      'ghp_abcdefghijklmnop',
      'rt_short',
      'QWxhZGRp'
    ])
      expect(out).not.toContain(secret)
    expect(out).toContain('"refresh":"[redacted]"')
  })

  it('keeps what classification and diagnosis need, and caps the length', () => {
    expect(redactSecrets('Token refresh failed: 400 invalid_grant')).toBe(
      'Token refresh failed: 400 invalid_grant'
    )
    expect(redactSecrets('x'.repeat(5) + ' '.repeat(1000)).length).toBeLessThanOrEqual(
      LOG_TEXT_CAP + 1
    )
  })
})
