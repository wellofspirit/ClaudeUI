/**
 * The `fetch` the HTTP judge sends with (ADR-081 §6).
 *
 * The engines' judges honoured `HTTP(S)_PROXY` because the engines do; Node's
 * global `fetch` does not. So when a proxy variable is set we use undici's own
 * `fetch` bound to an `EnvHttpProxyAgent` — both from the one declared `undici`
 * dependency, so no dispatcher crosses package copies — and otherwise the
 * global `fetch`. undici is imported lazily: the common, proxy-less path never
 * loads it.
 *
 * The agent is built from the INJECTED env with explicit options rather than
 * letting undici read `process.env` itself: that keeps `env` the single source
 * of truth, and it lets `ALL_PROXY` (which undici does not read) stand in for
 * either scheme. Only HTTP(S) proxy URLs work — a `socks5://` `ALL_PROXY` fails
 * the call, which fails the judge closed to the human.
 */

type Env = Readonly<Record<string, string | undefined>>

/** A variable by name, in any case (`https_proxy`, `HTTPS_PROXY`, …); empty = unset. */
function envGet(env: Env, name: string): string | undefined {
  const lower = name.toLowerCase()
  const exact = env[lower] || env[name.toUpperCase()]
  if (exact) return exact
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lower && value) return value
  }
  return undefined
}

interface ProxySettings {
  httpProxy?: string
  httpsProxy?: string
  noProxy?: string
}

/** The proxy settings `env` asks for, or null when it sets no proxy at all. */
function proxySettings(env: Env): ProxySettings | null {
  const all = envGet(env, 'ALL_PROXY')
  const httpProxy = envGet(env, 'HTTP_PROXY') ?? all
  const httpsProxy = envGet(env, 'HTTPS_PROXY') ?? all
  if (!httpProxy && !httpsProxy) return null
  const noProxy = envGet(env, 'NO_PROXY')
  return {
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(noProxy ? { noProxy } : {})
  }
}

/**
 * Keyed by the proxy settings' JSON, so a changed env gets its own agent. The
 * key can hold proxy credentials (`http://user:pass@host`): it lives only here,
 * in memory, and is never logged.
 */
const memo = new Map<string, Promise<typeof fetch>>()

async function proxiedFetch(settings: ProxySettings): Promise<typeof fetch> {
  const undici = await import('undici')
  const dispatcher = new undici.EnvHttpProxyAgent(settings)
  // undici's fetch types are its own (structurally the same at runtime), hence
  // the casts at this one seam.
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    undici.fetch(input as never, { ...init, dispatcher } as never)) as unknown as typeof fetch
}

/**
 * Global `fetch` unless `env` sets `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`
 * (any case), in which case undici's `fetch` behind an `EnvHttpProxyAgent`.
 * The proxied fetch is memoized per proxy configuration (one agent, one
 * connection pool); a failed undici load is not cached, so the next call
 * retries it. The global one is read afresh each call — there is nothing to
 * build.
 */
export function pickJudgeFetch(env: Env = process.env): Promise<typeof fetch> {
  const settings = proxySettings(env)
  if (!settings) return Promise.resolve(globalThis.fetch)
  const key = JSON.stringify(settings)
  const hit = memo.get(key)
  if (hit) return hit
  const picked = proxiedFetch(settings)
  memo.set(key, picked)
  picked.catch(() => memo.delete(key))
  return picked
}
