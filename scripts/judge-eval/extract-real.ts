/** Offline replay extraction. Real histories are inspected with --dry-run during development. */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { convertPiSessionEntries } from '../../src/core/services/pi-session-list'
import { convertOpencodeHistory } from '../../src/core/opencode/history'
import { inTimeOrder, recordTrajectoryMessage } from '../../src/core/automode/trajectory'
import { buildClassifierEnvironment } from '../../src/core/automode/environment'
import { mergedClaudeRulesFor } from '../../src/core/pi/permission-engine'
import { DispatchTargetJudge } from '../../src/core/services/dispatch-target-judge'
import { restrictionNote } from '../../src/core/opencode/caller-restriction'
import { logger } from '../../src/core/services/logger'
import {
  analyzeRedirects,
  captureGitRemotes,
  recordToolOutcome,
  shellCommandOf,
  tempDirRoots
} from '../../src/core/automode/ground-truth'
import type { ChatMessage } from '../../src/shared/types'
import type { ToolOutcome } from '../../src/core/automode/ground-truth'
import type { EvalCase } from './cases'

type Row = Record<string, any>
type Route =
  'pi-root' | 'pi-child' | 'dispatch-pi' | 'dispatch-opencode' | 'opencode-root' | 'opencode-child'
const ROUTES: Route[] = [
  'pi-root',
  'pi-child',
  'dispatch-pi',
  'dispatch-opencode',
  'opencode-root',
  'opencode-child'
]
const DENY = 'Auto mode blocked:'
interface Source {
  engine: 'pi' | 'opencode'
  id: string
  file: string
  cwd: string
  rows: Row[]
  child?: boolean
  dispatchStore?: boolean
  parentId?: string
  dispatch?: Row
}
export interface ReplayCase extends EvalCase {
  real: {
    route: Route
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
}
export interface ExtractOptions {
  home?: string
  opencodeDb?: string
  include?: string[]
}

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['provider-key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}/g],
  ['github-token', /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{12,}/g],
  ['slack-token', /\bxox[bp]-[A-Za-z0-9-]{12,}/g],
  ['aws-key', /\bAKIA[A-Z0-9]{16}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g],
  [
    'private-key',
    /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g
  ],
  ['secret-assignment', /\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S{12,}/gi]
]

/** Screen keys as well as values: provenance and arbitrary tool inputs are untrusted strings too. */
export function redact<T>(value: T, counts: Record<string, number> = {}): T {
  if (typeof value === 'string') {
    let text = value
    for (const [kind, pattern] of SECRET_PATTERNS) {
      text = text.replace(pattern, () => {
        counts[kind] = (counts[kind] ?? 0) + 1
        return `[REDACTED:${kind}]`
      })
    }
    return text as T
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, counts)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [redact(k, counts), redact(v, counts)])
    ) as T
  }
  return value
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  return Array.isArray(content)
    ? content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
    : ''
}

function walk(root: string, extension: string): string[] {
  if (!existsSync(root) || lstatSync(root).isSymbolicLink()) return []
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.isSymbolicLink()) return []
      const file = join(root, entry.name)
      return entry.isDirectory()
        ? walk(file, extension)
        : entry.isFile() && file.endsWith(extension)
          ? [file]
          : []
    })
    .sort()
}

/** bun:sqlite is not resolvable by Vitest; Node's driver keeps fixture databases real SQLite. */
async function readSql(file: string, sql: string): Promise<Row[]> {
  if ((process.versions as Record<string, string>).bun) {
    const module = 'bun:sqlite'
    const { Database } = await import(/* @vite-ignore */ module)
    const db = new Database(file, { readonly: true })
    try {
      db.exec('PRAGMA query_only = ON')
      return db.query(sql).all()
    } finally {
      db.close()
    }
  }
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    db.exec('PRAGMA query_only = ON')
    return db.prepare(sql).all()
  } finally {
    db.close()
  }
}

function piRows(file: string): Row[] {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .flatMap((line, index) => (line.trim() ? [{ ...JSON.parse(line), line: index + 1 }] : []))
}

