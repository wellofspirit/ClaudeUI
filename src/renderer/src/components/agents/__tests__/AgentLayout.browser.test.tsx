/**
 * Layer 2b: the agent roster overlay on a phone (ADR-073 §9) — real Chromium,
 * real Tailwind, the owner's S25 Ultra size, under SessionView's `zoom`.
 *
 * What a jsdom test cannot see, and what shipped broken: the overlay was
 * `min(420px, 100vw - 32px)`, which `zoom: uiFontScale` multiplies, so at 1.1 it
 * spilled 15px off a 412px screen; the row's `shrink-0` children summed past the
 * row, clipping Stop; and once nothing overflowed, the shrink weights left a name
 * of one character and a badge of "g." — contained, but unreadable. So these
 * assert READABILITY (a name floor, a whole type tile, a description that shows),
 * not just containment. The type is a 16px letter tile (ADR-094) that leads
 * line 2 when narrow and sits before the description when wide; the fixtures
 * use NON-default types, because the engine's default type has no tile.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
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

/** The scales the roster is checked at: the profile's, plus 1.25 (a common setting). */
const SCALES = [...FONT_SCALES, 1.25].sort((a, b) => a - b)

function spawn(id: string, toolUseId: string, input: Record<string, unknown>): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'tool_use', toolUseId, toolName: 'Agent', toolInput: input }],
    timestamp: 0
  }
}

