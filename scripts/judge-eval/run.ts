/**
 * Replay the auto-mode judge cases (./cases.ts) against a LIVE judge model and
 * report each verdict against the policy's intent (ADR-091).
 *
 *   bun scripts/judge-eval/run.ts [--runs 3] [--model openai-codex/gpt-6-luna]
 *     [--engine pi] [--case '#4'] [--root <repo checkout>] [--json <out>]
 *     [--cases-file <cases.json> [--labels <labels.json>]] [--fs-facts <facts.json>]
 *
 * `--root` swaps in ANOTHER checkout's classifier, policy and redirect
 * measurement (e.g. a worktree at a pre-change commit) while the cases and the
 * judge route stay this checkout's — the before/after comparison. The judge is
 * called through ClaudeUI's own route resolver (the vault on disk), exactly as a
 * session calls it; nothing here prints a header, key or token.
 *
 * `--cases-file` loads extracted REAL cases (`judge-eval/extract-real.ts`)
 * instead of the built-in sets, and their environment is used exactly as
 * stored (no synthetic darwin defaults). `--labels` supplies the expectation
 * per case id; a case without a label prints UNLABELLED and counts neither
 * pass nor fail, so an extracted deny can be replayed before it is labelled.
 *
 * `--fs-facts` supplies the redirect MEASUREMENTS the historical machine can no
 * longer answer: a fake probe answers from that file, so
 * `exists`/`empty`/`modifiedSinceSessionStart` reflect the state at the time of
 * the real call. An OUT-OF-SCOPE target absent from the facts is NOT measured (the
 * probe throws a non-ENOENT error and the field is omitted); every other
 * unrecorded path (scope roots, ancestor directories, in-scope targets) is an
 * ordinary, link-free entry, as production would have found it (see `./fs-facts`);
 * the file format is in {@link loadFsFacts}. Without `--fs-facts` the runner keeps the pure
 * scope-only analysis (measurement would be a guess on this machine).
 *
 * `--openrouter-key-file <path>` (with `--model openrouter/<vendor>/<model>`) resolves the
 * model through the PRODUCTION OpenRouter route, but spends the key in that file instead of
 * the vault's. The file is read once, trimmed, and never printed.
 *
 * `--chatgpt-account <vault id>` reads THAT vault account's token (read-only, no
 * refresh) instead of the active one. `--route-url <base>` [`--route-key`] skips
 * the route resolver for a hand-built OpenAI chat-completions route (opencode's
 * hosted free models). `--dry-run-sizes` builds every request through the real
 * transport with a fake fetch that sends nothing, and reports the prompt sizes;
 * `--dump-requests <file.jsonl>` (dry run only) also writes every built request's
 * text, one JSON line each, so what a free-model eval would send can be scanned.
 *
 * A request that goes to ANY third party (every route except the owner's ChatGPT
 * subscription, which is the production judge already receiving this data) has two
 * protections in front of the transport (`./request-guard`): identity masking
 * (`--mask-identity`, default on there, `--no-mask-identity` to disable; also applied
 * to a dry run and its dump) and a credential deny-list that withholds a matching
 * request. Which side a run is on comes from the resolved route (see `guardPolicy`).
 * `--route-header` and `--route-headroom` tune a `--route-url` route for a hosted
 * model that wants a header or a larger reasoning budget.
 *
 * Every run costs real judge calls (stage 1, plus stage 2 when stage 1 blocks),
 * except a `--dry-run-sizes` run, which makes none.
 */
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, resolve } from 'node:path'
import type { JudgeTransport } from '../../src/core/automode/classifier'
import { makeHttpJudgeTransport } from '../../src/core/automode/judge-http/transport'
import {
  describeJudgeRoute,
  resolveJudgeRoute,
  type JudgeEngine
} from '../../src/core/automode/judge-route'
import { authVault, CHATGPT_PROVIDER_ID } from '../../src/core/auth/vault/AuthVault'
import type { CodexInjectionToken } from '../../src/core/auth/vault/CredentialSync'
import type { ChatMessage } from '../../src/shared/types'
import {
  BASH_CASES,
  CASES,
  CWD,
  DELEGATED_CASES,
  HISTORY_CASES,
  P2C_CASES,
  SOURCE_CASES,
  type EvalCase
} from './cases'
import {
  expectedFor,
  normalizeResult,
  scoreCase,
  type EvalLabel,
  type EvalResult,
  type Expectation
} from './match'
import { fsFactsProbe, outOfScopeTargets, type FsFacts, type FsFactsCase } from './fs-facts'
import {
  legacyReplayScope,
  replayRedirectScope,
  type ReplayScopeFacts,
  type RedirectScopeBuilder
} from './replay-scope'
import {
  accountNote,
  buildCustomRoute,
  estimateTokens,
  parseRouteHeaders,
  parseRouteHeadroom,
  pickChatgptAccount,
  openRouterKeyDeps,
  readKeyFile,
  readOnlyTokenOf,
  requestDumpLine,
  summarizeSizes
} from './run-route'
import {
  guardPolicy,
  guardTransport,
  identityMasks,
  makeIdentityMasker,
  type IdentityInputs
} from './request-guard'

