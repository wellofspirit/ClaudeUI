/**
 * Layer 2b: the Task card on a phone — real Chromium, real Tailwind, the owner's
 * S25 Ultra size, under SessionView's `zoom` (docs/testing-strategy.md).
 *
 * What a jsdom test cannot see, and what shipped broken: the review chip
 * squeezed the header's description to 0px, footer chips broke mid-token
 * (`general-purpose`), and "Open in panel" went one word per line. Containment
 * alone let worse through (a model chip of "D.", a header wrapped onto two
 * rows), so these also assert READABILITY: a floor on the model, one-row headers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import {
  useSessionStore,
  EMPTY_SESSION_STATE,
  DEFAULT_SETTINGS
} from '../../../stores/session-store'
import type { ContentBlock, ModelInfo, ToolReviewBlock } from '../../../../../shared/types'
import {
  FONT_SCALES,
  PROFILE,
  LayoutChatList,
  byTestId,
  hasNoHorizontalOverflow,
  isInside,
  isOneLine,
  rectOf,
  rowCount,
  settle,
  visibleChildren
} from '@test/helpers/mobile-layout'

vi.mock('../MarkdownRenderer', () => ({
  MarkdownRenderer: (p: { content: string }) => <div>{p.content}</div>
}))

import { TaskCard } from '../TaskCard'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>

const ROUTE = 'route-taskcard-layout'
const TOOL_USE_ID = 'tu-task-layout'
const RAW_MODEL = 'openrouter/deepseek/deepseek-v4.1-flash'
const DESCRIPTION = 'Review the m13-a2 controllers against the migration spec'

const block = {
  type: 'tool_use',
  toolUseId: TOOL_USE_ID,
  toolName: 'subagent',
  toolInput: {}
} as ToolUseBlock

const view = {
  kind: 'task' as const,
  description: DESCRIPTION,
  prompt: 'Read every controller in the batch and report schema drift.',
  subagent: 'general-purpose',
  model: RAW_MODEL,
  background: true
}

const result = {
  type: 'tool_result' as const,
  toolUseId: TOOL_USE_ID,
  toolResult:
    'Async agent launched successfully.\n<usage>\ntotal_tokens: 8720900\ntool_uses: 12\nduration_ms: 135000\n</usage>',
  isError: false
}

const review: ToolReviewBlock = {
  type: 'tool_review',
  toolUseId: TOOL_USE_ID,
  reviewId: 'r1',
  reviewer: 'auto-mode',
  decision: 'approved'
}

const DEEPSEEK: ModelInfo = {
  value: RAW_MODEL,
  displayName: 'DeepSeek V4.1 Flash',
  description: '',
  engineId: 'pi'
}

/** A running pi task card; `models` is what the picker's allowlist-filtered list holds. */
function seed(
  models: ModelInfo[],
  opts: {
    runIndex?: number
    engineId?: 'pi' | 'claude'
    running?: boolean
    /** A running FOREGROUND task, on an engine that can background: Send to background. */
    foreground?: boolean
  } = {}
): void {
  useSessionStore.setState({
    activeSessionId: ROUTE,
    settings: { ...DEFAULT_SETTINGS },
    availableModels: models,
    sessions: {
      [ROUTE]: {
        ...EMPTY_SESSION_STATE,
        status: {
          ...EMPTY_SESSION_STATE.status,
          engineId: opts.engineId ?? 'pi',
          capabilities: {
            ...EMPTY_SESSION_STATE.status.capabilities,
            backgroundTasks: !!opts.foreground
          }
        },
        activeTasks:
          opts.running === false
            ? {}
            : {
                [TOOL_USE_ID]: {
                  taskId: 'task-1',
                  taskType: 'local_agent',
                  runIndex: opts.runIndex ?? 1,
                  isBackgrounded: !opts.foreground,
                  startedAt: Date.now() - 135_000
                }
              }
      }
    }
  })
}

