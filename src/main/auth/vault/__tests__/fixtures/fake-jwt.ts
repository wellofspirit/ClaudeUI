/**
 * JWT-shaped FAKE ChatGPT access tokens for the identity tests. The payload
 * carries the claims CredentialSync reads, under the same namespaces a real
 * token uses; the signature is the literal `sig`. Pass obvious fakes only
 * (`ws-a`, `user-a`, `a@example.test`).
 */
export function fakeChatgptJwt(opts: {
  ws: string
  plan?: string
  user?: string
  email?: string
  /** Distinguishes two tokens of one workspace. */
  tag?: string
}): string {
  const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  const payload: Record<string, unknown> = {
    'https://api.openai.com/auth': {
      chatgpt_account_id: opts.ws,
      ...(opts.plan ? { chatgpt_plan_type: opts.plan } : {}),
      ...(opts.user ? { chatgpt_user_id: opts.user } : {})
    },
    ...(opts.email ? { 'https://api.openai.com/profile': { email: opts.email } } : {}),
    ...(opts.tag ? { jti: opts.tag } : {})
  }
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`
}