export function piBranch(rows: Row[], leafId?: string, at = Infinity): Row[] {
  const eligible = rows.filter((r) => r.id && r.type !== 'session' && Date.parse(r.timestamp) <= at)
  const byId = new Map(eligible.map((r) => [r.id, r]))
  const branch: Row[] = []
  const seen = new Set<string>()
  let leaf = leafId ? byId.get(leafId) : eligible.at(-1)
  while (leaf && !seen.has(leaf.id)) {
    seen.add(leaf.id)
    branch.push(leaf)
    leaf = byId.get(leaf.parentId)
  }
  return branch.reverse()
}

export function piMessages(rows: Row[]): ChatMessage[] {
  const clean = rows.map((row) => {
    if (!Array.isArray(row.message?.content)) return row
    return {
      ...row,
      message: {
        ...row.message,
        content: row.message.content.filter((b: Row) => b.type !== 'image')
      }
    }
  })
  return convertPiSessionEntries(clean as Parameters<typeof convertPiSessionEntries>[0])
}

function outcomes(messages: ChatMessage[], current: string): Record<string, ToolOutcome> {
  const out = new Map<string, ToolOutcome>()
  for (const message of messages)
    for (const block of message.content) {
      if (block.type !== 'tool_result' || block.toolUseId === current) continue
      const text = typeof block.toolResult === 'string' ? block.toolResult : ''
      recordToolOutcome(
        out,
        block.toolUseId,
        block.isError && text.startsWith(DENY) ? 'automode-blocked' : block.isError ? 'error' : 'ok'
      )
    }
  return Object.fromEntries(out)
}

function ocMessages(rows: Row[]): ChatMessage[] {
  // The history converter can persist image blobs. Remove image attachments before conversion.
  const clean = rows.map((row) => {
    const copy = structuredClone(row)
    delete copy.files
    if (Array.isArray(copy.content))
      copy.content = copy.content
        .filter((p: Row) => p.type !== 'image')
        .map((p: Row) => {
          if (Array.isArray(p.state?.content))
            p.state.content = p.state.content.filter(
              (b: Row) => b.type !== 'image' && b.type !== 'file'
            )
          if (typeof p.state?.error === 'string')
            p.state.error = { type: 'legacy', message: p.state.error }
          return p
        })
    return copy
  })
  return convertOpencodeHistory(clean as Parameters<typeof convertOpencodeHistory>[0]).messages
}

function subagent(input: Row): NonNullable<EvalCase['action']['subagent']> {
  return {
    type: input.subagent_type ?? 'general-purpose',
    ...(typeof input.description === 'string' ? { description: input.description } : {}),
    ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {})
  }
}

export async function extractReal(options: ExtractOptions = {}) {
  // Production readers can log malformed source rows. No source strings may reach logs or stdout.
  const saved = { debug: logger.debug, info: logger.info, warn: logger.warn, error: logger.error }
  for (const key of ['debug', 'info', 'warn', 'error'] as const) logger[key] = () => {}
  try {
    return await extractSources(options)
  } finally {
    Object.assign(logger, saved)
  }
}

