/**
 * Per-tool card specs for Claude's non-file, non-shell tools.
 *
 * cli.js 2.1.268 hands ClaudeUI 32 tools (docs/tool-survey.md § 7). Eleven map
 * onto a semantic kind, one is hidden, and the other twenty used to fall to
 * `unknown` — which renders `JSON.stringify(input)` in the header AND a JSON dump
 * in the body. A tool that schedules a job, stops a task or loads a skill
 * deserves better than its own arguments read back to it.
 *
 * Each of the twenty gets a spec here rather than a component: the shape it
 * takes (`detail` field list, `findings` rows, or a one-line `note`) plus a pure
 * function from the call to that shape. Twenty bespoke cards, three renderers.
 *
 * Adding a tool is one entry. A tool with NO entry keeps today's behaviour, so
 * an unknown name — a new cli.js tool, an MCP tool, a plugin's tool — is never
 * mis-rendered by a spec that was guessing.
 */

import type { ToolKind, ToolView } from '../../../../../shared/tool-kinds'
import type { ContentBlock } from '../../../../../shared/types'

type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>
type Input = Record<string, unknown>

export interface ClaudeToolSpec {
  kind: ToolKind
  build(input: Input, result?: ToolResultBlock): ToolView
}

// ---------------------------------------------------------------------------
// Small readers — every one of them tolerates a field that is absent or of the
// wrong type, because the input is whatever the model sent, not a validated DTO.
// ---------------------------------------------------------------------------

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

/** A field list, dropping every row whose value is absent. */
function fields(rows: [string, string | number | boolean | undefined][]): {
  label: string
  value: string
}[] {
  return rows
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([label, value]) => ({ label, value: String(value) }))
}

const detail = (
  rows: [string, string | number | boolean | undefined][],
  text?: string
): ToolView => ({ kind: 'detail', fields: fields(rows), ...(text ? { text } : {}) })

const note = (icon: string, text: string): ToolView => ({ kind: 'note', icon, text })

