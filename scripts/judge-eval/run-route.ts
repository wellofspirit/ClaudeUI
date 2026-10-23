/**
 * The pure pieces of `run.ts`'s judge-route selection and size estimate. Kept
 * out of `run.ts` because that file runs an eval on import (same split as
 * `replay-scope.ts`), so a test can reach them.
 *
 * Nothing here reads the vault, the network or the environment; the one file it
 * reads is the OpenRouter key file ({@link readKeyFile}).
 */
import { readFileSync } from 'node:fs'
import { capsFor } from '../../src/core/automode/judge-http/caps'
import type { ResolvedJudgeRoute } from '../../src/core/automode/judge-http/types'
import type { JudgeRouteDeps } from '../../src/core/automode/judge-route'
import type { VaultAccount } from '../../src/core/auth/vault/AuthVault'
import type { CodexInjectionToken } from '../../src/core/auth/vault/CredentialSync'

/** Sent to opencode's hosted inference so its operators can tell the eval apart. */
export const ZEN_CLIENT_HEADER = 'ClaudeUI-judge-eval'

/**
 * Server-side output headroom on the hand-built route. The hosted free models
 * reason, and the reasoning counts against `max_tokens`: without it the 64/256
 * token stage-1 cap is spent thinking and the reply comes back empty. Only the
 * wire value grows (`outputCapValue`); the client-side text cap stays at the
 * request's own `maxTokens`.
 */
export const ROUTE_REASONING_HEADROOM = 8192

/** `opencode/big-pickle` → `big-pickle`: everything after the FIRST `/`; no `/` → as given. */
export function wireModelOf(model: string): string {
  return model.slice(model.indexOf('/') + 1)
}

/**
 * The route `--route-url` stands for: an OpenAI chat-completions endpoint
 * `<base>/chat/completions` with a bearer key, instead of whatever
 * `resolveJudgeRoute` would plan. The default key is opencode's public one
 * (`public`, a literal, not a secret).
 */
export function buildCustomRoute(opts: {
  model: string
  baseUrl: string
  key: string
  /** Extra request headers (`--route-header`), added after the defaults. */
  headers?: Readonly<Record<string, string>>
  /** Reasoning headroom in tokens (`--route-headroom`); default {@link ROUTE_REASONING_HEADROOM}. */
  headroom?: number
}): ResolvedJudgeRoute {
  const base = opts.baseUrl.trim().replace(/\/+$/, '')
  if (!base) throw new Error('the route url is empty')
  const wireModel = wireModelOf(opts.model)
  if (!wireModel) throw new Error(`the model "${opts.model}" names no wire model`)
  return {
    kind: 'custom-chat',
    wire: 'chat',
    url: `${base}/chat/completions`,
    model: wireModel,
    headers: {
      Authorization: `Bearer ${opts.key}`,
      'x-opencode-client': ZEN_CLIENT_HEADER,
      ...opts.headers
    },
    caps: {
      ...capsFor('custom-chat', wireModel),
      reasoningHeadroom: opts.headroom ?? ROUTE_REASONING_HEADROOM
    },
    label: `zen · ${wireModel}`,
    account: {
      vendorId: 'opencode',
      accountId: null,
      accountKey: 'eval-zen',
      accountLabel: 'zen-public',
      billingType: 'apiKey'
    }
  }
}

/**
 * `--route-header k=v` entries → a header map. Splits at the FIRST `=`; a later
 * entry for the same name (case-insensitive) wins. `Authorization` is refused
 * (`--route-key` sets it). Errors name the entry's position or the header name,
 * never a value, since a header value can be a secret.
 */
export function parseRouteHeaders(entries: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {}
  const nameAt: Record<string, string> = {}
  entries.forEach((entry, index) => {
    const eq = entry.indexOf('=')
    const name = eq < 0 ? '' : entry.slice(0, eq).trim()
    const value = eq < 0 ? '' : entry.slice(eq + 1).trim()
    if (!/^[A-Za-z0-9-]+$/.test(name))
      throw new Error(`--route-header entry #${index + 1} is not <name>=<value>`)
    if (/[\r\n\0]/.test(value))
      throw new Error(`--route-header "${name}" has a control character in its value`)
    const lower = name.toLowerCase()
    if (lower === 'authorization')
      throw new Error('--route-header cannot set Authorization: use --route-key')
    if (nameAt[lower] !== undefined) delete headers[nameAt[lower]]
    nameAt[lower] = name
    headers[name] = value
  })
  return headers
}

/**
 * `--openrouter-key-file`: the key in `file`, trimmed. Errors name the file and
 * the problem (missing, empty, more than one token), never the content or its
 * length: the file holds a secret.
 */
