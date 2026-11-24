/**
 * @vitest-environment node
 *
 * A rebuild's progress from a recorded `scripts/build.mjs build:stage -v` run.
 */
import { describe, expect, it } from 'vitest'
import { BuildProgress, MAX_LINE, expectedStageLabels } from '../progress'

/** What build.mjs printed for a macOS build:stage (trimmed, paths as they were). */
const RECORDED = [
  '[1/6] typecheck:node ‖ typecheck:web ‖ electron-vite build',
  '  ✓ typecheck:web (8.1s)',
  '$ bun run --silent typecheck:web',
  '  ✓ typecheck:node (11.9s)',
  '  ✓ electron-vite build (24.0s)',
  '$ bunx electron-vite build',
  'vite v6.3.5 building SSR bundle for production...',
  '\u001b[32m✓\u001b[39m 1204 modules transformed.',
  '[2/6] stamp build-info',
  '$ bun scripts/stamp-build-info.mjs',
  'stamped /Users/dev/work/ClaudeUI/out/build-info.json',
  '[3/6] electron-builder --mac --dir',
  '$ bunx electron-builder --mac --dir -c.directories.output=/Users/dev/.claude/ui/updates/desktop/rebuild-0123abcd',
  '  • packaging       platform=darwin arch=arm64 electron=38.1.0 appOutDir=/Users/dev/.claude/ui/updates/desktop/rebuild-0123abcd/mac-arm64',
  '[4/6] stamp install-marker',
  '[5/6] codesign',
  '[6/6] xattr -cr',
  '',
  'build:stage ✓ (6 stages, 61.2s)'
]

const scrub = (line: string): string =>
  line
    .split('/Users/dev/.claude/ui/updates/desktop')
    .join('…')
    .split('/Users/dev/work/ClaudeUI')
    .join('<tree>')
    .split('/Users/dev')
    .join('~')

describe('BuildProgress', () => {
  it('follows the stages of a recorded run, with elapsed times', () => {
    let t = 1_000
    const p = new BuildProgress(() => t, scrub, expectedStageLabels('darwin'))
    expect(p.stages()).toEqual([])
    expect(p.push(RECORDED[0])).toBe(true)
    expect(p.stages()).toEqual([
      {
        label: 'typecheck:node ‖ typecheck:web ‖ electron-vite build',
        state: 'running',
        elapsedMs: 0
      },
      { label: 'stamp build-info', state: 'pending' },
      { label: 'electron-builder --mac --dir', state: 'pending' },
      { label: 'stamp install-marker', state: 'pending' },
      { label: 'codesign', state: 'pending' },
      { label: 'xattr -cr', state: 'pending' }
    ])
    t = 25_000
    for (const line of RECORDED.slice(1, 8)) expect(p.push(line)).toBe(false)
    expect(p.lastLine()).toBe('✓ 1204 modules transformed.')
    expect(p.push(RECORDED[8])).toBe(true)
    const s = p.stages()
    expect(s[0]).toEqual({ label: s[0].label, state: 'done', elapsedMs: 24_000 })
    expect(s[1]).toMatchObject({ label: 'stamp build-info', state: 'running' })
    for (const line of RECORDED.slice(9)) p.push(line)
    t = 62_000
    p.finish()
    expect(p.stages().map((x) => x.state)).toEqual(Array(6).fill('done'))
    expect(p.lastLine()).toBe('build:stage ✓ (6 stages, 61.2s)')
    expect(p.failure()).toBeNull()
  })

  it('replaces local paths before a line is kept', () => {
    const p = new BuildProgress(() => 0, scrub)
    for (const line of RECORDED.slice(0, 14)) p.push(line)
    expect(p.lastLine()).toBe(
      '• packaging       platform=darwin arch=arm64 electron=38.1.0 appOutDir=…/rebuild-0123abcd/mac-arm64'
    )
    p.push(RECORDED[10])
    expect(p.lastLine()).toBe('stamped <tree>/out/build-info.json')
    expect(JSON.stringify(p.snapshot())).not.toContain('/Users/dev')
  })

  it('names the failing stage from `✗ <label> failed (exit N)`', () => {
    const p = new BuildProgress(() => 0, scrub)
    p.push('[1/6] typecheck:node ‖ typecheck:web ‖ electron-vite build')
    p.push("src/main/x.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'.")
    p.push('  ✗ typecheck:node failed (exit 2)')
    p.push('  ✓ electron-vite build (20.0s)')
    expect(p.failure()).toEqual({ label: 'typecheck:node', code: 2 })
    expect(p.currentStage()).toBe('typecheck:node ‖ typecheck:web ‖ electron-vite build')
  })

  it('an unexpected stage count falls back to numbered pending stages', () => {
    const p = new BuildProgress(
      () => 0,
      (l) => l,
      expectedStageLabels('win32')
    )
    p.push('[1/3] something else')
    expect(p.stages().map((s) => s.label)).toEqual(['something else', 'Stage 2', 'Stage 3'])
  })

  it('caps a long line and ignores blank ones', () => {
    const p = new BuildProgress(
      () => 0,
      (l) => l
    )
    p.push('x'.repeat(1000))
    expect(p.lastLine()!.length).toBe(MAX_LINE)
    p.push('   ')
    p.push('\r')
    expect(p.lastLine()!.startsWith('xxx')).toBe(true)
  })
})
