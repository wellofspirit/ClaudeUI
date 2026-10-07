/**
 * Layer 2b: the agent roster on a phone and in a panel (ADR-073 §9, §10) — real
 * Chromium, real Tailwind, the owner's S25 Ultra size, under SessionView's `zoom`.
 *
 * What a jsdom test cannot see, and what shipped broken: the overlay was
 * `min(420px, 100vw - 32px)`, which `zoom: uiFontScale` multiplies, so at 1.1 it
 * spilled 15px off a 412px screen; the row's `shrink-0` children summed past the
 * row, clipping Stop; and once nothing overflowed, the shrink weights left a name
 * of one character and a badge of "g." — contained, but unreadable. So these
 * assert READABILITY (a name floor, a whole type tile, metrics that show), not
 * just containment.
 *
 * §10 made every row ONE line at every width: dot · 16px type column · label ·
 * resumed chip · spacer · Stop · metrics. The assertions here are the ones that
 * make that true: the row is a single line tall, nothing overflows sideways,
 * the metrics end at the same x on every row (running or finished), and Stop
 * sits left of the metrics. The fixtures use NON-default types where a tile is
 * wanted, because the engine's default type has no tile.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import {
  useSessionStore,
  EMPTY_SESSION_STATE,
  DEFAULT_SETTINGS
} from '../../../stores/session-store'
import { useAgentRoster } from '../../../hooks/useAgentRoster'
import type { ChatMessage } from '../../../../../shared/types'
import {
  FONT_SCALES,
  PROFILE,
  LayoutComposer,
  ZoomFrame,
  allByTestId,
  byTestId,
  hasNoHorizontalOverflow,
  isInside,
  isInsideViewportX,
  isOneLine,
  rectOf,
  settle
} from '@test/helpers/mobile-layout'
import { AgentTab } from '../AgentTab'
import { AgentRosterList } from '../AgentRosterList'

const ROUTE = 'route-agent-layout'
const TOP = 'tu-top'
const NESTED = 'tu-nested'
const SHELL = 'tu-shell'
const DONE = 'tu-done'
const UNNAMED = 'tu-unnamed'

/** The scales the roster is checked at: the profile's, plus 1.25 (a common setting). */
const SCALES = [...FONT_SCALES, 1.25].sort((a, b) => a - b)

/** Roster widths (CSS px, inside the zoom) the one-line rule is held at. */
const WIDTHS = [240, 280, 350, 380, 420, 460, 600]

function spawn(id: string, toolUseId: string, input: Record<string, unknown>): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'tool_use', toolUseId, toolName: 'Agent', toolInput: input }],
    timestamp: 0
  }
}

function bash(id: string, toolUseId: string, command: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        toolUseId,
        toolName: 'Bash',
        toolInput: { command, run_in_background: true }
      }
    ],
    timestamp: 0
  }
}

const LONG_COMMAND =
  'until grep -q "END compare" /d/WorkPlace/ClaudeUI/.cache/compare.log; do sleep 5; done'

/**
 * The worst row the roster has to draw: every element present, every one long.
 * Three running rows: an agent with a long name, resume chip and metrics; its
 * nested agent; and a background shell with a long command, launched by the
 * first agent (so it is a depth-1 row after the nested agent).
 */