/** The worst row the roster has to draw: every element present, every one long. */
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
            })
          ]
        },
        activeTasks: {
          [TOP]: { taskId: 't-top', taskType: 'local_agent', runIndex, isBackgrounded: true },
          [NESTED]: {
            taskId: 't-nested',
            taskType: 'local_agent',
            runIndex: 1,
            isBackgrounded: true
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

const centreY = (el: HTMLElement): number => rectOf(el).top + rectOf(el).height / 2

/** The name is readable: at least its floor (4.5rem), or all of it if it is shorter. */
function expectNameReadable(row: HTMLElement): void {
  const name = byTestId(row, 'AgentRow.name')
  const floor = 4.5 * parseFloat(getComputedStyle(document.documentElement).fontSize)
  // Local (zoomed) px on both sides: scrollWidth is the whole text, clientWidth what shows.
  expect(name.clientWidth).toBeGreaterThanOrEqual(Math.min(name.scrollWidth, floor) - 1)
}

/** The tile shows whole, a 16px square: a clipped letter is a broken tile. */
function expectTileWhole(row: HTMLElement): void {
  const tile = byTestId(row, 'AgentRow.typeTile')
  expect(tile.scrollWidth).toBeLessThanOrEqual(tile.clientWidth + 1)
  expect(tile.clientHeight).toBe(16)
  expect(tile.clientWidth).toBeGreaterThanOrEqual(16)
  expect(tile.innerText.trim()).toMatch(/^[A-Z0-9]$/)
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

      it('lays every row out on two lines, readable and unclipped', async () => {
        const overlay = await openOverlay(scale)
        const rows = allByTestId(overlay, 'AgentRow')
        expect(rows).toHaveLength(2)
        for (const row of rows) {
          expect(hasNoHorizontalOverflow(row)).toBe(true)

          const name = byTestId(row, 'AgentRow.name')
          const tile = byTestId(row, 'AgentRow.typeTile')
          const description = byTestId(row, 'AgentRow.description')
          const metrics = byTestId(row, 'AgentRow.metrics')
          const stop = byTestId(row, 'AgentRow.stop')
          const resumed = row.querySelector<HTMLElement>('[data-testid="AgentRow.resumed"]')

          // Everything the row draws lies inside the row.
          for (const el of [name, tile, description, metrics, stop, resumed]) {
            if (el) expect(isInside(el, row)).toBe(true)
          }
          // One line each: a chip or button that wraps is the bug.
          for (const el of [name, metrics, stop, resumed]) {
            if (el) expect(isOneLine(el)).toBe(true)
          }
          // Readable, not just contained.
          expectNameReadable(row)
          expectTileWhole(row)
          expect(rectOf(description).width).toBeGreaterThanOrEqual(40)

          // Two lines: the tile and the description sit BELOW the name; metrics share its line.
          expect(rectOf(description).top).toBeGreaterThanOrEqual(rectOf(name).bottom - 1)
          expect(rectOf(tile).top).toBeGreaterThanOrEqual(rectOf(name).bottom - 1)
          // The tile LEADS line 2: before the description, on its line.
          expect(rectOf(tile).right).toBeLessThanOrEqual(rectOf(description).left + 1)
          expect(Math.abs(centreY(tile) - centreY(description))).toBeLessThanOrEqual(2)
          expect(rectOf(tile).left).toBeLessThanOrEqual(rectOf(name).left + 1)
          expect(Math.abs(rectOf(metrics).top - rectOf(name).top)).toBeLessThan(rectOf(name).height)

          // Stop is vertically centred on the row.
          const stopMid = rectOf(stop).top + rectOf(stop).height / 2
          const rowMid = rectOf(row).top + rectOf(row).height / 2
          expect(Math.abs(stopMid - rowMid)).toBeLessThanOrEqual(1)
        }
      })

      it('drops the current tool from the metrics under 400px and shows the full tokens', async () => {
        const overlay = await openOverlay(scale)
        const roster = byTestId(overlay, 'AgentRoster')
        // Every phone list is under 400px (394px at 1, 356px at 1.1, 256px at 1.5).
        expect(roster.clientWidth).toBeLessThan(400)
        for (const row of allByTestId(overlay, 'AgentRow')) {
          const metrics = byTestId(row, 'AgentRow.metrics')
          // innerText skips display:none; textContent would still hold the tool.
          expect(metrics.innerText).not.toContain('Bash')
          // The clock and the WHOLE token count: "8720.9k", not "872…". Up to 1.1,
          // where the list is 350px+. Beyond it the worst row (20-character name,
          // resumed chip) leaves 77px (1.25) and 49px (1.5) of the 96px the full
          // metrics need, so there they truncate to the 3rem floor.
          expect(metrics.innerText).toMatch(/\d+[ms]/)
          if (scale <= 1.1) {
            expect(metrics.innerText).toContain('8720.9k')
            expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1)
          }
        }
      })

      it('keeps the nested row tree elbow meeting its status dot', async () => {
        const overlay = await openOverlay(scale)
        const nested = allByTestId(overlay, 'AgentRow').find(
          (r) => r.getAttribute('data-depth') === '1'
        )!
        const dot = byTestId(nested, 'AgentRow.status')
        const elbow = byTestId(nested, 'AgentRow.elbow')
        const dotMid = rectOf(dot).top + rectOf(dot).height / 2
        expect(Math.abs(rectOf(elbow).bottom - dotMid)).toBeLessThanOrEqual(1)
      })
    })
  }

  // A long name must not squeeze the clock and the tokens out: the metrics keep a
  // 3rem floor, and the name (4.5rem floor) truncates first beyond that.
  for (const scale of FONT_SCALES) {
    it(`keeps the metrics and the name readable with a 43-character name (uiFontScale ${scale})`, async () => {
      cleanup()
      seedWorstCaseRoster('a-very-long-agent-name-of-forty-three-chars', 2, 'b'.repeat(43))
      const overlay = await openOverlay(scale)
      for (const row of allByTestId(overlay, 'AgentRow')) {
        expect(hasNoHorizontalOverflow(row)).toBe(true)
        const metrics = byTestId(row, 'AgentRow.metrics')
        // Local (zoomed) px, like the floor itself: 3rem = 48.
        expect(metrics.clientWidth).toBeGreaterThanOrEqual(Math.min(metrics.scrollWidth, 48) - 1)
        expectNameReadable(row)
        for (const id of ['AgentRow.name', 'AgentRow.metrics', 'AgentRow.stop']) {
          expect(isInside(byTestId(row, id), row)).toBe(true)
        }
      }
    })
  }

  it('is two lines in the 420px desktop overlay too, and readable', async () => {
    // A wide composer, so the overlay is its full 420px.
    const overlay = await openOverlay(1, '700px')
    expect(rectOf(overlay).width).toBeCloseTo(420, 0)
    expect(rectOf(byTestId(overlay, 'AgentRoster')).width).toBeLessThan(480)
    for (const row of allByTestId(overlay, 'AgentRow')) {
      const name = byTestId(row, 'AgentRow.name')
      const description = byTestId(row, 'AgentRow.description')
      expect(rectOf(description).top).toBeGreaterThanOrEqual(rectOf(name).bottom - 1)
      expect(hasNoHorizontalOverflow(row)).toBe(true)
      for (const id of [
        'AgentRow.name',
        'AgentRow.typeTile',
        'AgentRow.metrics',
        'AgentRow.stop'
      ]) {
        expect(isInside(byTestId(row, id), row)).toBe(true)
      }
      // The 1-character name and "g." badge this replaced.
      expectNameReadable(row)
      expectTileWhole(row)
      // Line 2 leads with the tile.
      expect(rectOf(byTestId(row, 'AgentRow.typeTile')).right).toBeLessThanOrEqual(
        rectOf(description).left + 1
      )
      expect(rectOf(description).width).toBeGreaterThanOrEqual(40)
      // 420px is not under 400px: the tool name stays, and so do the whole tokens.
      const metrics = byTestId(row, 'AgentRow.metrics')
      expect(metrics.innerText).toContain('Bash')
      expect(metrics.innerText).toContain('8720.9k')
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1)
    }
  })

  describe('in a 520px panel (wide: one line)', () => {
    async function mountPanel(): Promise<HTMLElement> {
      const view = render(
        <ZoomFrame scale={1} width="520px">
          <PanelRoster />
        </ZoomFrame>
      )
      await settle()
      expect(rectOf(byTestId(view.container, 'AgentRoster')).width).toBeGreaterThanOrEqual(480)
      return view.container
    }

    it('keeps a 12-character name and the tile whole on one line', async () => {
      cleanup()
      seedWorstCaseRoster('abcdefghijkl', 1, 'nested-agent')
      for (const row of allByTestId(await mountPanel(), 'AgentRow')) {
        const name = byTestId(row, 'AgentRow.name')
        const tile = byTestId(row, 'AgentRow.typeTile')
        const description = byTestId(row, 'AgentRow.description')
        // One line: the tile and the description share the name's line, the tile
        // between them (where the badge was).
        expect(Math.abs(rectOf(description).top - rectOf(name).top)).toBeLessThan(
          rectOf(name).height
        )
        expect(Math.abs(centreY(tile) - centreY(name))).toBeLessThanOrEqual(3)
        expect(rectOf(tile).left).toBeGreaterThanOrEqual(rectOf(name).right - 1)
        expect(rectOf(tile).right).toBeLessThanOrEqual(rectOf(description).left + 1)
        expect(hasNoHorizontalOverflow(row)).toBe(true)
        for (const id of [
          'AgentRow.name',
          'AgentRow.typeTile',
          'AgentRow.metrics',
          'AgentRow.stop'
        ]) {
          expect(isInside(byTestId(row, id), row)).toBe(true)
        }
        // Readable: neither the name nor the tile is truncated.
        expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth + 1)
        expectTileWhole(row)
        expect(rectOf(description).width).toBeGreaterThanOrEqual(40)
        expect(isOneLine(byTestId(row, 'AgentRow.stop'))).toBe(true)
      }
    })

    it('stays inside the row and keeps the name floor when a resumed chip crowds it', async () => {
      cleanup()
      seedWorstCaseRoster('abcdefghijkl', 2, 'nested-agent')
      for (const row of allByTestId(await mountPanel(), 'AgentRow')) {
        expect(hasNoHorizontalOverflow(row)).toBe(true)
        for (const id of ['AgentRow.name', 'AgentRow.metrics', 'AgentRow.stop']) {
          expect(isInside(byTestId(row, id), row)).toBe(true)
        }
        expectNameReadable(row)
        expect(rectOf(byTestId(row, 'AgentRow.description')).width).toBeGreaterThanOrEqual(40)
      }
    })
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
    // The default type has nothing to say: no tile, and the description leads line 2.
    const plain = rowOf(overlay, 'tu-default')
    expect(plain.querySelector('[data-testid="AgentRow.typeTile"]')).toBeNull()
    expect(rectOf(byTestId(plain, 'AgentRow.description')).left).toBeLessThanOrEqual(
      rectOf(byTestId(plain, 'AgentRow.name')).left + 1
    )
    // A dispatch is an X, and says where it went.
    const dispatch = byTestId(rowOf(overlay, 'tu-dispatch'), 'AgentRow.typeTile')
    expect(dispatch.innerText.trim()).toBe('X')
    expect(dispatch.title).toBe('Dispatch \u2192 opencode \u00b7 deepseek-v4')
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

  it('leads line 2 on a phone and sits before the description when wide', async () => {
    const narrow = await openOverlay(1.1)
    const nRow = rowOf(narrow, 'tu-custom')
    const nTile = byTestId(nRow, 'AgentRow.typeTile')
    expect(rectOf(nTile).top).toBeGreaterThanOrEqual(
      rectOf(byTestId(nRow, 'AgentRow.name')).bottom - 1
    )
    expect(rectOf(nTile).right).toBeLessThanOrEqual(
      rectOf(byTestId(nRow, 'AgentRow.description')).left + 1
    )
    cleanup()
    const view = render(
      <ZoomFrame scale={1} width="520px">
        <PanelRoster />
      </ZoomFrame>
    )
    await settle()
    const wRow = rowOf(view.container, 'tu-custom')
    const wTile = byTestId(wRow, 'AgentRow.typeTile')
    const wName = byTestId(wRow, 'AgentRow.name')
    // One line, in the badge's old place: after the name, before the description.
    expect(Math.abs(centreY(wTile) - centreY(wName))).toBeLessThanOrEqual(3)
    expect(rectOf(wTile).left).toBeGreaterThanOrEqual(rectOf(wName).right - 1)
    expect(rectOf(wTile).right).toBeLessThanOrEqual(
      rectOf(byTestId(wRow, 'AgentRow.description')).left + 1
    )
  })
})
