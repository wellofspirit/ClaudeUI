/**
 * What `run.ts` does to a judge request before it goes to a third party (any route
 * but the owner's ChatGPT subscription: OpenRouter, OpenAI, a custom endpoint, a
 * hand-built `--route-url`): mask the owner's identifying handles, and withhold any
 * request that looks like it carries a credential. Pure: the handles are derived by
 * the caller (`run.ts` reads the OS user, `USERPROFILE` and the git remotes and
 * identity) and handed in, so this file holds no real handle and a test can use
 * synthetic ones.
 */
import type { JudgeRequest, JudgeTransport } from '../../src/core/automode/classifier'

export interface GuardPolicyInput {
  /** `--route-url`: a hand-built route, always a third party. */
  customRoute: boolean
  /**
   * `describeJudgeRoute`'s verdict on `--model` for the real route resolver (its
   * `chatgpt: true` marks the owner's ChatGPT subscription, signed in or not).
   * `undefined` when there was none to ask or the check failed.
   */
  described: { chatgpt?: true } | undefined
  /** `--mask-identity`: force masking on. */
  mask?: boolean
  /** `--no-mask-identity`: force masking off. */
  noMask?: boolean
}

export interface GuardPolicy {
  /** The request goes to anyone but the owner's ChatGPT subscription. */
  thirdParty: boolean
  maskIdentity: boolean
  scanCredentials: boolean
}

/**
 * The guard a run gets. The ChatGPT subscription is the production judge, which
 * already receives this data, so a run on it is unmasked and unscanned unless
 * `--mask-identity` asks. EVERY other route is a third party and defaults to both
 * protections; only an explicit `--no-mask-identity` lowers the mask (the
 * deny-list has no off switch). A route nobody could classify (no description) is a
 * third party: the safe side. Throws when both flags are given.
 */
export function guardPolicy(input: GuardPolicyInput): GuardPolicy {
  if (input.mask && input.noMask)
    throw new Error('--mask-identity and --no-mask-identity cannot be combined')
  const thirdParty = input.customRoute || input.described?.chatgpt !== true
  return {
    thirdParty,
    maskIdentity: !input.noMask && (Boolean(input.mask) || thirdParty),
    scanCredentials: thirdParty
  }
}

/** Replaces the Windows / OS login handle in paths such as `C:\Users\<handle>`. */
export const MASK_WINDOWS_HANDLE = 'user'
/** Replaces the GitHub owner handle in remote URLs (`owner`, then `owner2`, …). */
export const MASK_GITHUB_OWNER = 'owner'
/** Replaces each label of the git email's domain (`example` in `a@example.com`). */
export const MASK_GIT_ORG = 'org'
/** Replaces each word of the git author name. */
export const MASK_GIT_NAME = 'name'

/**
 * Domain labels that name a registry, not an organisation: never masked, since they
 * are ordinary words in every URL and masking them would only corrupt the text.
 */
const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  'com',
  'co',
  'net',
  'org',
  'io',
  'au',
  'nz',
  'uk',
  'edu',
  'gov',
  'us',
  'ca',
  'de',
  'fr',
  'jp',
  'cn',
  'in',
  'info',
  'biz',
  'dev',
  'app',
  'ai',
  'me',
  'eu',
  'ch',
  'nl',
  'se',
  'br'
])

/** One handle and the text that stands in for it. */
export interface HandleMask {
  handle: string
  replacement: string
}

export type TextMasker = (text: string) => string

/** What `run.ts` could read off the machine: all optional, all raw. */
export interface IdentityInputs {
  /** `os.userInfo().username` */
  username?: string
  /** `process.env.USERPROFILE` (its last path segment is the profile folder name) */
  userProfile?: string
  /** Output of `git -C <root> remote -v` */
  remotes?: string
  /** `git config user.email` */
  gitEmail?: string
  /** `git config user.name` */
  gitName?: string
}

/** The local part and the non-suffix domain labels (3+ characters) of an email address. */
export function emailPartsOf(email: string): { local: string; labels: string[] } {
  const at = email.trim().lastIndexOf('@')
  if (at <= 0) return { local: '', labels: [] }
  const labels = email
    .slice(at + 1)
    .trim()
    .split('.')
    .filter((label) => label.length >= 3 && !PUBLIC_SUFFIXES.has(label.toLowerCase()))
  return { local: email.slice(0, at).trim(), labels }
}