const { values: args } = parseArgs({
  options: {
    runs: { type: 'string', default: '3' },
    model: { type: 'string', default: 'openai-codex/gpt-6-luna' },
    engine: { type: 'string', default: 'pi' },
    'judge-reasoning': { type: 'string', default: 'default' },
    case: { type: 'string', multiple: true },
    root: { type: 'string', default: resolve(import.meta.dir, '../..') },
    json: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
    'cases-file': { type: 'string' },
    labels: { type: 'string' },
    'fs-facts': { type: 'string' },
    'chatgpt-account': { type: 'string' },
    'route-url': { type: 'string' },
    'route-key': { type: 'string', default: 'public' },
    'route-header': { type: 'string', multiple: true },
    'route-headroom': { type: 'string' },
    'openrouter-key-file': { type: 'string' },
    'mask-identity': { type: 'boolean' },
    'no-mask-identity': { type: 'boolean' },
    'dry-run-sizes': { type: 'boolean', default: false },
    'dump-requests': { type: 'string' },
    help: { type: 'boolean', default: false }
  }
})

if (args.help) {
  console.log(`judge-eval — replay auto-mode judge cases (spends real judge calls)

Usage: bun scripts/judge-eval/run.ts [options]
  --runs <n>            runs per case (default 3)
  --model <provider/id> judge model (default openai-codex/gpt-6-luna)
  --engine <pi|opencode> judge route engine (default pi)
  --judge-reasoning <default|off>  eval-only: \`off\` also switches reasoning off at
                        stage 2 on an OpenRouter route (speed vs accuracy runs)
  --case <id>           only this case id; repeatable
  --root <checkout>     measure with ANOTHER checkout's classifier + ground truth
  --json <file>         write the per-case result rows
  --concurrency <n>     parallel judge calls (default 4)
  --cases-file <file>   extracted REAL cases instead of the built-in sets
  --labels <file>       { [caseId]: label } expectations for those cases
  --fs-facts <file>     measured redirect facts, per case:
                        {"<caseId>":{"sessionStartMs":n,"paths":{"<resolved path>":
                          {"exists":bool,"size"?:n,"mtimeMs"?:n,"symlink"?:bool,"realpath"?:string}}}}
                        An out-of-scope target absent from the facts is not
                        measured and its fields are omitted (never an invented
                        exists:false); any other unrecorded path is an ordinary
                        directory/entry, and there are no links unless recorded.
  --chatgpt-account <id> read this vault account (accounts.chatgpt.list[].id)
                        instead of the active one; read-only, never refreshed.
                        An unknown id exits non-zero.
  --route-url <base>    skip the route resolver: POST <base>/chat/completions
                        (OpenAI chat wire), wire model = the part of --model
                        after the first '/'. For opencode's hosted free models:
                        https://opencode.ai/inference/openai/v1
  --route-key <key>     bearer key for --route-url (default: public, a literal)
  --route-header <k=v>  extra request header on the --route-url route; repeatable
                        (e.g. x-opencode-project=claudeui-judge-eval). Cannot set
                        Authorization. Values are never printed.
  --route-headroom <n>  output headroom in tokens for the --route-url route, on top
                        of each stage's own cap, for reasoning models (default 8192)
  --openrouter-key-file <path>
                        spend the OpenRouter key in this file (one line, trimmed,
                        never printed) instead of the vault's, on the production
                        OpenRouter route: same URL, caps, reasoning controls and
                        attribution headers. Needs --model openrouter/<vendor>/<model>;
                        not combinable with --route-url.
  --mask-identity       replace the OS login / USERPROFILE folder name with \`user\`,
                        each GitHub owner in \`git -C <root> remote -v\` with \`owner\`
                        and the git author's email / name parts with \`user\` / \`org\` /
                        \`name\` (whole-token, case-insensitive) in every system and
                        user text before it is sent or dumped. Default ON for every
                        route that does NOT go to the owner's ChatGPT subscription
                        (an OpenRouter / OpenAI / custom route, --route-url); a
                        ChatGPT run is the production judge and is unmasked by default.
                        --mask-identity forces it on, --no-mask-identity off.
                        On the same third-party routes every request is also scanned
                        for credential shapes (API keys, tokens, JWTs, bearer values,
                        private keys); a hit is NOT sent: that call fails with
                        "request withheld: matched credential pattern <index>" and
                        the run reports how many were withheld.
  --dry-run-sizes       send NOTHING: run every case through the real request
                        builder with a fake fetch, then print each case's
                        system+user size (chars, est. tokens = chars/4) and the
                        max / median / over-150k / over-190k summary. Makes no
                        judge call and needs no credential; --runs is ignored.
  --dump-requests <file.jsonl>  (dry run only; refused without --dry-run-sizes)
                        also write one JSON line per built request,
                        {caseId, stage, system, user}: exactly the text a real
                        run would send, for a privacy scan. Contains the case
                        transcripts: keep the file out of the repository.
  --help                this text
`)
  process.exit(0)
}