async function mountCard(
  chatScale: number,
  opts: {
    width?: string
    expanded?: boolean
    model?: string
    review?: ToolReviewBlock
    result?: typeof result | null
    withoutReview?: boolean
    view?: typeof view
  } = {}
) {
  const view_ = render(
    <LayoutChatList chatScale={chatScale} width={opts.width}>
      <TaskCard
        block={block}
        result={opts.result === null ? undefined : (opts.result ?? result)}
        view={{ ...(opts.view ?? view), ...(opts.model ? { model: opts.model } : {}) }}
        review={opts.withoutReview ? undefined : (opts.review ?? review)}
      />
    </LayoutChatList>
  )
  await settle()
  const card = byTestId(view_.container, 'TaskCard')
  if (opts.expanded) {
    byTestId(card, 'TaskCard.expand').click()
    await settle()
  }
  return card
}

/** The footer row is the one holding "Open in panel". */
function footerOf(card: HTMLElement, expanded: boolean): HTMLElement {
  return byTestId(card, expanded ? 'TaskCard.expanded.openInPanel' : 'TaskCard.openInPanel')
    .parentElement!
}

function headerDescription(card: HTMLElement): HTMLElement {
  const header = byTestId(card, 'TaskCard.expand')
  return Array.from(header.querySelectorAll<HTMLElement>('span')).find(
    (el) => el.textContent === DESCRIPTION
  )!
}

/** The CHAT font scales the card is checked at: the profile's, plus 1.25 (a common setting). */
const SCALES = [...FONT_SCALES, 1.25].sort((a, b) => a - b)

/** The model chip's floor (5rem), in the card's own (zoomed) px. */
const MODEL_FLOOR = 5 * 16

function openButton(card: HTMLElement, expanded: boolean): HTMLElement {
  return byTestId(card, expanded ? 'TaskCard.expanded.openInPanel' : 'TaskCard.openInPanel')
}

/** The header's children that are on screen: the ones that must share ONE row. */
function headerKids(card: HTMLElement): Element[] {
  return visibleChildren(byTestId(card, 'TaskCard.expand'))
}

/** The model chip reads: at least its floor, or all of its text if that is shorter. */
function expectModelReadable(chip: HTMLElement): void {
  expect(chip.clientWidth).toBeGreaterThanOrEqual(Math.min(chip.scrollWidth, MODEL_FLOOR) - 1)
}

/** The footer's chips are whole and on one line each; nothing sticks out. */
function expectFooterSound(footer: HTMLElement): void {
  expect(hasNoHorizontalOverflow(footer)).toBe(true)
  for (const child of visibleChildren(footer)) {
    expect(isInside(child, footer)).toBe(true)
    expect(isOneLine(child)).toBe(true)
  }
  const whole = Array.from(footer.querySelectorAll<HTMLElement>('span, button')).filter((el) =>
    ['general-purpose', 'background', 'resumed ×1'].includes(el.textContent ?? '')
  )
  for (const chip of whole) expect(chip.scrollWidth).toBeLessThanOrEqual(chip.clientWidth + 1)
}