/** Every run of 3+ letters in a person's name (`Ada Q. Lovelace` gives `Ada`, `Lovelace`). */
export function nameWordsOf(name: string): string[] {
  return name.match(/\p{L}{3,}/gu) ?? []
}

/** The last non-empty segment of a Windows or POSIX path. */
function lastSegment(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part.length > 0)
  return parts[parts.length - 1] ?? ''
}

/**
 * The GitHub owners named by `git remote -v` output (`github.com[:/]<owner>/`),
 * `origin` first, otherwise in order of appearance, each once (case-insensitive).
 */
export function githubOwnersOf(remotes: string): string[] {
  const seen = new Set<string>()
  const origin: string[] = []
  const others: string[] = []
  for (const line of remotes.split(/\r?\n/)) {
    const match = /^(\S+)\s+\S*github\.com[:/]([A-Za-z0-9][A-Za-z0-9-]*)\//i.exec(line)
    if (!match) continue
    const owner = match[2]
    if (seen.has(owner.toLowerCase())) continue
    seen.add(owner.toLowerCase())
    ;(match[1] === 'origin' ? origin : others).push(owner)
  }
  return [...origin, ...others]
}

/**
 * Every handle to hide, with its stand-in: the OS login and the `USERPROFILE`
 * folder name → `user`, each GitHub owner → `owner` (a second distinct owner →
 * `owner2`, so two accounts never collapse into one). The git identity adds the
 * email's local part → `user`, each non-suffix domain label → `org` and each word
 * of the author name (3+ letters) → `name`. A handle is listed once
 * (case-insensitive); the first claim on it wins.
 */