/**
 * The provenance block `extract-real.ts` adds under `real`. Only `tempDirs`
 * changes what this runner does (the checkout's own ground truth measures the
 * redirects); the rest is echoed into the JSON report for the orchestrator.
 * Typed loosely: a case file is external JSON, validated by `loadCasesFile`.
 */
interface RealProvenance {
  route: string
  engine: string
  sessionId: string
  file: string
  line: number
  callId: string
  timestamp: number
  originalReason: string
  fidelity: string[]
  redactions: Record<string, number>
  tempDirs: string[]
}

type LoadedCase = EvalCase & { real?: RealProvenance }

function fail(message: string): never {
  console.error(`judge-eval: ${message}`)
  process.exit(1)
}

/** Parse a JSON file, exiting with the file's ROLE (never its contents) on a bad one. */
function loadJson(file: string, role: string): unknown {
  try {
    return JSON.parse(readFileSync(resolve(file), 'utf-8')) as unknown
  } catch (err) {
    fail(`could not read the ${role}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Structural check only — a detail that is wrong is a bug in the producer, not here. */
function isCase(value: unknown): value is LoadedCase {
  if (typeof value !== 'object' || value === null) return false
  const c = value as Record<string, unknown>
  return (
    typeof c.id === 'string' &&
    typeof c.title === 'string' &&
    Array.isArray(c.messages) &&
    typeof c.action === 'object' &&
    c.action !== null &&
    typeof (c.action as Record<string, unknown>).toolName === 'string'
  )
}

/** `--cases-file`: the extracted EvalCase[] (with `real` blocks), ids only in errors. */
function loadCasesFile(file: string): LoadedCase[] {
  const parsed = loadJson(file, 'cases file')
  if (!Array.isArray(parsed) || parsed.length === 0) fail('the cases file holds no cases')
  const cases: LoadedCase[] = []
  for (const [index, value] of parsed.entries()) {
    if (!isCase(value)) fail(`case #${index + 1} in the cases file is not an eval case`)
    if (!value.environment || typeof value.environment.cwd !== 'string')
      fail(`case ${value.id} in the cases file has no environment.cwd`)
    cases.push(value)
  }
  return cases
}

/** `--labels`: `{ [caseId]: EvalLabel }`. */
function loadLabels(file: string): Record<string, EvalLabel> {
  const parsed = loadJson(file, 'labels file')
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    fail('the labels file is not an object keyed by case id')
  const labels: Record<string, EvalLabel> = {}
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) fail(`label ${id} is not an object`)
    const label = value as Record<string, unknown>
    if (label.expect !== 'allow' && label.expect !== 'block')
      fail(`label ${id} has no expect of 'allow' or 'block'`)
    if (label.expectCategories !== undefined && !Array.isArray(label.expectCategories))
      fail(`label ${id} has a non-array expectCategories`)
    if (label.actionMetaOverride !== undefined && typeof label.actionMetaOverride !== 'object')
      fail(`label ${id} has a non-object actionMetaOverride`)
    labels[id] = label as unknown as EvalLabel
  }
  return labels
}

/**
 * `--fs-facts`: `{ "<caseId>": { "sessionStartMs": n, "paths": { "<resolved
 * path exactly as redirectTargetDetails reports it>": { … } } } }`. The per-path
 * fact shape is {@link FsFactsPath} in `./fs-facts`; an omitted `size`/`mtimeMs`
 * there means "not measured", never zero (exit review Astra C1).
 */
function loadFsFacts(file: string): FsFacts {
  const parsed = loadJson(file, 'fs facts file')
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    fail('the fs facts file is not an object keyed by case id')
  const facts: FsFacts = {}
  for (const [caseId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null)
      fail(`fs facts for ${caseId} are not an object`)
    const entry = value as Record<string, unknown>
    if (typeof entry.sessionStartMs !== 'number')
      fail(`fs facts for ${caseId} have no numeric sessionStartMs`)
    if (typeof entry.paths !== 'object' || entry.paths === null || Array.isArray(entry.paths))
      fail(`fs facts for ${caseId} have no paths object`)
    facts[caseId] = entry as unknown as FsFactsCase
  }
  return facts
}

const root = resolve(args.root!)
const classifier = await import(`${root}/src/core/automode/classifier.ts`)
const groundTruth = await import(`${root}/src/core/automode/ground-truth.ts`)
/**
 * P2a-2's measurement module. Absent from a baseline `--root` checkout, which
 * is the point of the before/after comparison; the runner then uses the
 * checkout's own pure `analyzeRedirects`.
 */
const measureMod = (await import(`${root}/src/core/automode/redirect-measure.ts`).catch(
  () => null
)) as {
  captureRedirects?: (
    command: string,
    scope: Record<string, unknown>,
    options: Record<string, unknown>
  ) => Promise<unknown>
} | null
/**
 * The shared `RedirectScope` builder (ruling 11). A pre-P2a-2 checkout has no
 * `action-meta.ts` at all; the runner then builds the scope it always did.
 */