/** `20 min` / `45 s` / `2 h 5 min` — a delay a person can read at a glance. */
export function humanDelay(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '?'
  if (seconds < 90) return `${Math.round(seconds)} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes - hours * 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

/** The last path segment, for a header that would otherwise be all directory. */
const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() || path

// ---------------------------------------------------------------------------
// The specs
// ---------------------------------------------------------------------------

export const CLAUDE_TOOL_SPECS: Record<string, ClaudeToolSpec> = {
  // --- rich enough to be worth a field list + its output ---------------------

  Skill: {
    kind: 'detail',
    build: (input, result) =>
      detail(
        [
          ['skill', str(input.skill)],
          ['args', str(input.args)]
        ],
        result?.toolResult
      )
  },

  Monitor: {
    kind: 'detail',
    build: (input, result) =>
      detail(
        [
          ['watching', str(input.description)],
          ['command', str(input.command) ?? str((input.ws as Input | undefined)?.url)],
          [
            'expires in',
            num(input.timeout_ms) ? humanDelay(num(input.timeout_ms)! / 1000) : undefined
          ]
        ],
        result?.toolResult
      )
  },

  TaskOutput: {
    kind: 'detail',
    build: (input, result) =>
      detail(
        [
          ['task', str(input.task_id)],
          ['waits for completion', input.block === false ? 'no' : 'yes']
        ],
        result?.toolResult
      )
  },

  Workflow: {
    kind: 'detail',
    build: (input, result) =>
      detail(
        [
          ['workflow', str(input.name) ?? str(input.title)],
          ['script', str(input.scriptPath)],
          ['args', input.args !== undefined ? JSON.stringify(input.args) : undefined]
        ],
        result?.toolResult
      )
  },

  Artifact: {
    kind: 'detail',
    build: (input, result) =>
      detail(
        [
          ['action', str(input.action) ?? 'publish'],
          ['title', str(input.title)],
          ['url', str(input.url)],
          ['file', str(input.file_path)]
        ],
        result?.toolResult
      )
  },

  ListAgents: {
    kind: 'detail',
    build: (_input, result) => detail([], result?.toolResult)
  },

  SendMessage: {
    kind: 'detail',
    build: (input, result) =>
      detail(
        [
          ['to', str(input.to)],
          ['summary', str(input.summary)],
          ['notify when idle', input.notify_when_idle === true ? 'yes' : undefined]
        ],
        typeof input.message === 'string' ? input.message : result?.toolResult
      )
  },

  ScheduleWakeup: {
    kind: 'detail',
    build: (input) =>
      input.stop === true
        ? detail([['loop', 'stopped']])
        : detail([
            [
              'wakes in',
              num(input.delaySeconds) ? humanDelay(num(input.delaySeconds)!) : undefined
            ],
            ['reason', str(input.reason)],
            [
              'nothing changed',
              input.noop === true ? 'yes' : input.noop === false ? 'no' : undefined
            ]
          ])
  },

  CronCreate: {
    kind: 'detail',
    build: (input, result) =>
      detail(
        [
          ['schedule', str(input.cron)],
          ['prompt', str(input.prompt)],
          ['recurring', input.recurring === false ? 'once' : 'every match'],
          ['durable', input.durable === true ? 'yes' : undefined]
        ],
        result?.toolResult
      )
  },

  RemoteTrigger: {
    kind: 'detail',
    build: (input, result) =>
      detail(
        [
          ['action', str(input.action)],
          ['trigger', str(input.trigger_id)],
          ['session', str(input.session_id)]
        ],
        result?.toolResult
      )
  },

  EnterWorktree: {
    kind: 'detail',
    build: (input, result) =>
      detail(
        [
          ['name', str(input.name)],
          ['path', str(input.path)]
        ],
        result?.toolResult
      )
  },

  ShareOnboardingGuide: {
    kind: 'detail',
    build: (input, result) =>
      detail(
        [
          ['mode', str(input.mode)],
          ['guide', str(input.short_code)]
        ],
        result?.toolResult
      )
  },

  DesignSync: {
    kind: 'detail',
    build: (input, result) =>
      detail(
        Object.entries(input).map(([k, v]) => [k, str(v)]),
        result?.toolResult
      )
  },

  // --- structured review output --------------------------------------------

  ReportFindings: {
    kind: 'findings',
    build: (input) => ({
      kind: 'findings',
      level: str(input.level),
      findings: (Array.isArray(input.findings) ? input.findings : []).map((raw) => {
        const f = (raw ?? {}) as Input
        return {
          file: str(f.file),
          line: num(f.line),
          summary: str(f.short_summary) ?? str(f.summary) ?? '',
          detail:
            str(f.summary) !== str(f.short_summary) ? str(f.summary) : str(f.failure_scenario),
          category: str(f.category),
          verdict: str(f.verdict),
          outcome: str(f.outcome)
        }
      })
    })
  },

  // --- one fact, one row ----------------------------------------------------

  ToolSearch: {
    kind: 'note',
    build: (input) => {
      const query = str(input.query) ?? ''
      // `select:Read,Edit` is an exact fetch; anything else is a search.
      const selected = query.startsWith('select:')
        ? query.slice('select:'.length).split(',').filter(Boolean)
        : null
      return note(
        'search',
        selected
          ? `Loaded ${selected.length} tool schema${selected.length === 1 ? '' : 's'}: ${selected.join(', ')}`
          : `Searched tools for "${query}"`
      )
    }
  },

  TaskStop: {
    kind: 'note',
    build: (input) => note('stop', `Stopped background task ${str(input.task_id) ?? ''}`.trim())
  },

  PushNotification: {
    kind: 'note',
    build: (input) => note('bell', str(input.message) ?? 'Push notification sent')
  },

  CronDelete: {
    kind: 'note',
    build: (input) => note('trash', `Deleted schedule ${str(input.id) ?? ''}`.trim())
  },

  CronList: {
    kind: 'note',
    build: () => note('calendar', 'Listed the scheduled prompts')
  },

  ExitWorktree: {
    kind: 'note',
    build: (input) =>
      note(
        'exit',
        input.action === 'remove'
          ? `Cleaned up the worktree, ${input.discard_changes === true ? 'discarding' : 'keeping'} its changes`
          : 'Left the worktree'
      )
  },

  SendUserFile: {
    kind: 'note',
    build: (input) => {
      const raw = input.files
      const files = (Array.isArray(raw) ? raw : [raw]).filter(
        (f): f is string => typeof f === 'string' && f.length > 0
      )
      const caption = str(input.caption)
      const names = files.map(basename).join(', ')
      return note(
        'file',
        files.length === 0
          ? 'Sent a file'
          : `Sent ${files.length} file${files.length === 1 ? '' : 's'}: ${names}${caption ? ` — ${caption}` : ''}`
      )
    }
  }
}

/** The spec for a tool name, or null when the name has none. */
export function claudeToolSpec(toolName: string): ClaudeToolSpec | null {
  return CLAUDE_TOOL_SPECS[toolName] ?? null
}