function seedWorstCaseRoster(
  name = 'abcdefghijklmnopqrst',
  runIndex = 2,
  nestedName = 'nested-reviewer-agent'
): void {
  const description =
    'Port the production report pilot to the new controller layer and reconcile every schema difference'
  useSessionStore.setState({
    activeSessionId: ROUTE,
    settings: { ...DEFAULT_SETTINGS, showAgentTab: true },
    sessions: {
      [ROUTE]: {
        ...EMPTY_SESSION_STATE,
        messages: [
          spawn('m-top', TOP, {
            name,
            subagent_type: 'migration-reviewer',
            description,
            run_in_background: true
          })
        ],
        subagentMessages: {
          [TOP]: [
            spawn('m-nested', NESTED, {
              name: nestedName,
              subagent_type: 'Explore',
              description,
              run_in_background: true
            }),
            bash('m-shell', SHELL, LONG_COMMAND)
          ]
        },
        activeTasks: {
          [TOP]: { taskId: 't-top', taskType: 'local_agent', runIndex, isBackgrounded: true },
          [NESTED]: {
            taskId: 't-nested',
            taskType: 'local_agent',
            runIndex: 1,
            isBackgrounded: true
          },
          [SHELL]: {
            taskId: 't-shell',
            taskType: 'local_bash',
            runIndex: 1,
            isBackgrounded: true,
            startedAt: Date.now() - 125_000
          }
        },
        taskProgressMap: {
          [TOP]: {
            toolUseId: TOP,
            toolName: 'Agent',
            parentToolUseId: null,
            elapsedTimeSeconds: 135,
            lastToolName: 'Bash',
            usage: { totalTokens: 8_720_900, toolUses: 12, durationMs: 135_000 }
          },
          [NESTED]: {
            toolUseId: NESTED,
            toolName: 'Agent',
            parentToolUseId: TOP,
            elapsedTimeSeconds: 40,
            lastToolName: 'Bash',
            usage: { totalTokens: 8_720_900, toolUses: 3, durationMs: 40_000 }
          }
        }
      }
    }
  })
}

/**
 * A roster with every kind of row the list draws, for the width sweep: a running
 * named agent (resumed, with a tile), its running nested agent, a running shell
 * it launched, a FINISHED agent, an unnamed agent (labelled by its description)
 * and a shell the main session launched.
 */
function seedMixedRoster(): void {
  seedWorstCaseRoster('abcdefghijkl', 2, 'nested-agent')
  const state = useSessionStore.getState().sessions[ROUTE]
  useSessionStore.setState({
    sessions: {
      [ROUTE]: {
        ...state,
        messages: [
          ...state.messages,
          spawn('m-done', DONE, {
            name: 'finished-agent',
            subagent_type: 'general-purpose',
            description: 'A finished run'
          }),
          spawn('m-unnamed', UNNAMED, {
            subagent_type: 'Plan',
            description: 'Plan the migration of every report',
            run_in_background: true
          }),
          bash('m-main-shell', 'tu-main-shell', 'bun run dev --port 5173 --host')
        ],
        taskNotifications: [
          {
            taskId: 't-done',
            toolUseId: DONE,
            status: 'completed',
            outputFile: '',
            summary: '',
            usage: { totalTokens: 451_800, toolUses: 9, durationMs: 90_000 }
          }
        ],
        activeTasks: {
          ...state.activeTasks,
          [UNNAMED]: {
            taskId: 't-unnamed',
            taskType: 'local_agent',
            runIndex: 1,
            isBackgrounded: true
          },
          'tu-main-shell': {
            taskId: 't-main-shell',
            taskType: 'local_bash',
            runIndex: 1,
            isBackgrounded: true,
            startedAt: Date.now() - 3_700_000
          }
        },
        taskProgressMap: {
          ...state.taskProgressMap,
          [DONE]: {
            toolUseId: DONE,
            toolName: 'Agent',
            parentToolUseId: null,
            elapsedTimeSeconds: 90,
            usage: { totalTokens: 451_800, toolUses: 9, durationMs: 90_000 }
          },
          [UNNAMED]: {
            toolUseId: UNNAMED,
            toolName: 'Agent',
            parentToolUseId: null,
            elapsedTimeSeconds: 12,
            lastToolName: 'Read',
            usage: { totalTokens: 41_200, toolUses: 2, durationMs: 12_000 }
          }
        }
      }
    }
  })
}

async function openOverlay(scale: number, width?: string): Promise<HTMLElement> {
  const view = render(
    <ZoomFrame scale={scale} width={width}>
      <LayoutComposer>
        <AgentTab />
      </LayoutComposer>
    </ZoomFrame>
  )
  await settle()
  byTestId(view.container, 'AgentTab').click()
  await settle()
  return byTestId(view.container, 'AgentOverlay')
}

/** The roster list on its own, in a box of a chosen width (the panel's case). */
function PanelRoster(): React.JSX.Element {
  const roster = useAgentRoster()
  return <AgentRosterList roster={roster} selectedIds={[]} onOpen={() => {}} />
}

