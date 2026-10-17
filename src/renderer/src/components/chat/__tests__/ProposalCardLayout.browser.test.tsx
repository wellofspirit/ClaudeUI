/**
 * Layer 2b: the proposal card, on the phone and on a desktop-width column — real
 * Chromium, real Tailwind, the owner's S25 Ultra size, under the app's
 * `uiFontScale` zoom (docs/testing-strategy.md).
 *
 * What jsdom cannot see: the card carries the longest strings in the transcript (a
 * title, an unbroken path, a multi-line brief), so it has to wrap inside the
 * column rather than push the page sideways, and Start / Dismiss have to stay
 * finger-sized targets inside the card in every state that shows them.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { cleanup, render } from '@testing-library/react'
import { ProposalCardView } from '../ProposalCard'
import type {
  ProposalDisplayState,
  ProposalPlacement
} from '../../../../../shared/session-proposals'
import {
  FONT_SCALES,
  PROFILE,
  ZoomFrame,
  byTestId,
  hasNoHorizontalOverflow,
  isInside,
  isInsideViewportX,
  rectOf,
  settle
} from '@test/helpers/mobile-layout'

const LONG = 'a-rather-long-proposal-title-that-keeps-going-and-going-and-going-past-the-edge'
const LONG_PATH =
  '/work/an-unbroken-path-segment-without-any-spaces-at-all-that-would-push-the-card-sideways/and/more'
const PLACEMENT: ProposalPlacement = {
  engine: 'codex',
  model: 'a-very-long-model-name-from-a-custom-endpoint-config-1234567890',
  effort: 'high',
  permission_mode: 'acceptEdits',
  cwd: LONG_PATH,
  worktree: 'queue-fix',
  outside: true
}
const BRIEF =
  'Find out why tests/queue.spec.ts is flaky on CI only and fix it. Done means twenty green runs in a row.\n' +
  'Check the drain() race first; do not touch the public API.'

function noop(): void {}

afterEach(async () => {
  cleanup()
  await page.viewport(PROFILE.width, 900)
})

function mount(
  state: ProposalDisplayState,
  scale: number,
  extra: { error?: string; reason?: string } = {}
): HTMLElement {
  const now = Date.now()
  return render(
    <ZoomFrame scale={scale}>
      <div style={{ padding: '0 12px' }}>
        <ProposalCardView
          proposalId="p-0a1b2c3d"
          title={LONG}
          prompt={BRIEF}
          background={BRIEF.repeat(3)}
          placement={PLACEMENT}
          parentCwd="/work/demo"
          state={state}
          reason={extra.reason}
          expiresAt={now + 6 * 86_400_000}
          now={now}
          error={extra.error}
          onStart={noop}
          onDismiss={noop}
          onOpen={noop}
        />
      </div>
    </ZoomFrame>
  ).container
}

describe('the proposal card, on the phone', () => {
  for (const scale of FONT_SCALES) {
    it(`uiFontScale ${scale}: pending with the brief open and an error: everything wraps inside the card, Start and Dismiss are 32 px targets`, async () => {
      expect(window.innerWidth).toBe(PROFILE.width)
      const root = mount('pending', scale, {
        error: 'Could not start the session: Model "a-model-that-is-not-allowed" is not allowed'
      })
      await settle()
      await userEvent.click(byTestId(root, 'ProposalCard.toggleDetails'))
      await settle()
      const card = byTestId(root, 'ProposalCard')
      expect(isInsideViewportX(card)).toBe(true)
      expect(hasNoHorizontalOverflow(card)).toBe(true)
      for (const id of [
        'ProposalCard.title',
        'ProposalCard.state',
        'ProposalCard.placement',
        'ProposalCard.outside',
        'ProposalCard.prompt',
        'ProposalCard.background',
        'ProposalCard.error',
        'ProposalCard.start',
        'ProposalCard.dismiss'
      ]) {
        const el = byTestId(root, id)
        expect(isInside(el, card), id).toBe(true)
        expect(isInsideViewportX(el), id).toBe(true)
      }
      for (const id of [
        'ProposalCard.start',
        'ProposalCard.dismiss',
        'ProposalCard.toggleDetails'
      ]) {
        expect(rectOf(byTestId(root, id)).height, id).toBeGreaterThanOrEqual(32 * scale - 1)
      }
    })

    it(`uiFontScale ${scale}: started shows Open as a 32 px target inside the card`, async () => {
      const root = mount('started', scale)
      await settle()
      const card = byTestId(root, 'ProposalCard')
      const open = byTestId(root, 'ProposalCard.open')
      expect(isInside(open, card)).toBe(true)
      expect(isInsideViewportX(open)).toBe(true)
      expect(rectOf(open).height).toBeGreaterThanOrEqual(32 * scale - 1)
      expect(hasNoHorizontalOverflow(card)).toBe(true)
    })

    it(`uiFontScale ${scale}: a settled card has no buttons and still fits`, async () => {
      for (const state of ['dismissed', 'expired'] as const) {
        const root = mount(state, scale, {
          reason: state === 'dismissed' ? 'agent: no longer needed' : 'expired'
        })
        await settle()
        expect(root.querySelector('[data-testid="ProposalCard.start"]')).toBeNull()
        expect(hasNoHorizontalOverflow(byTestId(root, 'ProposalCard'))).toBe(true)
        cleanup()
      }
    })
  }
})

describe('the proposal card, on a desktop-width column', () => {
  it('lays out in a 720 px column with the buttons side by side on one line', async () => {
    await page.viewport(1280, 800)
    const root = render(
      <div style={{ width: 720, padding: '0 12px' }}>
        <ProposalCardView
          proposalId="p-0a1b2c3d"
          title="Fix the flaky test"
          prompt={BRIEF}
          background={BRIEF}
          placement={{ ...PLACEMENT, cwd: '/work/demo/sub', model: 'gpt-5' }}
          parentCwd="/work/demo"
          state="pending"
          expiresAt={Date.now() + 86_400_000}
          now={Date.now()}
          onStart={noop}
          onDismiss={noop}
        />
      </div>
    ).container
    await settle()
    const card = byTestId(root, 'ProposalCard')
    const start = byTestId(root, 'ProposalCard.start')
    const dismiss = byTestId(root, 'ProposalCard.dismiss')
    expect(hasNoHorizontalOverflow(card)).toBe(true)
    expect(isInside(start, card)).toBe(true)
    expect(isInside(dismiss, card)).toBe(true)
    expect(Math.abs(rectOf(start).top - rectOf(dismiss).top)).toBeLessThan(2)
    expect(rectOf(dismiss).left).toBeGreaterThan(rectOf(start).right - 1)
  })
})
