/**
 * Replay the auto-mode judge cases (./cases.ts) against a LIVE judge model and
 * report each verdict against the policy's intent (ADR-091).
 *
 *   bun scripts/judge-eval/run.ts [--runs 3] [--model openai-codex/gpt-6-luna]
 *     [--engine pi] [--case '#4'] [--root <repo checkout>] [--json <out>]
 *     [--cases-file <cases.json> [--labels <labels.json>]]
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
 * Every run costs real judge calls (stage 1, plus stage 2 when stage 1 blocks).
 */
import { parseArgs } from 'node:util'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { makeHttpJudgeTransport } from '../../src/core/automode/judge-http/transport'
import { resolveJudgeRoute, type JudgeEngine } from '../../src/core/automode/judge-route'
import { authVault, CHATGPT_PROVIDER_ID } from '../../src/core/auth/vault/AuthVault'
import type { CodexInjectionToken } from '../../src/core/auth/vault/CredentialSync'
import type { ChatMessage } from '../../src/shared/types'
import {
  BASH_CASES,
  CASES,
  CWD,
  DELEGATED_CASES,
  HISTORY_CASES,
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

const { values: args } = parseArgs({
  options: {
    runs: { type: 'string', default: '3' },
    model: { type: 'string', default: 'openai-codex/gpt-6-luna' },
    engine: { type: 'string', default: 'pi' },
    case: { type: 'string', multiple: true },
    root: { type: 'string', default: resolve(import.meta.dir, '../..') },
    json: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
    'cases-file': { type: 'string' },
    labels: { type: 'string' }
  }
})

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

const root = resolve(args.root!)
const classifier = await import(`${root}/src/core/automode/classifier.ts`)
const groundTruth = await import(`${root}/src/core/automode/ground-truth.ts`)
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
 * The `{"meta":…}` line. Real cases measure with the `--root` checkout's own
 * ground truth and the temp roots captured at extraction; a label's
 * `actionMetaOverride` is shallow-merged on top, for historical facts the
 * orchestrator establishes later (e.g. a redirect target did not exist then).
 */
function actionMetaFor(
  c: LoadedCase,
  override: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const platform = c.environment?.platform ?? environment.platform
  const cwd = c.environment?.cwd ?? environment.cwd
  let computed: Record<string, unknown> | undefined
  if (c.measureRedirects) {
    // A pre-ADR-091 tempDirRoots takes no platform and ignores the argument.
    const tempDirs =
      c.real?.tempDirs ?? groundTruth.tempDirRoots({ TMPDIR: '/var/folders/x1/abc/T/' }, platform)
    const redirects = groundTruth.analyzeRedirects(
      c.measureRedirects,
      { cwd, tempDirs, additionalDirectories: c.environment?.additionalDirectories },
      platform
    )
    computed = redirects ? { redirects } : undefined
  }
  if (!override) return computed
  return { ...(computed ?? {}), ...override }
}

async function runOnce(
  c: LoadedCase,
  override: Record<string, unknown> | undefined
): Promise<EvalResult> {
  const actionMeta = actionMetaFor(c, override)
  const result = await classifier.classify(
    {
      messages: transcriptFor(c),
      action: c.action,
      environment: environmentFor(c),
      ...(c.outcomes ? { outcomes: c.outcomes } : {}),
      ...(actionMeta ? { actionMeta } : {})
    },
    judge
  )
  return normalizeResult({
    block: result.block,
    stage: result.stage,
    ...(result.category ? { category: result.category } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.raw !== undefined ? { raw: result.raw } : {}),
    ...(result.unavailable ? { unavailable: true } : {})
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
    : [...CASES, ...DELEGATED_CASES, ...BASH_CASES, ...SOURCE_CASES, ...HISTORY_CASES]
).filter((c) => !wanted || wanted.has(c.id))
if (cases.length === 0) fail('no cases selected')
// Eval-only: read the active, unexpired credential without refresh or vault writes.
// A forced retry cannot refresh either; a stale token becomes a reported error.
async function readOnlyChatgptToken(force: boolean): Promise<CodexInjectionToken | null> {
  if (force) return null
  const activeId = await authVault.getActiveAccountId(CHATGPT_PROVIDER_ID)
  if (!activeId) return null
  const account = (await authVault.listAccounts(CHATGPT_PROVIDER_ID)).find(
    (item) => item.id === activeId
  )
  if (
    !account ||
    account.credential.type !== 'oauth' ||
    !account.accountId ||
    account.credential.expires <= Date.now()
  )
    return null
  return {
    accessToken: account.credential.access,
    chatgptAccountId: account.accountId,
    chatgptPlanType: account.planType ?? null,
    vaultAccountId: account.id
  }
}

const judge = makeHttpJudgeTransport({
  resolve: () =>
    resolveJudgeRoute(args.engine as JudgeEngine, args.model!, {
      chatgptToken: readOnlyChatgptToken
    }),
  userAgent: 'ClaudeUI-judge-eval'
})
const jobs = cases.flatMap((c) => Array.from({ length: runs }, () => c))

console.log(
  `judge-eval: ${cases.length} cases × ${runs} runs, model ${args.model} (${args.engine}), root ${root}${hasTimeOrder ? '' : ' [pre-ADR-091 transcript order]'}${args['cases-file'] ? `, cases ${args['cases-file']}` : ''}`
)
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
