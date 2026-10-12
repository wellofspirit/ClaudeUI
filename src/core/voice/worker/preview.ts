/**
 * Live preview as a pure function of word hypotheses — ADR-101 §7.
 *
 * Parakeet is an offline model: it has no streaming mode, so a preview is a
 * re-decode. Re-decoding the whole take every second costs 67–84% of a CPU core
 * on a minute of speech; re-decoding only the audio AFTER the last word we are
 * sure about costs 8–15%. "Sure about" is LocalAgreement-n (Macháček et al.,
 * the whisper_streaming policy, there with n = 2): a word is stable once the
 * latest {@link AGREEMENT_DECODES} decodes (this one and the previous ones of
 * the same window lineage) all produce it in the same place. A word is committed
 * — frozen, and its audio dropped from the next window — only when it is stable
 * AND ends at least {@link GUARD_S} behind the live edge, because the model
 * revises the last second or so of any hypothesis as more context arrives.
 *
 * Everything here is arithmetic over `{ word, start, end }` in seconds from the
 * start of the take. No sherpa, no sockets, no clock: the server owns those and
 * calls in, which is what lets the policy be unit-tested exhaustively.
 */

export interface Word {
  word: string
  /** Seconds from the start of the recording. */
  start: number
  end: number
}

/** Preview cadence: at most one preview decode per this many ms. */
export const PREVIEW_EVERY_MS = 500
/**
 * How many consecutive decodes must agree on a word before it is stable (the n of
 * LocalAgreement-n). Measured in a simulator on real recordings: at the 0.5 s
 * cadence, 2-decode agreement makes 18–29% of preview words change in the final
 * transcript (7–20% at the old 1 s cadence); 3-decode agreement brings that back
 * to 11–19% at 13–19% CPU and ≤ 0.17 s per decode.
 */
export const AGREEMENT_DECODES = 3
/** No preview until this much audio has arrived; shorter windows are mostly noise. */
export const MIN_PREVIEW_AUDIO_S = 1.5
/** Words ending closer than this to the live edge are never committed. */
export const GUARD_S = 1.0
/** A window longer than this force-commits, so a never-agreeing hypothesis cannot grow unbounded. */
export const MAX_WINDOW_S = 15

export interface PreviewState {
  /** Words frozen so far, in order. */
  committed: string[]
  /** Start of the audio the next preview decodes (see {@link advancePreview}). */
  commitStart: number
  /** The latest hypothesis' still-open words: what the preview shows after the committed text. */
  open: Word[]
  /**
   * The still-open words of the latest hypotheses of this window lineage, oldest
   * first, at most {@link AGREEMENT_DECODES} − 1 of them, the newest being
   * {@link open}. The agreement check compares the next hypothesis with all of
   * them. A commit shifts every one by the words committed (they all agreed on
   * those), so index 0 of each stays the same place as index 0 of the next
   * hypothesis.
   */
  history: Word[][]
}

export function newPreviewState(): PreviewState {
  return { committed: [], commitStart: 0, open: [], history: [] }
}

/**
 * Whether a preview decode should start now. `lastPreviewAt` is when the previous
 * one STARTED (null before the first) and `decoding` is any decode in flight for
 * this capture — a preview never queues behind itself.
 */
export function previewDue(args: {
  now: number
  lastPreviewAt: number | null
  decoding: boolean
  audioSeconds: number
}): boolean {
  if (args.decoding) return false
  if (args.audioSeconds < MIN_PREVIEW_AUDIO_S) return false
  return args.lastPreviewAt === null || args.now - args.lastPreviewAt >= PREVIEW_EVERY_MS
}

/** Words as decoded from a window that began at `offset` seconds, in take time. */
export function shiftWords(words: Word[], offset: number): Word[] {
  return offset === 0
    ? words
    : words.map((w) => ({ word: w.word, start: w.start + offset, end: w.end + offset }))
}

/**
 * What agreement compares: letters and digits only, lower-cased. The model adds
 * and drops commas and full stops between decodes of the same speech ("Okay so" /
 * "Okay, so"); a policy that called that a disagreement would never commit
 * across a punctuated phrase.
 */