/** The panel's roster at a width, on the All filter so finished rows show. */
async function mountPanel(width: number, all = true): Promise<HTMLElement> {
  const view = render(
    <ZoomFrame scale={1} width={`${width}px`}>
      <PanelRoster />
    </ZoomFrame>
  )
  await settle()
  if (all) {
    fireEvent.click(byTestId(view.container, 'AgentRoster.filter.all'))
    await settle()
  }
  expect(rectOf(byTestId(view.container, 'AgentRoster')).width).toBeCloseTo(width, 0)
  return view.container
}

const centreY = (el: HTMLElement): number => rectOf(el).top + rectOf(el).height / 2

/**
 * Under 300px of roster width the label floor drops from 4.5rem to 3rem: a deep
 * row with a resumed chip and Stop does not fit otherwise (measured at 256px,
 * uiFontScale 1.5, where the metrics spilled ~8px into the row's padding).
 */
const isNarrow = (row: HTMLElement): boolean =>
  byTestId(row.closest('[data-testid="AgentRoster"]')!.parentElement!, 'AgentRoster').clientWidth <
  300

/** The name is readable: at least its floor (4.5rem, 3rem when narrow), or all of it if shorter. */
function expectNameReadable(row: HTMLElement): void {
  const name = byTestId(row, 'AgentRow.name')
  const floor =
    (isNarrow(row) ? 3 : 4.5) * parseFloat(getComputedStyle(document.documentElement).fontSize)
  // Local (zoomed) px on both sides: scrollWidth is the whole text, clientWidth what shows.
  expect(name.clientWidth).toBeGreaterThanOrEqual(Math.min(name.scrollWidth, floor) - 1)
}

/** The metrics keep their floor (3rem), or all of their text if it is shorter. */
function expectMetricsReadable(row: HTMLElement): void {
  const metrics = byTestId(row, 'AgentRow.metrics')
  expect(metrics.clientWidth).toBeGreaterThanOrEqual(Math.min(metrics.scrollWidth, 48) - 1)
}

/** The tile shows whole, a 16px square: a clipped letter is a broken tile. */
function expectTileWhole(row: HTMLElement): void {
  const tile = byTestId(row, 'AgentRow.typeTile')
  expect(tile.scrollWidth).toBeLessThanOrEqual(tile.clientWidth + 1)
  expect(tile.clientHeight).toBe(16)
  expect(tile.clientWidth).toBeGreaterThanOrEqual(16)
  expect(tile.innerText.trim()).toMatch(/^[A-Z0-9]$/)
}

/**
 * The row is one line: its height is a single line's, and the name, the metrics
 * and Stop (when there) share a vertical centre. Two lines would be ~20px taller
 * (a second 11px line plus its gap), so the bound is below that.
 */
function expectOneLine(row: HTMLElement): void {
  const name = byTestId(row, 'AgentRow.name')
  // A button is 20px of content in a 28-32px row; two lines were 50px+.
  expect(rectOf(row).height).toBeLessThanOrEqual(rectOf(name).height + 22)
  expect(isOneLine(name)).toBe(true)
  const metrics = row.querySelector<HTMLElement>('[data-testid="AgentRow.metrics"]')
  if (metrics) {
    expect(isOneLine(metrics)).toBe(true)
    expect(Math.abs(centreY(metrics) - centreY(name))).toBeLessThanOrEqual(2)
  }
  const stop = row.querySelector<HTMLElement>('[data-testid="AgentRow.stop"]')
  if (stop) {
    expect(isOneLine(stop)).toBe(true)
    expect(Math.abs(centreY(stop) - centreY(name))).toBeLessThanOrEqual(2)
    // Stop is before the metrics, never over them.
    if (metrics) expect(rectOf(stop).right).toBeLessThanOrEqual(rectOf(metrics).left + 1)
  }
}