async function extractSources(options: ExtractOptions) {
  const home = options.home ?? homedir()
  const stats = Object.fromEntries(
    ROUTES.map((r) => [r, { denies: 0, built: 0, skipped: {} as Record<string, number> }])
  ) as Record<Route, { denies: number; built: number; skipped: Record<string, number> }>
  const sources: Source[] = []
  const discovery: Record<string, number> = {}
  const failed = (reason: string) => {
    discovery[reason] = (discovery[reason] ?? 0) + 1
  }
  for (const [root, child] of [
    [join(home, '.pi/agent/sessions'), false],
    [join(home, '.claude/ui/pi-subagents'), true],
    [join(home, '.claude/ui/dispatch/pi'), false]
  ] as const) {
    for (const file of walk(root, '.jsonl')) {
      try {
        const rows = piRows(file)
        const header = rows.find((r) => r.type === 'session')
        if (!header?.id || !header.cwd) {
          failed('pi-header-missing')
          continue
        }
        sources.push({
          engine: 'pi',
          id: header.id,
          cwd: header.cwd,
          rows,
          file,
          child,
          dispatchStore: root === join(home, '.claude/ui/dispatch/pi')
        })
      } catch {
        failed('pi-history-unreadable')
      }
    }
  }
  const ocDb =
    options.opencodeDb ??
    join(process.env.XDG_DATA_HOME ?? join(home, '.local/share'), 'opencode/opencode.db')
  if (existsSync(ocDb)) {
    try {
      const rows = await readSql(
        ocDb,
        'SELECT m.id, m.type, m.session_id, m.seq, m.time_created, m.data, s.directory, s.parent_id FROM session_message m JOIN session_v2 s ON s.id = m.session_id ORDER BY m.time_created, m.seq'
      )
      const grouped = new Map<string, Source>()
      for (const row of rows) {
        let source = grouped.get(row.session_id)
        if (!source) {
          source = {
            engine: 'opencode',
            id: row.session_id,
            file: ocDb,
            cwd: row.directory,
            parentId: row.parent_id ?? undefined,
            rows: []
          }
          grouped.set(source.id, source)
        }
        source.rows.push({
          ...JSON.parse(row.data),
          type: row.type,
          id: row.id,
          seq: row.seq,
          storedTime: row.time_created
        })
      }
      sources.push(...grouped.values())
    } catch {
      failed('opencode-db-unreadable')
    }
  }
  const ledgerDb = join(home, '.claude/ui/operational.db')
  if (existsSync(ledgerDb)) {
    try {
      const ledger = await readSql(
        ledgerDb,
        'SELECT id, engine, parent_session_id, parent_engine, parent_tool_use_id, harness_ref, model, caller_restriction FROM dispatch_target'
      )
      for (const source of sources)
        source.dispatch = ledger.find(
          (r) => r.harness_ref === source.id && r.engine === source.engine
        )
    } catch {
      failed('dispatch-ledger-unreadable')
    }
  }
  const sharedFile = join(home, '.claude/ui/automode.json')
  let shared: Row = {}
  if (existsSync(sharedFile)) {
    try {
      shared = JSON.parse(readFileSync(sharedFile, 'utf8'))
    } catch {
      failed('automode-settings-unreadable')
      return { cases: [] as ReplayCase[], stats, discovery }
    }
  }
  const cases: ReplayCase[] = []
  const included = new Set(options.include ?? [])
  const foundIncludes = new Set<string>()
  const environmentCache = new Map<string, Awaited<ReturnType<typeof buildEnvironment>>>()
  async function buildEnvironment(cwd: string, dispatch?: Row) {
    const permissions = mergedClaudeRulesFor(cwd)
    if (dispatch) {
      permissions.allow = []
      permissions.additionalDirectories = []
      const restriction = dispatch.caller_restriction
        ? JSON.parse(dispatch.caller_restriction)
        : undefined
      permissions.deny.push(...(restriction?.deny ?? []))
      permissions.ask.push(...(restriction?.ask ?? []))
    }
    return buildClassifierEnvironment({
      cwd,
      platform: process.platform,
      permissions,
      shared,
      remotes: await captureGitRemotes(cwd),
      repoVisibility: undefined
    })
  }
  function prefix(source: Source, at: number): ChatMessage[] {
    return source.engine === 'pi'
      ? piMessages(piBranch(source.rows, undefined, at))
      : ocMessages(source.rows.filter((r) => (r.time?.created ?? r.storedTime) <= at))
  }
  for (const source of sources) {
    const route: Route =
      source.dispatch || source.dispatchStore
        ? source.engine === 'pi'
          ? 'dispatch-pi'
          : 'dispatch-opencode'
        : source.engine === 'pi'
          ? source.child
            ? 'pi-child'
            : 'pi-root'
          : source.parentId
            ? 'opencode-child'
            : 'opencode-root'
    const decisions: Array<{
      callId: string
      toolName: string
      input: Row
      row: Row
      part: Row
      timestamp: number
      reason: string
      denied: boolean
    }> = []
    for (const row of source.rows) {
      if (source.engine === 'pi' && row.message?.role === 'assistant') {
        for (const part of row.message.content ?? []) {
          if (part.type !== 'toolCall') continue
          const result = source.rows.find(
            (r) => r.message?.role === 'toolResult' && r.message.toolCallId === part.id
          )
          const reason = textOf(result?.message.content)
          const denied = result?.message.isError === true && reason.startsWith(DENY)
          decisions.push({
            callId: part.id,
            toolName: part.name,
            input: part.arguments ?? {},
            row,
            part,
            timestamp: Date.parse(row.timestamp),
            reason,
            denied
          })
        }
      } else if (source.engine === 'opencode' && row.type === 'assistant') {
        for (const part of row.content ?? []) {
          if (part.type !== 'tool') continue
          const error = part.state?.error
          const reason = typeof error === 'string' ? error : (error?.message ?? '')
          decisions.push({
            callId: part.id,
            toolName: part.name,
            input: part.state?.input ?? {},
            row,
            part,
            timestamp: part.time?.created ?? row.time?.created ?? row.storedTime,
            reason,
            denied: part.state?.status === 'error' && reason.startsWith(DENY)
          })
        }
      }
    }
    decisions.sort((a, b) => a.timestamp - b.timestamp || a.callId.localeCompare(b.callId))
    for (const [index, decision] of decisions.entries()) {
      const includeId = `${source.engine}:${source.id}:${decision.callId}`
      const named = included.has(includeId)
      if (!decision.denied && !named) continue
      if (named) foundIncludes.add(includeId)
      if (decision.denied) stats[route].denies++
      const skip = (reason: string) => {
        stats[route].skipped[reason] = (stats[route].skipped[reason] ?? 0) + 1
      }
      if (source.dispatchStore && !source.dispatch) {
        skip('dispatch-ledger-link-missing')
        continue
      }
      if (
        named &&
        !decision.denied &&
        (source.engine === 'pi'
          ? !source.rows.some(
              (r) =>
                r.message?.role === 'toolResult' &&
                r.message.toolCallId === decision.callId &&
                !r.message.isError
            )
          : decision.part.state.status !== 'completed')
      ) {
        skip('included-call-not-confirmed-allowed')
        continue
      }
      try {
        const fidelity = [
          'settings as of today',
          'queued user turns and live grants unavailable',
          'original actionMeta unavailable; redirects remeasured at replay',
          'historical repo visibility unavailable',
          'images omitted',
          'stored timestamps bound live mapper timing approximately'
        ]
        const ownRows =
          source.engine === 'pi'
            ? piBranch(source.rows, decision.row.id)
            : source.rows
                .filter((r) => r.seq <= decision.row.seq)
                .map((r) => {
                  if (r.id !== decision.row.id) return r
                  const content = r.content
                    .slice(0, r.content.indexOf(decision.part) + 1)
                    .map((p: Row) =>
                      p.id === decision.callId
                        ? { ...p, state: { status: 'running', input: decision.input } }
                        : p
                    )
                  return { ...r, content }
                })
        let messages = source.engine === 'pi' ? piMessages(ownRows) : ocMessages(ownRows)
        let outcomeMessages = messages
        let environmentSource = source
        const action: EvalCase['action'] = { toolName: decision.toolName, input: decision.input }
        if (source.child && !source.dispatch) {
          const parent = sources.find(
            (s) =>
              s.engine === 'pi' &&
              s.rows.some((r) => r.message?.details?.cuiAgent?.agentId === source.id)
          )
          if (!parent) {
            skip('pi-child-root-link-missing')
            continue
          }
          environmentSource = parent
          const result = parent.rows.find(
            (r) => r.message?.details?.cuiAgent?.agentId === source.id
          )!
          const launch = parent.rows
            .flatMap((r) => (r.message?.role === 'assistant' ? r.message.content : []))
            .find((p: Row) => p.id === result.message.toolCallId)
          if (!launch) {
            skip('pi-child-launch-missing')
            continue
          }
          const trajectory = new Map<string, ChatMessage>()
          for (const message of messages) recordTrajectoryMessage(trajectory, message)
          messages = inTimeOrder(prefix(parent, decision.timestamp), [], trajectory.values())
          action.subagent = subagent(launch.arguments)
          fidelity.push('root linkage recovered from persisted launch result')
        } else if (source.dispatch) {
          const parent = sources.find(
            (s) =>
              s.engine === source.dispatch!.parent_engine &&
              s.id === source.dispatch!.parent_session_id
          )
          let parentMessages: ChatMessage[]
          if (parent) parentMessages = prefix(parent, decision.timestamp)
          else if (source.dispatch.parent_engine === 'claude') {
            // The production loader owns Claude transcript semantics; never duplicate its parser.
            const files = walk(join(home, '.claude/projects'), '.jsonl').filter(
              (f) => basename(f) === `${source.dispatch!.parent_session_id}.jsonl`
            )
            if (files.length !== 1 || home !== homedir()) {
              skip('claude-parent-history-unavailable')
              continue
            }
            const { loadSessionHistory } = await import('../../src/core/services/session-history')
            const anchor = piRows(files[0]).findLast(
              (r) => r.uuid && Date.parse(r.timestamp) <= decision.timestamp
            )?.uuid
            if (!anchor) {
              skip('claude-parent-timestamp-anchor-unavailable')
              continue
            }
            parentMessages = (
              await loadSessionHistory(
                source.dispatch.parent_session_id,
                basename(dirname(files[0])),
                anchor,
                { deferStatusLine: true }
              )
            ).messages.filter((m) => m.timestamp <= decision.timestamp)
            parentMessages = parentMessages.map((m) => ({
              ...m,
              content: m.content
                .filter((b) => b.type !== 'image')
                .map((b) => (b.type === 'tool_result' ? { ...b, images: undefined } : b))
            }))
            fidelity.push(
              'Claude parent reconstructed by production resume loader at timestamp-bounded UUID anchor; live history may differ'
            )
          } else {
            skip('dispatch-parent-history-unavailable')
            continue
          }
          const trajectory = new Map<string, ChatMessage>()
          for (const message of messages) recordTrajectoryMessage(trajectory, message)
          messages = new DispatchTargetJudge({
            engine: source.engine,
            cwd: source.cwd,
            routingId: source.dispatch.parent_session_id,
            sessionId: () => source.id,
            model: () => source.dispatch!.model,
            emit: () => () => {},
            messages: () => parentMessages,
            trajectory: () => trajectory.values(),
            subagent: () => undefined,
            loadEngineConfig: () => ({}),
            peekModels: () => null
          }).judgeMessages()
          const launch = parentMessages
            .flatMap((m) => m.content)
            .findLast(
              (b) =>
                b.type === 'tool_use' &&
                (b.toolUseId === source.dispatch!.parent_tool_use_id ||
                  b.toolInput.session_id === source.dispatch!.id)
            )
          if (!launch || launch.type !== 'tool_use') {
            skip('dispatch-launch-header-unavailable')
            continue
          }
          const restriction = source.dispatch.caller_restriction
            ? JSON.parse(source.dispatch.caller_restriction)
            : undefined
          const note = restrictionNote(restriction)
          action.subagent = {
            type: `dispatch:${source.engine}`,
            description: note ? `${source.dispatch.model} — ${note}` : source.dispatch.model,
            prompt: launch.toolInput.prompt as string
          }
          fidelity.push(
            'dispatch task header recovered from ledger-linked parent call; continuation linkage may be incomplete'
          )
        } else if (source.parentId) {
          let root = source
          const visited = new Set<string>()
          while (root.parentId && !visited.has(root.id)) {
            visited.add(root.id)
            const parent = sources.find((s) => s.engine === 'opencode' && s.id === root.parentId)
            if (!parent) break
            root = parent
          }
          if (root.parentId) {
            skip('opencode-root-history-unavailable')
            continue
          }
          messages = prefix(root, decision.timestamp)
          environmentSource = root
          outcomeMessages = messages
          const launch = messages
            .flatMap((m) => m.content)
            .findLast(
              (b) => b.type === 'tool_use' && ['task', 'subagent', 'agent'].includes(b.toolName)
            )
          if (launch?.type === 'tool_use')
            action.subagent = {
              ...subagent(launch.toolInput),
              type:
                typeof launch.toolInput.agent === 'string'
                  ? launch.toolInput.agent
                  : typeof launch.toolInput.subagent_type === 'string'
                    ? launch.toolInput.subagent_type
                    : 'unknown'
            }
          else action.subagent = { type: 'unknown' }
          fidelity.push('child outcomes absent in production')
        }
        const envKey = `${environmentSource.cwd}:${source.dispatch?.caller_restriction ?? ''}:${!!source.dispatch}`
        if (!environmentCache.has(envKey))
          environmentCache.set(
            envKey,
            await buildEnvironment(environmentSource.cwd, source.dispatch)
          )
        const command = shellCommandOf(action.toolName, action.input)
        const extracted: ReplayCase = {
          // The WHOLE session id: pi ids are UUIDv7 and opencode ids are time-prefixed, so sessions
          // started together (parallel subagents, dispatches) share any truncated prefix.
          id: `R-${route}-${source.id.replace(/[^A-Za-z0-9]/g, '')}-${index + 1}`,
          title: `Real ${route} decision`,
          expect: 'block',
          messages,
          action,
          outcomes: outcomes(outcomeMessages, decision.callId),
          ...(command ? { measureRedirects: command } : {}),
          environment: environmentCache.get(envKey),
          real: {
            route,
            engine: source.engine,
            sessionId: source.id,
            file: source.file,
            line: source.engine === 'pi' ? decision.row.line : decision.row.seq,
            callId: decision.callId,
            timestamp: decision.timestamp,
            originalReason: decision.denied ? decision.reason : '',
            fidelity,
            redactions: {},
            tempDirs: tempDirRoots(process.env, process.platform)
          }
        }
        const counts: Record<string, number> = {}
        const safe = redact(extracted, counts)
        safe.real.redactions = counts
        cases.push(safe)
        stats[route].built++
      } catch {
        skip('case-reconstruction-failed')
      }
    }
  }
  for (const id of included) if (!foundIncludes.has(id)) failed('included-call-not-found')
  // Labels are keyed by case id: a collision would silently score one case against another's label.
  if (new Set(cases.map((c) => c.id)).size !== cases.length) throw new Error('duplicate case ids')
  return { cases, stats, discovery }
}