export function readKeyFile(
  file: string,
  read: (path: string) => string = (path) => readFileSync(path, 'utf-8')
): string {
  let text: string
  try {
    text = read(file)
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code
    throw new Error(
      `could not read the OpenRouter key file ${file}${typeof code === 'string' ? ` (${code})` : ''}`
    )
  }
  // `trim` also strips a BOM (PowerShell's `Out-File` writes one), a CR and the final newline.
  const key = text.trim()
  if (!key) throw new Error(`the OpenRouter key file ${file} is empty`)
  if (/\s/.test(key)) throw new Error(`the OpenRouter key file ${file} holds more than one token`)
  return key
}

/**
 * The `resolveJudgeRoute` dependency that makes `key` pay on an OpenRouter route:
 * the PRODUCTION route (kind, URL, caps, reasoning controls, attribution headers)
 * is still planned by `resolveJudgeRoute`; only the credential it spends differs
 * from the vault's. The resolver loads ONE key per call, the owning definition's,
 * so every id answers with `key`: the caller must have checked that the model
 * names an OpenRouter route (`openrouter/<vendor>/<model>`), or this would hand
 * the key to another provider.
 */
export function openRouterKeyDeps(key: string): Pick<JudgeRouteDeps, 'loadApiKey'> {
  return { loadApiKey: async () => key }
}

/** `--route-headroom`: a positive integer token count, else an Error. */
export function parseRouteHeadroom(text: string): number {
  const n = Number(text)
  if (!Number.isSafeInteger(n) || n < 1 || n > 1_000_000)
    throw new Error('--route-headroom must be a positive integer (tokens)')
  return n
}

/**
 * The vault account a ChatGPT judge call reads: the one `requestedId` names, else
 * the active one. Undefined when there is none — an unknown requested id must be
 * reported by the caller, never silently answered with the active account.
 */
export function pickChatgptAccount(
  accounts: readonly VaultAccount[],
  activeId: string | null,
  requestedId?: string
): VaultAccount | undefined {
  const id = requestedId ?? activeId
  return id ? accounts.find((account) => account.id === id) : undefined
}

/**
 * The injection token of `account`, read-only: no refresh, no vault write. Null
 * when the account is not a workspace-bound OAuth login or its access token has
 * expired (the eval reports that as a judge error rather than refreshing).
 */
export function readOnlyTokenOf(account: VaultAccount, now: number): CodexInjectionToken | null {
  if (
    account.credential.type !== 'oauth' ||
    !account.accountId ||
    account.credential.expires <= now
  )
    return null
  return {
    accessToken: account.credential.access,
    chatgptAccountId: account.accountId,
    chatgptPlanType: account.planType ?? null,
    vaultAccountId: account.id
  }
}

/** The header's account note: the vault id and the plan, never the email. */
export function accountNote(account: Pick<VaultAccount, 'id' | 'planType'>): string {
  return `account ${account.id} (${account.planType ?? 'unknown plan'})`
}

/** Estimated tokens of `chars` characters — the plain chars/4 rule of thumb. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

export interface SizeSummary {
  count: number
  maxChars: number
  maxTokens: number
  medianTokens: number
  /** Cases whose estimated tokens exceed each threshold (strictly). */
  over: Record<number, number>
}

/** Max, median and over-threshold counts of the per-case prompt sizes (characters). */
export function summarizeSizes(
  charSizes: readonly number[],
  thresholds: readonly number[]
): SizeSummary {
  const tokens = charSizes.map(estimateTokens).sort((a, b) => a - b)
  const mid = Math.floor(tokens.length / 2)
  const median =
    tokens.length === 0
      ? 0
      : tokens.length % 2
        ? tokens[mid]
        : Math.round((tokens[mid - 1] + tokens[mid]) / 2)
  return {
    count: tokens.length,
    maxChars: charSizes.reduce((max, n) => Math.max(max, n), 0),
    maxTokens: tokens[tokens.length - 1] ?? 0,
    medianTokens: median,
    over: Object.fromEntries(
      thresholds.map((limit) => [limit, tokens.filter((n) => n > limit).length])
    )
  }
}

/**
 * One `--dump-requests` line: the case, which stage asked, and exactly the
 * system and user text the transport would put on the wire (`wire-chat` /
 * `wire-responses` send `req.system` and `req.user` verbatim). `stage` is
 * `null` for a request that names none.
 */
export function requestDumpLine(
  caseId: string,
  req: { stage?: string; system: string; user: string }
): string {
  return JSON.stringify({
    caseId,
    stage: req.stage ?? null,
    system: req.system,
    user: req.user
  })
}