const actionMetaMod = (await import(`${root}/src/core/automode/action-meta.ts`).catch(
  () => null
)) as { redirectScopeFor?: RedirectScopeBuilder } | null
const fsFacts = args['fs-facts'] ? loadFsFacts(args['fs-facts']) : undefined
// Absent before ADR-091: the pre-change judge read parent + trajectory only.
const trajectoryMod = await import(`${root}/src/core/automode/trajectory.ts`)
const hasTimeOrder = typeof trajectoryMod.inTimeOrder === 'function'

/** The synthetic environment of the built-in cases (never merged into real ones). */
const environment = {
  cwd: CWD,
  platform: 'darwin',
  remotes: [{ name: 'origin', url: 'git@github.com:example/vnc-probe.git' }],
  repoVisibility: 'private'
}

/** The transcript the judge reads — for a delegated case, as THIS root builds it. */
function transcriptFor(c: EvalCase): ChatMessage[] {
  if (!c.delegated) return c.messages
  const { parent, queued, trajectory } = c.delegated
  return hasTimeOrder
    ? trajectoryMod.inTimeOrder(parent, queued, trajectory)
    : [...parent, ...trajectory]
}

/**
 * The classifier's Environment section. A real case carries its own (built by
 * the production builder at extraction, `remotes` and trust lists included);
 * a built-in case gets the synthetic darwin defaults layered under its own
 * path overrides, as before.
 */
function environmentFor(c: LoadedCase): typeof environment {
  return c.real ? (c.environment as typeof environment) : { ...environment, ...c.environment }
}

/**
 * The shell dialect a case's command would be read in (ruling 3): the real
 * case's route engine, else a dispatch case's target engine, else POSIX — the
 * built-in set is written in POSIX/bash terms. opencode's shell is PowerShell
 * on win32 and POSIX elsewhere; pi's `bash` is POSIX everywhere.
 */
function shellForCase(c: LoadedCase, platform: string): 'posix' | 'powershell' {
  const engine = c.real?.engine ?? (c.action?.input?.engine as string | undefined)
  return engine === 'opencode' && platform === 'win32' ? 'powershell' : 'posix'
}

/**
 * The scope a real case is measured with (ruling 11): the production builder,
 * fed the temp dirs captured with the case and the route's workdir rule. A
 * built-in case keeps its synthetic darwin scope, and a `--root` checkout
 * without the builder keeps the scope this runner always built.
 */
function replayScopeFor(c: LoadedCase, platform: string, cwd: string): Record<string, unknown> {
  const shell = shellForCase(c, platform)
  if (!c.real) {
    // Synthetic defaults for the built-in set, as before.
    return {
      cwd,
      tempDirs: groundTruth.tempDirRoots({ TMPDIR: '/var/folders/x1/abc/T/' }, platform),
      additionalDirectories: c.environment?.additionalDirectories,
      shell
    }
  }
  const facts: ReplayScopeFacts = {
    cwd,
    input: c.action.input,
    route: c.real.route,
    engine: c.real.engine,
    tempDirs: c.real.tempDirs,
    additionalDirectories: c.environment?.additionalDirectories,
    platform,
    shell
  }
  const build = actionMetaMod?.redirectScopeFor
  if (build) return { ...replayRedirectScope(facts, build) }
  // Pre-P2a-2 checkout: no builder, no tempVars/shellCwd, and its older
  // `tempDirRoots` ignored the platform argument — measure its own way.
  return {
    ...legacyReplayScope(
      facts,
      c.real.tempDirs ?? groundTruth.tempDirRoots({ TMPDIR: '/var/folders/x1/abc/T/' }, platform)
    )
  }
}

/**
 * What the fake probe needs to tell a redirect target from its ancestors: the
 * case's out-of-scope targets, from the checkout's own pure analysis (the same
 * call `captureRedirects` makes first). A checkout without `redirectTargetDetails`
 * gets no targets, so the probe keeps its conservative "not measured" answer.
 */
function probeTargetsFor(
  command: string,
  scope: Record<string, unknown>,
  platform: string
): { outOfScope: string[] } | undefined {
  const details = groundTruth.redirectTargetDetails as
    | ((
        command: string,
        scope: unknown,
        platform: string
      ) => { path?: string; root?: string }[] | null)
    | undefined
  if (typeof details !== 'function') return undefined
  return { outOfScope: outOfScopeTargets(details(command, scope, platform)) }
}

/**
 * The `{"meta":…}` line. Real cases measure with the `--root` checkout's own
 * ground truth and the temp roots captured at extraction; a label's
 * `actionMetaOverride` is shallow-merged on top, for historical facts the
 * orchestrator establishes later (e.g. a redirect target did not exist then).
 *
 * When the checkout exports `captureRedirects` AND the case has fs facts, the
 * measured facts are used (`exists`/`empty`/`modifiedSinceSessionStart`/
 * `symlinked`). Otherwise — baseline checkout, or no facts for this case — the
 * pure scope analysis is used, so nothing is ever measured against THIS host.
 */