describe('Task card on the phone', () => {
  beforeEach(() => seed([DEEPSEEK]))
  afterEach(() => {
    cleanup()
    useSessionStore.setState({ activeSessionId: null, sessions: {}, availableModels: [] })
  })

  for (const chatScale of SCALES) {
    for (const expanded of [false, true]) {
      describe(`chatFontScale ${chatScale}, ${expanded ? 'expanded' : 'collapsed'}`, () => {
        it('keeps the header on ONE row, readable and unclipped', async () => {
          expect(window.innerWidth).toBe(PROFILE.width)
          const card = await mountCard(chatScale, { expanded })
          // The container chain is the real one: (412 - mr-2 - the 7px classic
          // scrollbar) / chat zoom, less the column's px-3 and the tool group's p-2 +
          // border. The real app measured 354.4, 318.5, 275.5 and 222.9 CSS px at chat
          // 1, 1.1, 1.25 and 1.5. If this drifts, the widths every assertion below
          // depends on are not the app's.
          expect(
            Math.abs(card.offsetWidth - ((PROFILE.width - 8 - 7) / chatScale - 42))
          ).toBeLessThan(1)
          const header = byTestId(card, 'TaskCard.expand')
          // The review chip AND Stop are both there: the case that wrapped.
          expect(byTestId(card, 'TaskCard.reviewChip')).toBeTruthy()
          expect(byTestId(card, 'TaskCard.stop')).toBeTruthy()

          // One row: every visible child's centre is within 2px, and the bar is h-9.
          expect(rowCount(headerKids(card), 2)).toBe(1)
          expect(rectOf(header).height / chatScale).toBeCloseTo(36, 0)
          expect(hasNoHorizontalOverflow(header)).toBe(true)
          expect(isInside(card, document.body)).toBe(true)
          for (const child of headerKids(card)) expect(isInside(child, header)).toBe(true)

          // 3rem floor: the review chip used to take all of it.
          const description = headerDescription(card)
          const minWidth = parseFloat(getComputedStyle(description).minWidth)
          // 3rem, or 2rem under 300px of card (the blocked case below needs it).
          expect(minWidth).toBe(card.clientWidth < 300 ? 32 : 48)
          expect(rectOf(description).width).toBeGreaterThanOrEqual(minWidth * chatScale - 1)

          // What is shed, below 480px: the word "Task" and the reviewer prefix.
          expect(header.innerText).not.toMatch(/\bTask\b/)
          const chip = byTestId(card, 'TaskCard.reviewChip')
          expect(chip.innerText.trim()).toBe('allowed')
          // The full text is still there for assistive tech and search.
          expect(chip.textContent).toContain('Auto mode · allowed')

          // The clock goes only under 300px of card: 1.25 (about 280px) and 1.5
          // (about 225px) in the real chat chain, not 1.0 or 1.1.
          const clock = byTestId(card, 'TaskCard.elapsed')
          const cardWidth = card.clientWidth
          expect(cardWidth < 300).toBe(chatScale >= 1.25)
          expect(clock.getClientRects().length > 0).toBe(cardWidth >= 300)
          if (chatScale === 1) expect(header.innerText).toContain('2m 15s')
          if (chatScale === 1.5) expect(header.innerText).not.toContain('2m 15s')
        })

        it('keeps the common footer whole, the model readable, and Open in panel an icon', async () => {
          const card = await mountCard(chatScale, { expanded })
          const footer = footerOf(card, expanded)
          expectFooterSound(footer)
          expectModelReadable(byTestId(footer, 'TaskCard.model'))
          expect(footer.innerText).not.toContain('tokens')

          // One line wherever the chips fit (1.0, 1.1), else WHOLE chips wrap — the
          // icon stays last, at the right of its line.
          const kids = visibleChildren(footer)
          const rows = rowCount(kids)
          expect(rows).toBe(chatScale <= 1.1 ? 1 : 2)

          const open = openButton(card, expanded)
          expect(open.getAttribute('aria-label')).toBe('Open in panel')
          expect(open.title).toBe('Open in panel')
          expect(open.innerText.trim()).toBe('') // the words are display:none
          const icon = byTestId(open, 'TaskCard.openInPanel.icon')
          expect(icon.getClientRects().length).toBeGreaterThan(0)
          expect(kids[kids.length - 1]).toBe(open)
          const gap = rectOf(footer).right - 12 * chatScale - rectOf(open).right
          expect(Math.abs(gap)).toBeLessThan(2)
        })

        it('survives a resumed chip: nothing overflows, nothing breaks mid-token', async () => {
          cleanup()
          seed([DEEPSEEK], { runIndex: 2 })
          const card = await mountCard(chatScale, { expanded })
          const footer = footerOf(card, expanded)
          expectFooterSound(footer)
          expectModelReadable(byTestId(footer, 'TaskCard.model'))
          expect(byTestId(footer, 'TaskCard.resumed').textContent).toBe('resumed ×1')
        })
      })
    }
  }

  it('shows the catalog name in the sans font when the store has the model', async () => {
    const card = await mountCard(1)
    const chip = byTestId(card, 'TaskCard.model')
    expect(chip.textContent).toBe('DeepSeek V4.1 Flash')
    expect(chip.title).toBe(RAW_MODEL)
    expect(getComputedStyle(chip).fontFamily).not.toMatch(/mono/i)
  })

  it('shows the raw id in mono, truncated into the leftover space, when the store does not', async () => {
    cleanup()
    seed([])
    for (const chatScale of SCALES) {
      const card = await mountCard(chatScale)
      const chip = byTestId(card, 'TaskCard.model')
      expect(chip.textContent).toBe(RAW_MODEL)
      expect(chip.title).toBe(RAW_MODEL)
      expect(getComputedStyle(chip).fontFamily).toMatch(/mono/i)
      // It is the chip that gives way — and it still reads (floor). It takes the
      // leftover space of its line, but cannot claim a line of its own: the
      // footer is as many rows as without the long id.
      expect(chip.scrollWidth).toBeGreaterThan(chip.clientWidth)
      expectModelReadable(chip)
      const footer = footerOf(card, false)
      expectFooterSound(footer)
      expect(rowCount(visibleChildren(footer))).toBe(chatScale <= 1.1 ? 1 : 2)
      cleanup()
      seed([])
    }
  })

  // A short label is already narrower than the 5rem floor: padding it out to the
  // floor leaves blank space after "opus" (the floor is only for long names).
  for (const label of ['opus', 'sonnet']) {
    for (const [chatScale, width] of [
      [1, '610px'],
      [1, undefined],
      [1.5, undefined]
    ] as const) {
      it(`keeps "${label}" at its natural width (chat ${chatScale}, ${width ? 'wide' : 'narrow'})`, async () => {
        cleanup()
        seed([], { engineId: 'claude' })
        const card = await mountCard(chatScale, { width, model: label })
        const chip = byTestId(card, 'TaskCard.model')
        expect(chip.textContent).toBe(label)
        expect(getComputedStyle(chip).fontFamily).toMatch(/mono/i)
        expect(chip.scrollWidth).toBeLessThanOrEqual(chip.clientWidth + 1)
        // Narrower than the floor, in page px: no blank space.
        expect(rectOf(chip).width).toBeLessThan(5 * 16 * chatScale)
        expect(chip.offsetWidth).toBeLessThan(60)
        expectFooterSound(footerOf(card, false))
      })
    }
  }

  // An auto-mode BLOCK carries the most in the header: the chip, the compact
  // Approve (canApproveBlock: live session, no pending card, not yet overridden),
  // the clock, Stop and the chevron. At the largest chat scale that does not fit
  // beside a 3rem description, so the floor drops to 2rem under 300px.
  // Send to background: a running FOREGROUND task on an engine that can background
  // it. Words wide, a tray icon below 480px; the header must still be one row.
  describe('a running foreground task (Send to background)', () => {
    const foregroundView = { ...view, background: false }
    for (const chatScale of SCALES) {
      for (const withReview of [false, true]) {
        it(`keeps the header on one row (chatFontScale ${chatScale}, ${withReview ? 'with' : 'without'} a review chip)`, async () => {
          cleanup()
          seed([DEEPSEEK], { foreground: true })
          const card = await mountCard(chatScale, {
            result: null,
            view: foregroundView,
            withoutReview: !withReview
          })
          const header = byTestId(card, 'TaskCard.expand')
          const send = byTestId(card, 'TaskCard.sendToBackground')
          expect(send.getAttribute('aria-label')).toBe('Send to background')
          expect(send.title).toBe('Send to background')
          // The icon, not the words, below 480px.
          expect(send.innerText.trim()).toBe('')
          expect(
            byTestId(send, 'TaskCard.sendToBackground.icon').getClientRects().length
          ).toBeGreaterThan(0)
          expect(hasNoHorizontalOverflow(header)).toBe(true)
          expect(rowCount(headerKids(card), 2)).toBe(1)
          for (const id of ['TaskCard.sendToBackground', 'TaskCard.stop']) {
            expect(isInside(byTestId(card, id), header)).toBe(true)
          }
          for (const child of headerKids(card)) expect(isInside(child, header)).toBe(true)
          expect(rectOf(headerDescription(card)).width).toBeGreaterThanOrEqual(32 * chatScale - 1)
        })
      }
    }

    it('keeps the words when the card is wide', async () => {
      cleanup()
      seed([DEEPSEEK], { foreground: true })
      const card = await mountCard(1, { width: '610px', result: null, view: foregroundView })
      const send = byTestId(card, 'TaskCard.sendToBackground')
      expect(send.innerText.trim()).toBe('Send to background')
      expect(byTestId(send, 'TaskCard.sendToBackground.icon').getClientRects().length).toBe(0)
      expect(rowCount(headerKids(card), 2)).toBe(1)
    })
  })

  describe('a blocked review (chip + Approve)', () => {
    // A blocked delegation did not run: finished, an error result, no Stop. (With
    // Stop as well it needs ~44px more than any phone card has at chat 1.5.)
    const blocked: ToolReviewBlock = { ...review, decision: 'denied' }
    const blockedResult = {
      ...result,
      toolResult: `Auto mode blocked: Git Destructive
<usage>
total_tokens: 10
tool_uses: 1
duration_ms: 135000
</usage>`,
      isError: true
    }
    const blockedView = { ...view, background: false }
    for (const chatScale of SCALES) {
      it(`keeps the header on one row, unclipped (chatFontScale ${chatScale})`, async () => {
        cleanup()
        seed([DEEPSEEK], { running: false })
        const card = await mountCard(chatScale, {
          review: blocked,
          result: blockedResult,
          view: blockedView
        })
        const header = byTestId(card, 'TaskCard.expand')
        // The compact Approve really rendered, or this proves nothing.
        expect(byTestId(card, 'ToolReview.approveCompact')).toBeTruthy()
        expect(byTestId(card, 'TaskCard.reviewChip').innerText.trim()).toBe('blocked')
        expect(card.querySelector('[data-testid="TaskCard.stop"]')).toBeNull()
        expect(hasNoHorizontalOverflow(header)).toBe(true)
        expect(rowCount(headerKids(card), 2)).toBe(1)
        for (const child of headerKids(card)) expect(isInside(child, header)).toBe(true)
        // The description keeps its floor: 3rem, or 2rem under 300px.
        const description = headerDescription(card)
        const floor = card.clientWidth < 300 ? 32 : 48
        expect(parseFloat(getComputedStyle(description).minWidth)).toBe(floor)
        expect(rectOf(description).width).toBeGreaterThanOrEqual(floor * chatScale - 1)
      })
    }
  })

  it('does not resolve a name from another engine’s catalog', async () => {
    cleanup()
    seed([{ ...DEEPSEEK, engineId: 'opencode' }])
    const card = await mountCard(1)
    expect(byTestId(card, 'TaskCard.model').textContent).toBe(RAW_MODEL)
  })

  describe('at 480px and wider', () => {
    it('keeps the word Task, the reviewer prefix, the usage and the words', async () => {
      const card = await mountCard(1, { width: '610px' })
      expect(rectOf(card).width).toBeGreaterThanOrEqual(480)
      const header = byTestId(card, 'TaskCard.expand')
      expect(header.innerText).toMatch(/\bTask\b/)
      expect(header.innerText).toContain('2m 15s')
      expect(rowCount(headerKids(card), 2)).toBe(1)
      expect(byTestId(card, 'TaskCard.reviewChip').innerText.trim()).toBe('Auto mode · allowed')
      const footer = footerOf(card, false)
      expect(footer.innerText).toContain('8720.9k tokens · 12 tools · 2m 15s')
      // The words, not the icon.
      const open = openButton(card, false)
      expect(open.innerText.trim()).toBe('Open in panel')
      expect(byTestId(open, 'TaskCard.openInPanel.icon').getClientRects().length).toBe(0)
      expect(rowCount(visibleChildren(footer))).toBe(1)
      expectFooterSound(footer)
    })

    // Just above the breakpoint the footer does not wrap, so the chips that must
    // not shrink are the only thing standing between "general-purpose" and a
    // mid-token break. The raw model id and the usage text are what give way.
    for (const expanded of [false, true]) {
      it(`keeps the chips whole under pressure (${expanded ? 'expanded' : 'collapsed'})`, async () => {
        cleanup()
        seed([], { runIndex: 2 })
        const card = await mountCard(1, { width: '541px', expanded })
        expect(rectOf(card).width).toBeGreaterThanOrEqual(480)
        const footer = footerOf(card, expanded)
        expectFooterSound(footer)
        expectModelReadable(byTestId(footer, 'TaskCard.model'))
        const chips = (Array.from(footer.children) as HTMLElement[]).filter((el) =>
          ['general-purpose', 'background', 'resumed ×1', 'Open in panel'].includes(
            el.textContent ?? ''
          )
        )
        expect(chips.map((c) => c.textContent)).toEqual([
          'general-purpose',
          'background',
          'resumed ×1',
          'Open in panel'
        ])
      })
    }
  })
})
