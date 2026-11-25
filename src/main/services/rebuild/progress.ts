/**
 * A rebuild's progress from what `scripts/build.mjs` prints: a stage starts at
 * `[i/N] <label>` (a parallel group's members joined with ` ‖ `), the previous
 * one is then done; the run ends with `<target> ✓ (...)` or a failure line
 * `  ✗ <label> failed (exit N)`. Every other non-empty line is "the last line".
 * Stages not reached yet are listed as pending, with the labels the host
 * expects for `build:stage` when the count matches, else `Stage k`.
 *
 * Lines are untrusted text: colour codes are stripped, local paths replaced
 * (`scrub`), and the length capped before anything reaches a view.
 */

import type {
  AppUpdateRebuildProgress,
  AppUpdateRebuildStage
} from '../../../shared/types/app-update'

// eslint-disable-next-line no-control-regex -- the ANSI colour escapes are the point
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const STAGE_RE = /^\[(\d+)\/(\d+)\]\s+(.+)$/
const FAILED_RE = /^\s*✗\s+(.+?)\s+failed \(exit (\d+)\)\s*$/
export const MAX_LINE = 300

/** The `build:stage` stage labels `scripts/lib/build-targets.mjs` prints, per host. */
export function expectedStageLabels(platform: 'darwin' | 'win32'): string[] {
  const prepare = 'typecheck:node ‖ typecheck:web ‖ electron-vite build'
  return platform === 'darwin'
    ? [
        prepare,
        'stamp build-info',
        'electron-builder --mac --dir',
        'stamp install-marker',
        'codesign',
        'xattr -cr'
      ]
    : [prepare, 'stamp build-info', 'electron-builder --win --dir', 'stamp install-marker']
}

export class BuildProgress {
  private started: Array<{ label: string; at: number; endedAt?: number }> = []
  private total = 0
  private last: string | undefined
  private failed: { label: string; code: number } | null = null

  constructor(
    private readonly now: () => number,
    private readonly scrub: (line: string) => string,
    private readonly expected: readonly string[] = []
  ) {}

  /** Feed one output line; true when the stages changed (worth an immediate emit). */
  push(raw: string): boolean {
    const line = raw.replace(ANSI_RE, '').replace(/\r/g, '').trimEnd()
    if (line.trim() === '') return false
    const clean = this.scrub(line).trim()
    this.last = clean.length > MAX_LINE ? `${clean.slice(0, MAX_LINE - 1)}…` : clean
    const stage = STAGE_RE.exec(line)
    if (stage) {
      const t = this.now()
      const prev = this.started.at(-1)
      if (prev && prev.endedAt === undefined) prev.endedAt = t
      this.total = Math.max(this.total, Number(stage[2]))
      this.started.push({ label: this.scrub(stage[3].trim()).slice(0, MAX_LINE), at: t })
      return true
    }
    const failed = FAILED_RE.exec(line)
    if (failed && !this.failed)
      this.failed = { label: this.scrub(failed[1]), code: Number(failed[2]) }
    return false
  }

  /** The build ended (exit 0): the running stage is done. */
  finish(): void {
    const prev = this.started.at(-1)
    if (prev && prev.endedAt === undefined) prev.endedAt = this.now()
  }

  /** The first `✗ <label> failed` line, if any. */
  failure(): { label: string; code: number } | null {
    return this.failed
  }

  /** The label of the stage running (or that was running when the build stopped). */
  currentStage(): string | null {
    return this.started.at(-1)?.label ?? null
  }

  lastLine(): string | undefined {
    return this.last
  }

  stages(): AppUpdateRebuildStage[] {
    const t = this.now()
    const out: AppUpdateRebuildStage[] = this.started.map((s) => ({
      label: s.label,
      state: s.endedAt === undefined ? 'running' : 'done',
      elapsedMs: Math.max(0, (s.endedAt ?? t) - s.at)
    }))
    const labels = this.expected.length === this.total ? this.expected : []
    for (let i = out.length; i < this.total; i++)
      out.push({ label: labels[i] ?? `Stage ${i + 1}`, state: 'pending' })
    return out
  }

  snapshot(): AppUpdateRebuildProgress {
    return { stages: this.stages(), ...(this.last !== undefined ? { lastLine: this.last } : {}) }
  }
}