function agreementKey(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** How close to the window's start a repeat of the last committed word counts as its echo. */
export const BOUNDARY_ECHO_S = 0.3

/**
 * A window starts where the last committed word ended, and the model can hear
 * that word's tail again as the window's first word ("the open Open code
 * adapter", seen in the real app). A first word that repeats the last committed
 * one and starts within {@link BOUNDARY_ECHO_S} of the window is that echo and is
 * dropped. A real repetition said later is untouched, and the final pass, which
 * decodes the whole take, never sees a window at all.
 */
function withoutBoundaryEcho(state: PreviewState, hypothesis: Word[]): Word[] {
  const last = state.committed[state.committed.length - 1]
  const first = hypothesis[0]
  if (
    last !== undefined &&
    first !== undefined &&
    first.start < state.commitStart + BOUNDARY_ECHO_S &&
    agreementKey(first.word) === agreementKey(last)
  ) {
    return hypothesis.slice(1)
  }
  return hypothesis
}

/**
 * How many leading words `hypothesis` and every one of `previous` agree on
 * (ignoring case and punctuation). Zero until there are
 * {@link AGREEMENT_DECODES} − 1 previous hypotheses: nothing is stable on fewer
 * than {@link AGREEMENT_DECODES} decodes.
 */
function agreedPrefix(hypothesis: Word[], previous: Word[][]): number {
  if (previous.length < AGREEMENT_DECODES - 1) return 0
  let max = hypothesis.length
  for (const p of previous) max = Math.min(max, p.length)
  let n = 0
  while (
    n < max &&
    previous.every((p) => agreementKey(p[n].word) === agreementKey(hypothesis[n].word))
  ) {
    n++
  }
  return n
}

/**
 * Fold one new hypothesis into the state.
 *
 * `hypothesis` is in take time (see {@link shiftWords}) and covers the audio from
 * `state.commitStart` to `edge`, the take's current length in seconds. Returns the
 * next state and the full preview text — committed plus open words, which is the
 * WHOLE interim: the renderer replaces its interim text with it, never appends.
 *
 * ## Where the next window starts
 *
 * After a commit: at the END of the last committed word. Not at the next word's
 * start — TDT timestamps are the frame a token was emitted at, which can land
 * after the sound began, and a window starting there would clip the onset.
 *
 * With no commit it still moves, because otherwise a pause grows the window
 * without bound: a silent or one-word stretch commits nothing (agreement needs
 * {@link AGREEMENT_DECODES} decodes to see the same word, and the force-commit
 * needs two words), and every preview would re-decode the whole pause on the
 * shared queue. The window start follows the first open word (or the edge, when
 * the hypothesis is empty) at {@link GUARD_S} + 0.2 s behind it: late enough
 * that a pause never costs more than about that, early enough that the open
 * words — and speech just starting that the model has not emitted yet — stay
 * inside it.
 */
export function advancePreview(
  state: PreviewState,
  rawHypothesis: Word[],
  edge: number
): { state: PreviewState; text: string } {
  const hypothesis = withoutBoundaryEcho(state, rawHypothesis)
  const stable = agreedPrefix(hypothesis, state.history)
  const settled = (i: number): boolean => hypothesis[i].end <= edge - GUARD_S

  let n = 0
  while (n < stable && settled(n)) n++

  // Nothing agreed in a window that has grown past the cap: commit what is old
  // enough anyway, keeping the last word open so the next window still has an
  // anchor to continue from.
  if (n === 0 && edge - state.commitStart > MAX_WINDOW_S) {
    while (n < hypothesis.length - 1 && settled(n)) n++
  }

  const committed = n
    ? [...state.committed, ...hypothesis.slice(0, n).map((w) => w.word)]
    : state.committed
  const open = hypothesis.slice(n)
  // This hypothesis becomes the newest remembered one. Everything remembered is
  // shifted by the n words committed, which all of them agreed on (that is what
  // made those words stable), so positions stay aligned. A force-commit can pass
  // `stable`: the remembered hypotheses disagreed somewhere inside the n words, so
  // what follows them is misaligned and the memory restarts from this hypothesis.
  const remembered = n <= stable ? state.history.map((h) => h.slice(n)) : []
  const history = [...remembered, open].slice(-(AGREEMENT_DECODES - 1))
  const commitStart = n
    ? Math.min(hypothesis[n - 1].end, edge)
    : Math.max(state.commitStart, Math.min(open[0]?.start ?? edge, edge) - GUARD_S - 0.2)

  return {
    state: { committed, commitStart, open, history },
    text: [...committed, ...open.map((w) => w.word)].join(' ')
  }
}