async function actionMetaFor(
  c: LoadedCase,
  override: Record<string, unknown> | undefined
): Promise<Record<string, unknown> | undefined> {
  const platform = c.environment?.platform ?? environment.platform
  const cwd = c.environment?.cwd ?? environment.cwd
  let computed: Record<string, unknown> | undefined
  if (c.measureRedirects) {
    const scope = replayScopeFor(c, platform, cwd)
    const facts = c.fsFacts ?? fsFacts?.[c.id]
    const capture = measureMod?.captureRedirects
    const redirects =
      facts && capture
        ? await capture(c.measureRedirects, scope, {
            sessionStartMs: facts.sessionStartMs,
            platform,
            probe: fsFactsProbe(facts, probeTargetsFor(c.measureRedirects, scope, platform)),
            timeoutMs: 400
          })
        : groundTruth.analyzeRedirects(c.measureRedirects, scope, platform)
    computed = redirects ? { redirects } : undefined
  }
  if (!override) return computed
  return { ...(computed ?? {}), ...override }
}

async function runOnce(
  c: LoadedCase,
  override: Record<string, unknown> | undefined,
  transport: JudgeTransport = judge
): Promise<EvalResult> {
  const actionMeta = await actionMetaFor(c, override)
  let calls = 0
  const counted: JudgeTransport = (req) => {
    calls++
    return transport(req)
  }
  const started = performance.now()
  const result = await classifier.classify(
    {
      messages: transcriptFor(c),
      action: c.action,
      environment: environmentFor(c),
      ...(c.outcomes ? { outcomes: c.outcomes } : {}),
      ...(actionMeta ? { actionMeta } : {})
    },
    counted
  )
  const durationMs = Math.round(performance.now() - started)
  return normalizeResult({
    block: result.block,
    stage: result.stage,
    ...(result.category ? { category: result.category } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.raw !== undefined ? { raw: result.raw } : {}),
    ...(result.unavailable ? { unavailable: true } : {}),
    // A stage-2 confirmation that overturned a block is a historical fact the
    // replay report must keep (a false block this change fixed shows up here).
    ...(result.overturnedBlock ? { overturnedBlock: result.overturnedBlock } : {}),
    // A stage-1 escalation (off-format / over budget) is why stage 2 decided: kept so a replay
    // report shows the escalation rate this change trades for the banner.
    ...(result.stage1Unusable ? { stage1Unusable: result.stage1Unusable } : {}),
    durationMs,
    calls
  })
}

/** Bounded-concurrency map, results in input order. */
async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    })
  )
  return out
}