export function identityMasks(inputs: IdentityInputs): HandleMask[] {
  const masks: HandleMask[] = []
  const claimed = new Set<string>()
  const add = (handle: string | undefined, replacement: string): void => {
    const trimmed = handle?.trim()
    if (!trimmed || claimed.has(trimmed.toLowerCase())) return
    claimed.add(trimmed.toLowerCase())
    masks.push({ handle: trimmed, replacement })
  }
  add(inputs.username, MASK_WINDOWS_HANDLE)
  if (inputs.userProfile) add(lastSegment(inputs.userProfile), MASK_WINDOWS_HANDLE)
  githubOwnersOf(inputs.remotes ?? '').forEach((owner, index) =>
    add(owner, index === 0 ? MASK_GITHUB_OWNER : `${MASK_GITHUB_OWNER}${index + 1}`)
  )
  const email = emailPartsOf(inputs.gitEmail ?? '')
  add(email.local, MASK_WINDOWS_HANDLE)
  for (const label of email.labels) add(label, MASK_GIT_ORG)
  for (const word of nameWordsOf(inputs.gitName ?? '')) add(word, MASK_GIT_NAME)
  return masks
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Characters an email local part is made of (RFC 5322 "atext" subset that real addresses use). */
const EMAIL_CHAR = '[A-Za-z0-9._%+-]'
const EMAIL_LOCAL = `${EMAIL_CHAR}*`

/**
 * Case-insensitive replacement of every handle in ONE pass (so a stand-in is
 * never itself re-masked, and a longer handle wins over one it contains), in two
 * forms:
 *
 * - **whole token**: bounded by anything but `[A-Za-z0-9_]`, so a path separator,
 *   a hyphen (`Users-<handle>-Work`), a dot, a quote, `@` or `:` bounds it, while
 *   `<handle>s` or `my<handle>` is a different word and stays;
 * - **email local part** (tried from the start of the address, so a long run of
 *   address characters is scanned once): a local part that merely CONTAINS the handle
 *   (`<handle>2024@host`, `first.<handle>@host`) is replaced whole, since an
 *   address derived from a login is the same identity and a token rule would let
 *   it through. The domain after the `@` is left alone.
 *
 * - **login prefix**: a `user` handle's proper prefix of 3+ characters right after a
 *   `Users` path segment (`Users\ali[0-9]+`, `/Users/alice*`, also with the doubled
 *   backslashes of an escaped regex or its `[/\\]` class), where the whole handle never
 *   appears.
 *
 * The same stand-in replaces a handle wherever it occurs, so a path or a remote
 * compared inside the prompt stays consistent.
 */
export function makeIdentityMasker(masks: readonly HandleMask[]): TextMasker {
  const standIn = new Map(masks.map((m) => [m.handle.toLowerCase(), m.replacement]))
  if (standIn.size === 0) return (text) => text
  const alternation = [...standIn.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')
  // A login's proper prefixes (3+ characters), longest first, for a regex-like path such as
  // `Users\\ali[0-9]+` or `/Users/alice*`, where the whole handle never appears.
  const prefixes = new Map<string, string>()
  for (const mask of masks) {
    if (mask.replacement !== MASK_WINDOWS_HANDLE) continue
    const lower = mask.handle.toLowerCase()
    for (let end = lower.length - 1; end >= 3; end--)
      if (!standIn.has(lower.slice(0, end))) prefixes.set(lower.slice(0, end), mask.replacement)
  }
  const prefixArm =
    prefixes.size === 0
      ? ''
      : `|(?<=Users(?:[\\\\/]|\\\\\\\\|\\[[\\\\/]+\\])+)(${[...prefixes.keys()]
          .sort((a, b) => b.length - a.length)
          .map(escapeRegExp)
          .join('|')})(?![A-Za-z0-9_])`
  const pattern = new RegExp(
    `(?<!${EMAIL_CHAR})${EMAIL_LOCAL}(${alternation})${EMAIL_LOCAL}(?=@)|(?<![A-Za-z0-9_])(${alternation})(?![A-Za-z0-9_])${prefixArm}`,
    'gi'
  )
  const longest = [...standIn.keys()].sort((a, b) => b.length - a.length)
  return (text) =>
    text.replace(pattern, (hit, inEmail?: string, token?: string, prefix?: string) => {
      if (prefix !== undefined) return prefixes.get(prefix.toLowerCase()) ?? hit
      if (token !== undefined) return standIn.get(token.toLowerCase()) ?? hit
      // An address is one identity: the stand-in of the longest handle it contains,
      // not of whichever one the regex engine happened to backtrack onto.
      const local = hit.toLowerCase()
      const best =
        inEmail === undefined ? undefined : longest.find((handle) => local.includes(handle))
      return (best && standIn.get(best)) ?? hit
    })
}

/** The request with its system and user text masked; every other field untouched. */
export function maskRequest(req: JudgeRequest, mask: TextMasker): JudgeRequest {
  return { ...req, system: mask(req.system), user: mask(req.user) }
}

/**
 * Shapes that are a credential, never a prompt: provider API keys, GitHub /
 * GitLab / Slack / AWS / Google tokens, JWTs, a bearer value, a PEM private key.
 * The index of the first match is part of the withheld error, so the list is
 * append-only. (A `-` last in a class is the literal hyphen the original patterns
 * escaped; the matched set is the same.) Not global: `test` keeps no state between calls.
 */
export const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:ant-|or-|proj-)?[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[\w-]{15,}/,
  /\bxox[abposr]-[\w-]{10,}/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /AIza[\w-]{35}/,
  /eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]*/,
  /Bearer\s+(?!\[REDACTED)[\w.~+/-]{20,}=*/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/
]

/**
 * Index into {@link CREDENTIAL_PATTERNS} of the first pattern any of `texts`
 * matches, or -1. Each text is tested alone, so a match never spans two of them.
 */
export function credentialPatternIndex(...texts: string[]): number {
  return CREDENTIAL_PATTERNS.findIndex((pattern) => texts.some((text) => pattern.test(text)))
}

export interface GuardOptions {
  /** Applied to system and user text before anything else; absent = no masking. */
  mask?: TextMasker
  /** Withhold a request whose (masked) text matches {@link CREDENTIAL_PATTERNS}. */
  scan: boolean
  /** Called once per withheld request, with the matched pattern's index. */
  onWithheld?: (patternIndex: number) => void
}

/**
 * `inner`, behind the mask and the deny-list: `inner` only ever sees the masked
 * request, and never sees a request the scan matched (that call rejects with
 * `request withheld: matched credential pattern <index>`, which the classifier
 * records as the case's error). The message names the pattern, not the match.
 */
export function guardTransport(inner: JudgeTransport, options: GuardOptions): JudgeTransport {
  return async (req) => {
    const out = options.mask ? maskRequest(req, options.mask) : req
    if (options.scan) {
      const index = credentialPatternIndex(out.system, out.user)
      if (index >= 0) {
        options.onWithheld?.(index)
        throw new Error(`request withheld: matched credential pattern ${index}`)
      }
    }
    return inner(out)
  }
}
