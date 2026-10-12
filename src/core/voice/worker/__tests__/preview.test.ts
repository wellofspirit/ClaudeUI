/**
 * @vitest-environment node
 *
 * The LocalAgreement-3 policy, as arithmetic: no sockets, no clock, no model.
 */

import { describe, it, expect } from 'vitest'
import {
  AGREEMENT_DECODES,
  BOUNDARY_ECHO_S,
  GUARD_S,
  MAX_WINDOW_S,
  MIN_PREVIEW_AUDIO_S,
  PREVIEW_EVERY_MS,
  advancePreview,
  newPreviewState,
  previewDue,
  shiftWords,
  type PreviewState,
  type Word
} from '../preview'

/**
 * Fold each hypothesis in turn (all at the same `edge`), returning the last
 * result. For feeding the policy the "same decode, again" a steady speaker gives.
 */
function fold(state: PreviewState, edge: number, ...hypotheses: Word[][]) {
  let result = { state, text: '' }
  for (const h of hypotheses) result = advancePreview(result.state, h, edge)
  return result
}

/** Words `text` spaced `step` s apart, each lasting `len` s, starting at `from`. */
function say(text: string, from = 0, step = 0.5, len = 0.4): Word[] {
  return text.split(' ').map((word, i) => ({
    word,
    start: from + i * step,
    end: from + i * step + len
  }))
}

describe('previewDue — when a preview decode may start', () => {
  const base = { now: 5_000, lastPreviewAt: null, decoding: false, audioSeconds: 3 }

  it('waits for 1.5 s of audio', () => {
    expect(previewDue({ ...base, audioSeconds: MIN_PREVIEW_AUDIO_S - 0.01 })).toBe(false)
    expect(previewDue({ ...base, audioSeconds: MIN_PREVIEW_AUDIO_S })).toBe(true)
  })

  it('the first preview needs no interval, later ones need half a second since the last', () => {
    expect(PREVIEW_EVERY_MS).toBe(500)
    expect(previewDue({ ...base, lastPreviewAt: null })).toBe(true)
    expect(previewDue({ ...base, lastPreviewAt: base.now - (PREVIEW_EVERY_MS - 1) })).toBe(false)
    expect(previewDue({ ...base, lastPreviewAt: base.now - PREVIEW_EVERY_MS })).toBe(true)
  })

  it('never while a decode is in flight', () => {
    expect(previewDue({ ...base, decoding: true })).toBe(false)
  })
})

