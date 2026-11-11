// ---------------------------------------------------------------------------
// Automation types (scheduled cron-job system)
// ---------------------------------------------------------------------------

export interface AutomationSchedule {
  type: 'interval' | 'cron'
  intervalMs?: number
  cronExpression?: string
}

export interface Automation {
  id: string
  name: string
  prompt: string
  cwd: string
  schedule: AutomationSchedule
  permissions: { allow: string[]; deny: string[] }
  model?: string
  effort?: string
  thinkingMode?: 'adaptive' | 'enabled' | 'disabled'
  permissionMode?: 'default' | 'auto'
  enabled: boolean
  lastRunAt: number | null
  lastRunStatus: 'success' | 'error' | null
  createdAt: number
}

export interface AutomationRun {
  id: string
  automationId: string
  startedAt: number
  finishedAt: number | null
  status: 'running' | 'success' | 'error'
  /** Run cost in USD; null when the engine could not price the run. */
  totalCostUsd: number | null
  error?: string
  resultSummary?: string
  /** SDK session ID — used to locate the project JSONL for message history */
  sessionId?: string
  /** SDK project key (cwd with /.\\ replaced by -) — used with sessionId to load history */
  projectKey?: string
}