describe('agent roster overlay on the phone', () => {
  beforeEach(() => seedWorstCaseRoster())
  afterEach(() => {
    cleanup()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  for (const scale of SCALES) {
    describe(`uiFontScale ${scale}`, () => {
      it('keeps the overlay inside the screen and inside the composer', async () => {
        // The project really runs at the phone's size, or every other number is moot.
        expect(window.innerWidth).toBe(PROFILE.width)
        const overlay = await openOverlay(scale)
        const composer = byTestId(document.body, 'LayoutComposer')
        expect(isInsideViewportX(overlay)).toBe(true)
        const o = rectOf(overlay)
        const c = rectOf(composer)
        expect(o.left).toBeGreaterThanOrEqual(0)
        expect(o.right).toBeLessThanOrEqual(window.innerWidth)
        expect(o.left).toBeGreaterThanOrEqual(c.left - 0.75)
        expect(o.right).toBeLessThanOrEqual(c.right + 0.75)
      })

      it('lays every row out on ONE line, readable and unclipped', async () => {
        const overlay = await openOverlay(scale)
        const rows = allByTestId(overlay, 'AgentRow')
        // The agent, its nested agent, and the shell it launched (after its child agents).
        expect(rows.map((r) => r.getAttribute('data-tool-use-id'))).toEqual([TOP, NESTED, SHELL])
        for (const row of rows) {
          expect(hasNoHorizontalOverflow(row)).toBe(true)
          expect(row.querySelector('[data-testid="AgentRow.description"]')).toBeNull()

          const ids = ['AgentRow.name', 'AgentRow.metrics', 'AgentRow.stop']
          // Everything the row draws lies inside the row.
          for (const id of ids) expect(isInside(byTestId(row, id), row)).toBe(true)
          const resumed = row.querySelector<HTMLElement>('[data-testid="AgentRow.resumed"]')
          if (resumed) {
            expect(isInside(resumed, row)).toBe(true)
            expect(isOneLine(resumed)).toBe(true)
          }
          expectOneLine(row)
          // Readable, not just contained.
          expectNameReadable(row)
          expectMetricsReadable(row)
        }
        const tile = byTestId(rows[1], 'AgentRow.typeTile')
        expectTileWhole(rows[1])
        // The tile sits in the type column, before the label, on its line.
        expect(rectOf(tile).right).toBeLessThanOrEqual(
          rectOf(byTestId(rows[1], 'AgentRow.name')).left + 1
        )
        expect(Math.abs(centreY(tile) - centreY(byTestId(rows[1], 'AgentRow.name')))).toBeLessThan(
          3
        )
      })

      it('shows the current tool in the metrics from 360px of roster width', async () => {
        const overlay = await openOverlay(scale)
        // The phone's list is 394px at 1 (tool shown), 356px at 1.1 and 256px at 1.5 (dropped).
        const wide = byTestId(overlay, 'AgentRoster').clientWidth >= 360
        for (const row of allByTestId(overlay, 'AgentRow').slice(0, 2)) {
          const metrics = byTestId(row, 'AgentRow.metrics')
          // innerText skips display:none; textContent would still hold the tool.
          expect(metrics.innerText.includes('Bash')).toBe(wide)
          expect(metrics.innerText).toMatch(/\d+[ms]/)
        }
      })

      it('keeps the metrics column flush right on every row', async () => {
        const overlay = await openOverlay(scale)
        const rights = allByTestId(overlay, 'AgentRow').map(
          (row) => rectOf(byTestId(row, 'AgentRow.metrics')).right
        )
        for (const right of rights) expect(Math.abs(right - rights[0])).toBeLessThanOrEqual(1)
      })

      it('makes every running row the same height, Stop included', async () => {
        const overlay = await openOverlay(scale)
        const heights = allByTestId(overlay, 'AgentRow').map((r) => rectOf(r).height)
        for (const h of heights) expect(Math.abs(h - heights[0])).toBeLessThanOrEqual(0.5)
      })

      it('keeps the nested row tree elbow meeting its status dot', async () => {
        const overlay = await openOverlay(scale)
        // Every nested row: the nested agent, and the shell under the first agent.
        const nested = allByTestId(overlay, 'AgentRow').filter(
          (r) => r.getAttribute('data-depth') === '1'
        )
        expect(nested).toHaveLength(2)
        for (const row of nested) {
          const dot = byTestId(row, 'AgentRow.status')
          const elbow = byTestId(row, 'AgentRow.elbow')
          const dotMid = rectOf(dot).top + rectOf(dot).height / 2
          expect(Math.abs(rectOf(elbow).bottom - dotMid)).toBeLessThanOrEqual(1)
        }
      })
    })
  }

  // A long name must not squeeze the clock and the tokens out: the metrics keep a
  // floor (3rem), and the name (4.5rem floor) truncates only after that.
  for (const scale of FONT_SCALES) {
    it(`keeps the metrics and the name readable with a 43-character name (uiFontScale ${scale})`, async () => {
      cleanup()
      seedWorstCaseRoster('a-very-long-agent-name-of-forty-three-chars', 2, 'b'.repeat(43))
      const overlay = await openOverlay(scale)
      for (const row of allByTestId(overlay, 'AgentRow')) {
        expect(hasNoHorizontalOverflow(row)).toBe(true)
        expectMetricsReadable(row)
        expectNameReadable(row)
        expectOneLine(row)
        for (const id of ['AgentRow.name', 'AgentRow.metrics', 'AgentRow.stop']) {
          expect(isInside(byTestId(row, id), row)).toBe(true)
        }
      }
    })
  }

  it('is one line in the 420px desktop overlay too, with the tool and whole tokens', async () => {
    // A wide composer, so the overlay is its full 420px.
    const overlay = await openOverlay(1, '700px')
    expect(rectOf(overlay).width).toBeCloseTo(420, 0)
    for (const row of allByTestId(overlay, 'AgentRow')) {
      expect(row.querySelector('[data-testid="AgentRow.description"]')).toBeNull()
      expect(hasNoHorizontalOverflow(row)).toBe(true)
      expectOneLine(row)
      expectNameReadable(row)
      expectMetricsReadable(row)
      for (const id of ['AgentRow.name', 'AgentRow.metrics', 'AgentRow.stop']) {
        expect(isInside(byTestId(row, id), row)).toBe(true)
      }
    }
    // 420px is not under 360px: the tool name stays on the agent rows.
    const [top] = allByTestId(overlay, 'AgentRow')
    expect(byTestId(top, 'AgentRow.metrics').innerText).toContain('Bash')
  })
})

describe('one line at every roster width (§10)', () => {
  beforeEach(() => seedMixedRoster())
  afterEach(() => {
    cleanup()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  for (const width of WIDTHS) {
    describe(`${width}px`, () => {
      it('draws every row on one line with nothing overflowing', async () => {
        const root = await mountPanel(width)
        const rows = allByTestId(root, 'AgentRow')
        // Running and finished, agents and shells, named and unnamed.
        expect(rows.map((r) => r.getAttribute('data-tool-use-id'))).toEqual([
          TOP,
          NESTED,
          SHELL,
          DONE,
          UNNAMED,
          'tu-main-shell'
        ])
        for (const row of rows) {
          expect(hasNoHorizontalOverflow(row)).toBe(true)
          expectOneLine(row)
          expectNameReadable(row)
          expectMetricsReadable(row)
          for (const id of ['AgentRow.name', 'AgentRow.metrics']) {
            expect(isInside(byTestId(row, id), row)).toBe(true)
          }
          const stop = row.querySelector<HTMLElement>('[data-testid="AgentRow.stop"]')
          if (stop) expect(isInside(stop, row)).toBe(true)
        }
        // The roster itself does not scroll sideways either.
        expect(hasNoHorizontalOverflow(byTestId(root, 'AgentRoster'))).toBe(true)
      })

      it('makes every row the same height, running (with Stop) or finished', async () => {
        const rows = allByTestId(await mountPanel(width), 'AgentRow')
        expect(rows.some((r) => r.querySelector('[data-testid="AgentRow.stop"]'))).toBe(true)
        expect(rows.some((r) => !r.querySelector('[data-testid="AgentRow.stop"]'))).toBe(true)
        const heights = rows.map((r) => rectOf(r).height)
        for (const h of heights) expect(Math.abs(h - heights[0])).toBeLessThanOrEqual(0.5)
      })

      it('shows the current tool from 360px and drops it below, without overflow', async () => {
        const rows = allByTestId(await mountPanel(width), 'AgentRow')
        const withTool = rows.filter((r) =>
          r.querySelector('[data-testid="AgentRow.metrics.tool"]')
        )
        // The two Bash agents and the Read agent carry a tool.
        expect(withTool).toHaveLength(3)
        for (const row of withTool) {
          const metrics = byTestId(row, 'AgentRow.metrics')
          // The parent's innerText skips a display:none child; the child's own would not.
          expect(/Bash|Read/.test(metrics.innerText)).toBe(width >= 360)
          expect(hasNoHorizontalOverflow(row)).toBe(true)
          expectMetricsReadable(row)
          expect(isInside(metrics, row)).toBe(true)
        }
      })

      it('ends the metrics at one x on running and finished rows alike', async () => {
        const rows = allByTestId(await mountPanel(width), 'AgentRow')
        // A finished row has no Stop and is in the list: that is the point.
        expect(rows.some((r) => r.getAttribute('data-running') === 'false')).toBe(true)
        expect(rows.some((r) => r.getAttribute('data-running') === 'true')).toBe(true)
        const rights = rows.map((row) => rectOf(byTestId(row, 'AgentRow.metrics')).right)
        for (const right of rights) expect(Math.abs(right - rights[0])).toBeLessThanOrEqual(1)
      })

      it('puts Stop wholly left of the metrics on every running row', async () => {
        const rows = allByTestId(await mountPanel(width), 'AgentRow')
        const running = rows.filter((r) => r.querySelector('[data-testid="AgentRow.stop"]'))
        expect(running.length).toBeGreaterThanOrEqual(3)
        for (const row of running) {
          const stop = byTestId(row, 'AgentRow.stop')
          const metrics = byTestId(row, 'AgentRow.metrics')
          expect(rectOf(stop).right).toBeLessThanOrEqual(rectOf(metrics).left + 1)
          expect(Math.abs(centreY(stop) - centreY(metrics))).toBeLessThanOrEqual(2)
          // Stop never shrinks: its label is whole.
          expect(stop.scrollWidth).toBeLessThanOrEqual(stop.clientWidth + 1)
        }
      })
    })
  }

  it('lines the labels up: every top-level row starts its label at one x', async () => {
    const rows = allByTestId(await mountPanel(460), 'AgentRow').filter(
      (r) => r.getAttribute('data-depth') === '0'
    )
    // Typed agent (migration-reviewer), default type (general-purpose), a typed
    // unnamed agent (Plan) and a shell: tile, empty column and `$` all take 16px.
    expect(rows.length).toBeGreaterThanOrEqual(4)
    const lefts = rows.map((r) => rectOf(byTestId(r, 'AgentRow.name')).left)
    for (const left of lefts) expect(Math.abs(left - lefts[0])).toBeLessThanOrEqual(1)
  })

  it('shows a shell as a $ glyph and its whole command, truncated only by the line', async () => {
    const rows = allByTestId(await mountPanel(600), 'AgentRow')
    const shell = rows.find((r) => r.getAttribute('data-tool-use-id') === SHELL)!
    const glyph = byTestId(shell, 'AgentRow.shellGlyph')
    // Border box: the 16px type column, like a tile.
    expect(rectOf(glyph).width).toBeCloseTo(16, 0)
    expect(rectOf(glyph).height).toBeCloseTo(16, 0)
    const name = byTestId(shell, 'AgentRow.name')
    expect(name.textContent).toBe(LONG_COMMAND)
    expect(rectOf(glyph).right).toBeLessThanOrEqual(rectOf(name).left + 1)
    // The live clock is the shell's metric: 2m 5s and counting, no tokens.
    expect(byTestId(shell, 'AgentRow.metrics').innerText).toMatch(/^2m \d+s$/)
  })

  it('labels an unnamed agent with its description, dimmer than a named one', async () => {
    const rows = allByTestId(await mountPanel(460), 'AgentRow')
    const unnamed = byTestId(
      rows.find((r) => r.getAttribute('data-tool-use-id') === UNNAMED)!,
      'AgentRow.name'
    )
    const named = byTestId(
      rows.find((r) => r.getAttribute('data-tool-use-id') === TOP)!,
      'AgentRow.name'
    )
    expect(unnamed.textContent).toBe('Plan the migration of every report')
    expect(getComputedStyle(unnamed).color).not.toBe(getComputedStyle(named).color)
  })
})

/**
 * Three rows of one roster: a custom type, the engine's default type (no tile)
 * and a cross-engine dispatch (an X). Settled running, so Stop shows.
 */
function seedTypeRows(): void {
  const description = 'Scan fixed widths in the mobile surfaces'
  const mk = (id: string, name: string, input: Record<string, unknown>, tool = 'Agent') => ({
    message: {
      id: `m-${id}`,
      role: 'assistant' as const,
      content: [{ type: 'tool_use' as const, toolUseId: id, toolName: tool, toolInput: input }],
      timestamp: 0
    },
    name
  })
  const rows = [
    mk('tu-custom', 'scan', { name: 'scan', subagent_type: 'Explore', description }),
    mk('tu-default', 'plain', { name: 'plain', subagent_type: 'general-purpose', description }),
    mk(
      'tu-dispatch',
      'dispatch',
      { engine: 'opencode', model: 'deepseek-v4', prompt: 'review it' },
      'mcp__claude-ui-collab__dispatch_agent'
    )
  ]
  useSessionStore.setState({
    activeSessionId: ROUTE,
    settings: { ...DEFAULT_SETTINGS },
    sessions: {
      [ROUTE]: {
        ...EMPTY_SESSION_STATE,
        status: { ...EMPTY_SESSION_STATE.status, engineId: 'claude' },
        messages: rows.map((r) => r.message),
        activeTasks: Object.fromEntries(
          rows.map((r) => [
            r.message.content[0].toolUseId,
            {
              taskId: `t-${r.message.id}`,
              taskType: 'local_agent',
              runIndex: 1,
              isBackgrounded: true
            }
          ])
        )
      }
    }
  })
}

describe('the type tile in the agent list (ADR-094)', () => {
  beforeEach(() => seedTypeRows())
  afterEach(() => {
    cleanup()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  const rowOf = (root: HTMLElement, toolUseId: string): HTMLElement =>
    root.querySelector<HTMLElement>(`[data-tool-use-id="${toolUseId}"]`)!

  it('shows a letter tile for a custom type, none for the default, an X for a dispatch', async () => {
    const overlay = await openOverlay(1.1)
    const custom = rowOf(overlay, 'tu-custom')
    const tile = byTestId(custom, 'AgentRow.typeTile')
    expect(tile.innerText.trim()).toBe('E')
    // The full type name for a hover and a screen reader.
    expect(tile.title).toBe('Explore')
    expect(tile.getAttribute('aria-label')).toBe('Explore')
    // The default type has nothing to say: no tile, but its 16px column is kept,
    // so the label starts where a tiled row's label does.
    const plain = rowOf(overlay, 'tu-default')
    expect(plain.querySelector('[data-testid="AgentRow.typeTile"]')).toBeNull()
    expect(rectOf(byTestId(plain, 'AgentRow.name')).left).toBeCloseTo(
      rectOf(byTestId(custom, 'AgentRow.name')).left,
      0
    )
    // A dispatch is an X, and says where it went.
    const dispatch = byTestId(rowOf(overlay, 'tu-dispatch'), 'AgentRow.typeTile')
    expect(dispatch.innerText.trim()).toBe('X')
    expect(dispatch.title).toBe('Dispatch → opencode · deepseek-v4')
  })

  it('takes the default dispatch colour, and the one in settings when set', async () => {
    const overlay = await openOverlay(1)
    const x = byTestId(rowOf(overlay, 'tu-dispatch'), 'AgentRow.typeTile')
    expect(x.getAttribute('data-color')).toBe('orange')
    cleanup()
    useSessionStore.setState((state) => ({
      settings: { ...state.settings, dispatchTileColor: 'teal' }
    }))
    const again = await openOverlay(1)
    expect(
      byTestId(rowOf(again, 'tu-dispatch'), 'AgentRow.typeTile').getAttribute('data-color')
    ).toBe('teal')
  })

  it('sits in the type column before the label, on one line, at any width', async () => {
    for (const width of [350, 600]) {
      cleanup()
      const root = await mountPanel(width, false)
      const row = rowOf(root, 'tu-custom')
      const tile = byTestId(row, 'AgentRow.typeTile')
      const name = byTestId(row, 'AgentRow.name')
      expectTileWhole(row)
      expect(Math.abs(centreY(tile) - centreY(name))).toBeLessThanOrEqual(3)
      expect(rectOf(tile).right).toBeLessThanOrEqual(rectOf(name).left + 1)
      // The label is the name the spawn gave; the description is its tooltip.
      expect(name.textContent).toBe('scan')
      expect(name.title).toBe('Scan fixed widths in the mobile surfaces')
    }
  })
})