const runs = Number(args.runs)
const concurrency = Number(args.concurrency)
if (
  !Number.isSafeInteger(runs) ||
  runs < 1 ||
  !Number.isSafeInteger(concurrency) ||
  concurrency < 1
) {
  fail('runs and concurrency must be positive integers')
}
const labels = args.labels ? loadLabels(args.labels) : undefined
// Built-in behaviour is unchanged: without a cases file or a labels file a
// case answers to the `expect` it was written with. Only a replay uses labels,
// where a case with no entry is UNLABELLED.
const useLabels = args['cases-file'] !== undefined || labels !== undefined
const wanted = args.case?.length ? new Set(args.case) : null
const cases: LoadedCase[] = (
  args['cases-file']
    ? loadCasesFile(args['cases-file'])
    : [...CASES, ...DELEGATED_CASES, ...BASH_CASES, ...SOURCE_CASES, ...HISTORY_CASES, ...P2C_CASES]
).filter((c) => !wanted || wanted.has(c.id))
if (cases.length === 0) fail('no cases selected')
const dryRun = args['dry-run-sizes'] === true
const dumpFile = args['dump-requests']
// The dump is a by-product of the fake fetch; a real run would ALSO send the text,
// so the flag is refused rather than silently writing nothing (or doing both).
if (dumpFile !== undefined && !dryRun) fail('--dump-requests needs --dry-run-sizes')
if (dumpFile !== undefined && dumpFile.trim() === '') fail('--dump-requests needs a file path')
const routeUrl = args['route-url']
const routeKey = args['route-key']!
const requestedAccount = args['chatgpt-account']
if (routeUrl !== undefined) {
  let parsed: URL | undefined
  try {
    parsed = new URL(routeUrl)
  } catch {
    parsed = undefined
  }
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:'))
    fail('--route-url must be an http(s) base URL')
  if (!routeKey) fail('--route-key must not be empty')
  if (requestedAccount !== undefined)
    fail('--chatgpt-account has no effect with --route-url (no ChatGPT route is used)')
}
// Extra headers and a larger reasoning budget for the hand-built route. A header value can
// be a secret, so a bad entry is reported by position or name only.
let routeHeaders: Record<string, string> = {}
let routeHeadroom: number | undefined
try {
  routeHeaders = parseRouteHeaders(args['route-header'] ?? [])
  if (args['route-headroom'] !== undefined)
    routeHeadroom = parseRouteHeadroom(args['route-headroom'])
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
if (routeUrl === undefined && (Object.keys(routeHeaders).length > 0 || routeHeadroom !== undefined))
  fail('--route-header and --route-headroom need --route-url')

// `--openrouter-key-file`: one key for every OpenRouter call of this run, read once. The model
// must name the OpenRouter provider, because the injected key answers for whichever definition
// owns the model (see `openRouterKeyDeps`).
const openRouterKeyFile = args['openrouter-key-file']
let routeDeps: ReturnType<typeof openRouterKeyDeps> | undefined
if (openRouterKeyFile !== undefined) {
  if (routeUrl !== undefined) fail('--openrouter-key-file has no effect with --route-url')
  if (!args.model!.startsWith('openrouter/') || args.model!.length <= 'openrouter/'.length)
    fail('--openrouter-key-file needs --model openrouter/<vendor>/<model>')
  try {
    routeDeps = openRouterKeyDeps(readKeyFile(openRouterKeyFile))
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
}

// A request that goes to a third party is masked and scanned first (`./request-guard`).
// Both default ON for every route except the owner's ChatGPT subscription (the production
// judge, which already receives this data); a dry run honours the same default, so the dump
// shows the text that would go out. The route is read from the resolver's token-free
// `describeJudgeRoute` (its `chatgpt` flag): a model the resolver cannot place, or a check
// that fails, counts as a third party, so masking is the safe default.
async function describeRoute(): Promise<{ chatgpt?: true } | undefined> {
  if (routeUrl !== undefined) return undefined
  try {
    return await describeJudgeRoute(args.engine as JudgeEngine, args.model!, routeDeps)
  } catch {
    return undefined
  }
}
let policy: ReturnType<typeof guardPolicy>
try {
  policy = guardPolicy({
    customRoute: routeUrl !== undefined,
    described: await describeRoute(),
    ...(args['mask-identity'] === true ? { mask: true } : {}),
    ...(args['no-mask-identity'] === true ? { noMask: true } : {})
  })
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
const { thirdParty, maskIdentity, scanCredentials } = policy
function readIdentityInputs(): IdentityInputs {
  let username: string | undefined
  try {
    username = userInfo().username
  } catch {
    username = undefined
  }
  const git = (...gitArgs: string[]): string => {
    const out = spawnSync('git', ['-C', root, ...gitArgs], { encoding: 'utf-8' })
    return out.status === 0 ? out.stdout : ''
  }
  return {
    username,
    userProfile: process.env.USERPROFILE,
    remotes: git('remote', '-v'),
    gitEmail: git('config', 'user.email').trim(),
    gitName: git('config', 'user.name').trim()
  }
}
const identity = maskIdentity ? identityMasks(readIdentityInputs()) : []
if (maskIdentity && identity.length === 0)
  console.error('judge-eval: warning: no identity handle could be derived, nothing is masked')
if (thirdParty && !maskIdentity)
  console.error('judge-eval: warning: identity masking is OFF on a third-party route')
let withheld = 0
/** `inner` behind the mask and the credential deny-list (a no-op when neither applies). */
function guarded(inner: JudgeTransport): JudgeTransport {
  return guardTransport(inner, {
    ...(maskIdentity ? { mask: makeIdentityMasker(identity) } : {}),
    scan: scanCredentials,
    onWithheld: () => {
      withheld++
    }
  })
}
const guardNote = `${maskIdentity ? `, identity masking on (${identity.length} handle${identity.length === 1 ? '' : 's'})` : ''}${scanCredentials ? ', credential scan on' : ''}`
const withheldLine = (): string =>
  `withheld requests: ${withheld} (matched a credential pattern, not sent)`
// `--chatgpt-account` names a vault account (accounts.chatgpt.list[].id). An id the
// vault does not hold stops the run here rather than surfacing as a judge error
// on every call. The header shows the id and plan, never the email.
let accountHeader = ''
if (requestedAccount !== undefined) {
  const accounts = await authVault.listAccounts(CHATGPT_PROVIDER_ID)
  const found = pickChatgptAccount(accounts, null, requestedAccount)
  if (!found)
    fail(
      `no ChatGPT vault account with id "${requestedAccount}" (vault accounts: ${accounts.map((a) => a.id).join(', ') || 'none'})`
    )
  accountHeader = `, ${accountNote(found)}`
}
// Eval-only: read the chosen (else active), unexpired credential without refresh or
// vault writes. A forced retry cannot refresh either; a stale token becomes a
// reported error.
async function readOnlyChatgptToken(force: boolean): Promise<CodexInjectionToken | null> {
  if (force) return null
  const activeId =
    requestedAccount === undefined ? await authVault.getActiveAccountId(CHATGPT_PROVIDER_ID) : null
  const account = pickChatgptAccount(
    await authVault.listAccounts(CHATGPT_PROVIDER_ID),
    activeId,
    requestedAccount
  )
  return account ? readOnlyTokenOf(account, Date.now()) : null
}

/**
 * Where a judge call goes. `--route-url` hands in a hand-built `custom-chat`
 * route; a dry run never resolves anything (no vault, no catalog): it routes to
 * an unreachable `.invalid` host that the fake fetch below never contacts.
 */
const DRY_RUN_BASE_URL = 'https://dry-run.invalid/v1'
function routeOverride(): ReturnType<typeof buildCustomRoute> | undefined {
  if (routeUrl !== undefined)
    return buildCustomRoute({
      model: args.model!,
      baseUrl: routeUrl,
      key: routeKey,
      headers: routeHeaders,
      ...(routeHeadroom !== undefined ? { headroom: routeHeadroom } : {})
    })
  if (dryRun)
    return buildCustomRoute({ model: args.model!, baseUrl: DRY_RUN_BASE_URL, key: 'dry-run' })
  return undefined
}

const judge: JudgeTransport = guarded(
  makeHttpJudgeTransport({
    resolve: async () => {
      const override = routeOverride()
      if (override) return { ok: true, route: override }
      const resolved = await resolveJudgeRoute(args.engine as JudgeEngine, args.model!, {
        chatgptToken: readOnlyChatgptToken,
        ...routeDeps
      })
      // The injected key must only ever pay an OpenRouter route; anything else means the
      // model landed on another definition (e.g. a custom endpoint) and the key went there.
      if (routeDeps && resolved.ok && resolved.route.kind !== 'openrouter')
        fail(`--model ${args.model} resolved to a ${resolved.route.kind} route, not OpenRouter`)
      // Eval-only knob: measure an OpenRouter judge with stage-2 reasoning off too.
      if (
        args['judge-reasoning'] === 'off' &&
        resolved.ok &&
        resolved.route.kind === 'openrouter'
      ) {
        const off = { reasoning: { enabled: false } }
        return {
          ...resolved,
          route: {
            ...resolved.route,
            caps: { ...resolved.route.caps, reasoning: { fast: off, thinking: off } }
          }
        }
      }
      return resolved
    },
    userAgent: 'ClaudeUI-judge-eval'
  })
)
const jobs = cases.flatMap((c) => Array.from({ length: runs }, () => c))

console.log(
  `judge-eval: ${cases.length} cases × ${dryRun ? 1 : runs} runs, model ${args.model} (${args.engine})${routeUrl !== undefined ? `, route ${routeOverride()!.label}` : ''}${accountHeader}${openRouterKeyFile !== undefined ? ', openrouter key: file' : ''}${guardNote}, root ${root}${hasTimeOrder ? '' : ' [pre-ADR-091 transcript order]'}${args['cases-file'] ? `, cases ${args['cases-file']}` : ''}${dryRun ? ' [DRY RUN: sizes only, nothing is sent]' : ''}`
)

/**
 * `--dry-run-sizes`: classify every case through the real HTTP transport (route
 * body builder included) with a fetch that NEVER sends: it answers each request
 * from memory. The fake reply `<block>no</block>` is no stage-1 severity grade, so
 * `classify()` escalates, and it is a stage-2 allow — one pass therefore builds
 * BOTH stages' requests (a `requiresFullReview` case skips stage 1). The size of
 * a case is its largest request: system + user prompt characters, which is what
 * a context window must hold (the response and reasoning budget come on top).
 */
async function dryRunSizes(): Promise<number> {
  const fakeFetch = (async () =>
    new Response(
      'data: {"choices":[{"delta":{"content":"<block>no</block>"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    )) as unknown as typeof fetch
  const rows = await pool(cases, concurrency, async (c) => {
    const sizes: number[] = []
    const dumped: string[] = []
    const inner = makeHttpJudgeTransport({
      resolve: async () => ({ ok: true as const, route: routeOverride()! }),
      fetchImpl: fakeFetch,
      userAgent: 'ClaudeUI-judge-eval'
    })
    // Behind the guard: it records the request as it would go out (masked), and never
    // one the credential scan withheld.
    const recording: JudgeTransport = (req) => {
      sizes.push(req.system.length + req.user.length)
      if (dumpFile !== undefined) dumped.push(requestDumpLine(c.id, req))
      return inner(req)
    }
    let error: string | undefined
    try {
      const r = await runOnce(c, labels?.[c.id]?.actionMetaOverride, guarded(recording))
      if (r.error) error = r.error
    } catch (err) {
      error = String(err)
    }
    return { id: c.id, title: c.title, sizes, dumped, chars: Math.max(0, ...sizes), error }
  })
  if (dumpFile !== undefined) {
    // Case order, then request order: the pool finishes cases out of order.
    const lines = rows.flatMap((row) => row.dumped)
    mkdirSync(dirname(resolve(dumpFile)), { recursive: true })
    writeFileSync(resolve(dumpFile), lines.map((line) => line + '\n').join(''))
    console.log(`dumped ${lines.length} request(s) to ${dumpFile}`)
  }
  let errors = 0
  for (const row of rows) {
    if (row.error || row.sizes.length === 0) {
      errors++
      console.log(`ERROR ${row.id.padEnd(4)} ${row.error ?? 'no judge request was built'}`)
      continue
    }
    console.log(
      `${row.id.padEnd(5)} ${String(row.chars).padStart(8)} chars  ~${String(estimateTokens(row.chars)).padStart(6)} tok  (${row.sizes.length} request${row.sizes.length === 1 ? '' : 's'})  ${row.title}`
    )
  }
  const sized = rows.filter((row) => !row.error && row.sizes.length > 0)
  const summary = summarizeSizes(
    sized.map((row) => row.chars),
    [150_000, 190_000]
  )
  const biggest = sized.reduce((a, b) => (b.chars > a.chars ? b : a), sized[0])
  console.log(
    `\nsizes over ${summary.count} cases (system + user prompt, est. tokens = chars/4):` +
      `\n  max ${summary.maxTokens} tok (${summary.maxChars} chars)${biggest ? `, case ${biggest.id}` : ''}` +
      `\n  median ${summary.medianTokens} tok` +
      `\n  over 150k tok: ${summary.over[150_000]}` +
      `\n  over 190k tok: ${summary.over[190_000]}` +
      (errors ? `\n  ${errors} case(s) built no request (see ERROR lines)` : '') +
      (scanCredentials ? `\n  ${withheldLine()}` : '')
  )
  return errors > 0 ? 1 : 0
}
if (dryRun) process.exit(await dryRunSizes())

const results = await pool(jobs, concurrency, async (c) => {
  try {
    return { id: c.id, r: await runOnce(c, labels?.[c.id]?.actionMetaOverride) }
  } catch (err) {
    return { id: c.id, r: { block: true, stage: 'error', error: String(err) } as EvalResult }
  }
})

const evaluated = cases.map((c) => {
  const expected: Expectation | null = useLabels
    ? expectedFor(labels?.[c.id])
    : {
        expect: c.expect,
        ...(c.expectCategories ? { expectCategories: c.expectCategories } : {})
      }
  const mine = results.filter((x) => x.id === c.id).map((x) => x.r)
  const score = scoreCase(expected, mine)
  return {
    score,
    row: {
      id: c.id,
      title: c.title,
      expect: expected?.expect ?? c.expect,
      // A label without categories means "any": never fall back to the case's list.
      expectCategories: expected ? expected.expectCategories : c.expectCategories,
      verdicts: mine.map((r) => (r.error ? 'err' : r.block ? 'block' : 'allow')),
      pass: score.pass,
      runs: mine,
      ...(c.real ? { real: c.real } : {})
    }
  }
})

let failed = 0
let unlabelled = 0
for (const { score, row } of evaluated) {
  if (score.unlabelled) {
    unlabelled++
    console.log(
      `UNLABELLED ${row.id.padEnd(4)} got [${row.runs.map((r) => `${r.error ? 'err' : r.block ? 'block' : 'allow'}:${r.category ?? '-'}`).join(', ')}]  ${row.title}`
    )
  } else {
    const ok = score.pass === score.total
    if (!ok) failed++
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${row.id.padEnd(4)} expect ${row.expect.padEnd(5)} categories [${row.expectCategories?.join(', ') ?? 'any'}] got [${row.runs.map((r) => `${r.error ? 'err' : r.block ? 'block' : 'allow'}:${r.category ?? '-'}`).join(', ')}]  ${row.title}`
    )
  }
  for (const r of row.runs) {
    if (r.error) console.log(`        error @${r.stage}: ${r.error}`)
    else if (r.block) console.log(`        ${r.category ?? '-'} @${r.stage}: ${r.reason ?? ''}`)
  }
}
const labelled = evaluated.length - unlabelled
console.log(
  `\n${labelled - failed}/${labelled} labelled cases matched intent on every run${unlabelled ? ` (${unlabelled} unlabelled)` : ''}`
)
// Every run of this invocation whose stage-2 confirmation overturned a block.
console.log(`overturned blocks: ${results.filter((x) => x.r.overturnedBlock).length}`)
if (scanCredentials) console.log(withheldLine())
{
  // Decision latency (all judge calls of one decision), for comparing judge models.
  const ms = results.map((x) => x.r.durationMs ?? 0).sort((a, b) => a - b)
  const at = (q: number): number => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] ?? 0
  const calls = results.reduce((n, x) => n + (x.r.calls ?? 0), 0)
  console.log(
    `latency ms: p50 ${at(0.5)} p90 ${at(0.9)} max ${ms[ms.length - 1] ?? 0}; judge calls ${calls} for ${ms.length} decisions`
  )
}
if (args.json)
  writeFileSync(
    args.json,
    JSON.stringify(
      evaluated.map((e) => e.row),
      null,
      2
    )
  )
if (failed > 0) process.exitCode = 1