describe('advancePreview — LocalAgreement-3', () => {
  it('agrees over three decodes', () => {
    expect(AGREEMENT_DECODES).toBe(3)
  })

  it('the first hypothesis has nothing to agree with: shown, not committed', () => {
    const { state, text } = advancePreview(newPreviewState(), say('add a retry'), 3)
    expect(text).toBe('add a retry')
    expect(state.committed).toEqual([])
    expect(state.commitStart).toBe(0)
    expect(state.open.map((w) => w.word)).toEqual(['add', 'a', 'retry'])
    expect(state.history).toHaveLength(1)
  })

  it('two agreeing decodes do NOT commit, the third does', () => {
    // Words end at 0.4, 0.9, 1.4, 1.9; the edge is 3.0, so the cut-off is 2.0:
    // every word is old enough, only the agreement count is in question.
    const hyp = say('one two three four')
    const first = advancePreview(newPreviewState(), hyp, 3)
    const second = advancePreview(first.state, hyp, 3)
    expect(second.state.committed).toEqual([])
    expect(second.state.open).toHaveLength(4)
    expect(second.text).toBe('one two three four')

    const third = advancePreview(second.state, hyp, 3)
    expect(third.state.committed).toEqual(['one', 'two', 'three', 'four'])
    expect(third.text).toBe('one two three four')
    // Everything committed: the next window starts where the last word ended.
    expect(third.state.commitStart).toBeCloseTo(1.9)
    expect(third.state.open).toEqual([])
  })

  it('the guard holds back a stable word that ends too close to the edge', () => {
    const hyp = say('one two three four') // ends 0.4 … 1.9
    const { state, text } = fold(newPreviewState(), 2.5, hyp, hyp, hyp) // cut-off 1.5: one, two, three
    expect(state.committed).toEqual(['one', 'two', 'three'])
    expect(state.open.map((w) => w.word)).toEqual(['four'])
    // The window restarts where the last committed word ENDED, not at the next
    // word's start: TDT timestamps are emission frames and can clip an onset.
    expect(state.commitStart).toBeCloseTo(1.4)
    expect(text).toBe('one two three four')
  })

  it('stops committing at the first word the decodes disagree on', () => {
    const early = say('use the stick bottom')
    const revised = say('use the stick to bottom')
    const { state, text } = fold(newPreviewState(), 5, early, revised, revised)
    // "to" appears only in the last two decodes: the agreed prefix of all three is
    // "use the stick", and all three are old enough.
    expect(state.committed).toEqual(['use', 'the', 'stick'])
    expect(state.open.map((w) => w.word)).toEqual(['to', 'bottom'])
    expect(text).toBe('use the stick to bottom')
  })

  it('a disagreement in the middle decode blocks the words it disagrees on', () => {
    const steady = say('use the stick to bottom')
    const wobbly = say('use a stick to bottom') // the middle decode hears "a"
    const { state } = fold(newPreviewState(), 5, steady, wobbly, steady)
    // Decodes 1 and 3 agree on everything, but "the" is not what decode 2 heard.
    expect(state.committed).toEqual(['use'])
    expect(state.open.map((w) => w.word)).toEqual(['the', 'stick', 'to', 'bottom'])
  })

  it('a disagreement in the oldest decode blocks too', () => {
    const steady = say('use the stick to bottom')
    const wobbly = say('use the strip to bottom')
    // After two decodes nothing is stable yet, however well the second one agrees
    // with itself.
    const two = fold(newPreviewState(), 5, wobbly, steady)
    expect(two.state.committed).toEqual([])
    // The third agrees with the second everywhere, but the oldest heard "strip".
    const three = advancePreview(two.state, steady, 5)
    expect(three.state.committed).toEqual(['use', 'the'])
  })

  it('a shorter earlier hypothesis only lets the words it has be agreed on', () => {
    const { state } = fold(
      newPreviewState(),
      5,
      say('one two'),
      say('one two three'),
      say('one two three')
    )
    expect(state.committed).toEqual(['one', 'two'])
    expect(state.open.map((w) => w.word)).toEqual(['three'])
  })

  it('compares case-insensitively and keeps the newer spelling of what stays open', () => {
    const { state } = fold(
      newPreviewState(),
      5,
      say('Hello world'),
      say('hello World'),
      say('HELLO world')
    )
    expect(state.committed).toEqual(['HELLO', 'world'])
  })

  it('a hypothesis that revises its first word commits nothing', () => {
    const { state, text } = fold(
      newPreviewState(),
      5,
      say('the cat sat'),
      say('the cat sat'),
      say('a cat sat')
    )
    expect(state.committed).toEqual([])
    expect(text).toBe('a cat sat')
  })

  it('remembers at most two previous hypotheses', () => {
    const hyp = say('one two three four')
    let state = newPreviewState()
    for (let i = 0; i < 6; i++) {
      // The edge is so close that every word is inside the guard: nothing commits.
      state = advancePreview(state, hyp, 1.0).state
      expect(state.history.length).toBeLessThanOrEqual(AGREEMENT_DECODES - 1)
    }
    expect(state.history).toHaveLength(2)
    expect(state.committed).toEqual([])
  })

  it('history is shifted by a commit, so the next window agrees from its first word', () => {
    // Three decodes of one long hypothesis; the edge lets only the first four
    // words (ending ≤ 2.0) commit, leaving "five six" open.
    const hyp = say('one two three four five six')
    const afterCommit = fold(newPreviewState(), 3, hyp, hyp, hyp)
    expect(afterCommit.state.committed).toEqual(['one', 'two', 'three', 'four'])
    // Both remembered hypotheses were cut down to what is still open…
    expect(afterCommit.state.history.map((h) => h.map((w) => w.word))).toEqual([
      ['five', 'six'],
      ['five', 'six']
    ])
    // …so the very next decode (a window starting at 1.9 s, words in take time)
    // lines up with them at index 0 and commits at once, with no re-warm-up. An
    // unshifted history would compare "five" with "one" and commit nothing.
    const next = shiftWords(say('five six seven', 0), 2.0)
    const { state, text } = advancePreview(afterCommit.state, next, 5)
    expect(state.committed).toEqual(['one', 'two', 'three', 'four', 'five', 'six'])
    expect(state.open.map((w) => w.word)).toEqual(['seven'])
    expect(text).toBe('one two three four five six seven')
  })

  it('carries committed words through later windows (word times are in take time)', () => {
    const hyp1 = say('alpha beta gamma delta') // 0 … 1.9
    const { state } = fold(newPreviewState(), 4, hyp1, hyp1, hyp1)
    expect(state.committed).toEqual(['alpha', 'beta', 'gamma', 'delta'])
    // The next window decodes from 1.9 s; its words arrive already shifted. The
    // commit left nothing open, so this window needs its own three decodes.
    const hyp2 = shiftWords(say('epsilon zeta', 0), state.commitStart)
    const two = fold(state, 6, hyp2, hyp2)
    expect(two.state.committed).toEqual(['alpha', 'beta', 'gamma', 'delta'])
    const last = advancePreview(two.state, hyp2, 6)
    expect(last.text).toBe('alpha beta gamma delta epsilon zeta')
    expect(last.state.committed).toEqual(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'])
  })

  describe('the max-window force-commit', () => {
    it('commits old words even without agreement once the window passes 15 s, keeping the last open', () => {
      // 40 words, 0.5 s apart, ending 0.4 … 19.9; edge 20 → cut-off 19.
      const words = 'w'
        .repeat(40)
        .split('')
        .map((c, i) => c + i)
      const hyp = say(words.join(' '))
      // Two previous hypotheses (a short take, nothing forced) that disagree from
      // the first word on: stable = 0.
      const bad = say('zzz ' + words.slice(1).join(' '))
      const prev = fold(newPreviewState(), 1, bad, bad)
      expect(prev.state.history).toHaveLength(2)
      const { state } = advancePreview(prev.state, hyp, 20)
      // Words ending ≤ 19.0: indices 0..37 (end 18.4+…); the last is held open anyway.
      expect(state.committed.length).toBeGreaterThan(30)
      expect(state.committed[0]).toBe('w0')
      expect(state.open.length).toBeGreaterThanOrEqual(1)
      expect(state.open.at(-1)!.word).toBe('w39')
      for (const w of state.open) expect(w.end).toBeGreaterThan(20 - GUARD_S - 1e-9)
      // The remembered hypotheses disagreed inside what was force-committed, so
      // agreement restarts from this hypothesis' open words alone.
      expect(state.history).toEqual([state.open])
    })

    it('does not fire at or below the cap', () => {
      const hyp = say('a1 b2 c3 d4 e5 f6 g7 h8')
      const bad = say('q1 b2 c3 d4 e5 f6 g7 h8')
      const prev = fold(newPreviewState(), 1, bad, bad)
      const { state } = advancePreview(prev.state, hyp, MAX_WINDOW_S)
      expect(state.committed).toEqual([])
    })

    it('never commits the final word, even if every word is old', () => {
      const hyp = say('only one old pair', 0)
      const bad = say('xx one old pair', 0)
      const prev = fold(newPreviewState(), 1, bad, bad)
      const { state } = advancePreview(prev.state, hyp, 30)
      expect(state.committed).toEqual(['only', 'one', 'old'])
      expect(state.open.map((w) => w.word)).toEqual(['pair'])
    })
  })

  it('an empty hypothesis keeps the committed text, and the window follows the edge', () => {
    const hyp = say('keep this')
    const committed = fold(newPreviewState(), 5, hyp, hyp, hyp)
    expect(committed.state.committed).toEqual(['keep', 'this'])
    const next = advancePreview(committed.state, [], 8)
    expect(next.text).toBe('keep this')
    expect(next.state.commitStart).toBeCloseTo(8 - GUARD_S - 0.2)
  })

  it('agreement ignores punctuation and case, and keeps the newer spelling', () => {
    const { state, text } = fold(
      newPreviewState(),
      5,
      say('Okay so we add'),
      say('okay, so we add'),
      say('Okay, so we add.')
    )
    expect(state.committed).toEqual(['Okay,', 'so', 'we', 'add.'])
    expect(text).toBe('Okay, so we add.')
  })

  it('a word that is only punctuation does not stop agreement from comparing the rest', () => {
    const hyp = say('wait — what')
    const { state } = fold(newPreviewState(), 5, hyp, hyp, hyp)
    expect(state.committed).toEqual(['wait', '—', 'what'])
  })
})

describe('the window follows a pause instead of growing through it', () => {
  it('an empty hypothesis in a window past the cap moves the window to just behind the edge', () => {
    const { state } = advancePreview(newPreviewState(), [], 30)
    expect(state.commitStart).toBeCloseTo(30 - GUARD_S - 0.2)
    expect(state.committed).toEqual([])
  })

  it('a single late word after a long pause does not leave the window at 0', () => {
    // 30 s of silence, then one word at 30.0–30.4; the edge is 31.
    const word: Word[] = [{ word: 'hello', start: 30, end: 30.4 }]
    const first = advancePreview(newPreviewState(), word, 31)
    expect(first.state.commitStart).toBeCloseTo(30 - GUARD_S - 0.2)
    expect(first.text).toBe('hello')
    // The next decodes agree; on the third (edge 33) the word is old enough to
    // commit, and the window then starts where it ended.
    const second = advancePreview(first.state, word, 32)
    expect(second.state.committed).toEqual([])
    const third = advancePreview(second.state, word, 33)
    expect(third.state.committed).toEqual(['hello'])
    expect(third.state.commitStart).toBeCloseTo(30.4)
  })

  it('never moves the window backwards', () => {
    const state = { committed: ['a'], commitStart: 20, open: [], history: [] }
    expect(advancePreview(state, [], 20.5).state.commitStart).toBe(20)
  })

  it('never puts the window past the live edge', () => {
    const state = { committed: [], commitStart: 0, open: [], history: [] }
    const late: Word[] = [{ word: 'x', start: 10, end: 10.4 }]
    expect(advancePreview(state, late, 5).state.commitStart).toBeLessThanOrEqual(5)
  })

  it('invariant: a long silence never makes the decoded window large', () => {
    // A model that hears one word at 10.0–10.4 and nothing else, previewed once a
    // second for two minutes. Each step decodes [commitStart, edge].
    const spoken: Word[] = [{ word: 'word', start: 10, end: 10.4 }]
    let state = newPreviewState()
    let widest = 0
    for (let edge = 2; edge <= 120; edge++) {
      widest = Math.max(widest, edge - state.commitStart)
      const hypothesis = spoken.filter((w) => w.start >= state.commitStart && w.end <= edge)
      state = advancePreview(state, hypothesis, edge).state
    }
    // One second of new audio plus the guard margin, with room for the word.
    expect(widest).toBeLessThan(MAX_WINDOW_S / 2)
    expect(state.committed).toEqual(['word'])
  })
})

describe('the echo of the last committed word at a window boundary', () => {
  // "the open" committed, ending at 1.4; the next window starts there.
  const committedState = (): ReturnType<typeof newPreviewState> => {
    const hyp = say('the open') // 0–0.4, 0.5–0.9 … ends 0.9
    return fold(newPreviewState(), 3, hyp, hyp, hyp).state
  }

  it('drops a first word that repeats the last committed one right at the window start', () => {
    const state = committedState()
    expect(state.committed).toEqual(['the', 'open'])
    // The model re-hears "open"'s tail as "Open", then the real next words.
    const hyp = shiftWords(say('Open code adapter', 0, 0.5), state.commitStart)
    const { text } = advancePreview(state, hyp, 5)
    expect(text).toBe('the open code adapter')
  })

  it('keeps a real repetition that starts later than the boundary', () => {
    const state = committedState()
    const hyp = shiftWords(say('open open', BOUNDARY_ECHO_S + 0.2, 0.5), state.commitStart)
    expect(advancePreview(state, hyp, 5).text).toBe('the open open open')
  })

  it('keeps a first word that differs from the last committed one', () => {
    const state = committedState()
    const hyp = shiftWords(say('code adapter'), state.commitStart)
    expect(advancePreview(state, hyp, 5).text).toBe('the open code adapter')
  })
})

describe('shiftWords', () => {
  it('moves word times by the window offset and leaves the words', () => {
    expect(shiftWords([{ word: 'a', start: 0.5, end: 0.9 }], 2)).toEqual([
      { word: 'a', start: 2.5, end: 2.9 }
    ])
  })
})