export function cardsFor(cases: ReplayCase[]): string {
  return cases
    .map((c) => {
      const cwd = c.environment!.cwd
      const redirects = c.measureRedirects
        ? analyzeRedirects(c.measureRedirects, { cwd, tempDirs: c.real.tempDirs }, process.platform)
        : []
      const users = c.messages
        .filter((m) => m.role === 'user')
        .slice(-3)
        .map((m) => textOf(m.content).slice(0, 600))
      return `## ${c.id}\n\nRoute: ${c.real.route}\nSource: ${c.real.file}:${c.real.line}\nTimestamp: ${c.real.timestamp}\nReason: ${c.real.originalReason}\nTool: ${c.action.toolName}\nInput: ${JSON.stringify(c.action.input).slice(0, 1500)}\nCwd: ${cwd}\nRedirects now: ${JSON.stringify(redirects)}\nDirect user turns: ${JSON.stringify(users)}\nSubagent: ${JSON.stringify(c.action.subagent ?? null)}\n`
    })
    .join('\n')
}

export async function main(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string' },
      'dry-run': { type: 'boolean' },
      include: { type: 'string', multiple: true }
    }
  })
  if (!values.out) throw new Error('--out is required')
  const result = await extractReal({ include: values.include })
  if (!values['dry-run']) {
    const out = resolve(values.out)
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'cases.json'), JSON.stringify(result.cases, null, 2) + '\n')
    writeFileSync(join(out, 'cards.md'), redact(cardsFor(result.cases)))
  }
  for (const route of ROUTES) console.log(JSON.stringify({ route, ...result.stats[route] }))
  console.log(JSON.stringify({ discoverySkipped: result.discovery }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    console.error('Extraction failed (details suppressed for privacy)')
    process.exitCode = 1
  })
}
