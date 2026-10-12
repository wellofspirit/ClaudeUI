/**
 * Live preview as a pure function of word hypotheses — ADR-101 §7.
 *
 * Parakeet is an offline model: it has no streaming mode, so a preview is a
 * re-decode. Re-decoding the whole take every second costs 67–84% of a CPU core
 * on a minute of speech; re-decoding only the audio after the last word we are
 * sure about (plus a short lead-in before it, see {@link LEAD_IN_S}) costs about
 * 25%. A window that starts exactly at the commit point has the model begin
 * mid-sentence with no left context, and its words are wrong far more often; the
 * lead-in is decoded for context only and its words are discarded. "Sure about"
 * is LocalAgreement-2 (Macháček et al.,
 * the whisper_streaming policy): a word is stable once two consecutive decodes
 * produce it in the same place. A word is committed — frozen, and its audio
 * dropped from the next window — only when it is stable AND ends at least
 * {@link GUARD_S} behind the live edge, because the model revises the last
 * second or so of any hypothesis as more context arrives.
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
export const PREVIEW_EVERY_MS = 1000
/** No preview until this much audio has arrived; shorter windows are mostly noise. */
export const MIN_PREVIEW_AUDIO_S = 1.5
/** Words ending closer than this to the live edge are never committed. */
export const GUARD_S = 1.0
/** A window longer than this force-commits, so a never-agreeing hypothesis cannot grow unbounded. */
export const MAX_WINDOW_S = 15
/**
 * Audio decoded BEFORE the commit point, for left context only; the words that
 * fall before the commit point are discarded ({@link advancePreview}). Measured on
 * the owner's recordings against the final pass: preview words wrong 10.5% of the
 * time (18.1% without the lead-in), 3.0% of on-screen words rewritten per refresh
 * (4.8%), last preview 4.9% from the final (12.5%), at ~25% CPU while held (~14%).
 */
export const LEAD_IN_S = 3

export interface PreviewState {
  /** Words frozen so far, in order. */
  committed: string[]
  /** The commit point: words before it are settled (see {@link advancePreview}, {@link previewWindowStart}). */
  commitStart: number
  /** The previous hypothesis' still-open words, for the agreement check. */
  open: Word[]
}

export function newPreviewState(): PreviewState {
  return { committed: [], commitStart: 0, open: [] }
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

/** Where the next preview decode starts, in seconds: the commit point less the lead-in, never before the take. */
export function previewWindowStart(state: PreviewState): number {
  return Math.max(0, state.commitStart - LEAD_IN_S)
}

/**
 * Drop the words of the lead-in: a word belongs to the lead-in when its midpoint
 * is before the commit point. The midpoint, not the start or the end, because a
 * word straddling the commit point is the one we cannot place: it is committed
 * audio when most of it lies before the point, new audio when most lies after.
 */
function withoutLeadIn(state: PreviewState, hypothesis: Word[]): Word[] {
  return hypothesis.filter((w) => (w.start + w.end) / 2 >= state.commitStart)
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
 * The commit point is where the last committed word ended, and the model can hear
 * that word's tail again as the first word after it ("the open Open code
 * adapter", seen in the real app). Words wholly in the lead-in are already gone
 * ({@link withoutLeadIn}); this guards the one that straddles the point. A first
 * word that repeats the last committed one and starts within
 * {@link BOUNDARY_ECHO_S} of the commit point is that echo and is dropped. A real repetition said later is untouched, and the final pass, which
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

/** Longest common prefix of two hypotheses, ignoring case and punctuation. */
function agreedPrefix(a: Word[], b: Word[]): number {
  const max = Math.min(a.length, b.length)
  let n = 0
  while (n < max && agreementKey(a[n].word) === agreementKey(b[n].word)) n++
  return n
}

/**
 * Fold one new hypothesis into the state.
 *
 * `hypothesis` is in take time (see {@link shiftWords}) and covers the audio from
 * {@link previewWindowStart} to `edge`, the take's current length in seconds; its
 * words before `state.commitStart` (the lead-in, decoded for context only) are
 * ignored here, so they never reach agreement, the display or a commit. Returns the
 * next state and the full preview text — committed plus open words, which is the
 * WHOLE interim: the renderer replaces its interim text with it, never appends.
 *
 * ## Where the next commit point is
 *
 * (The decode itself starts {@link LEAD_IN_S} earlier, see {@link previewWindowStart}.)
 * After a commit: at the END of the last committed word. Not at the next word's
 * start — TDT timestamps are the frame a token was emitted at, which can land
 * after the sound began, and a window starting there would clip the onset.
 *
 * With no commit it still moves, because otherwise a pause grows the window
 * without bound: a silent or one-word stretch commits nothing (agreement needs
 * two decodes to see the same word, and the force-commit needs two words), and
 * every preview would re-decode the whole pause on the shared queue. The window
 * start follows the first open word (or the edge, when the hypothesis is empty)
 * at {@link GUARD_S} + 0.2 s behind it: late enough that a pause never costs more
 * than about that, early enough that the open words — and speech just starting
 * that the model has not emitted yet — stay inside it.
 */
export function advancePreview(
  state: PreviewState,
  rawHypothesis: Word[],
  edge: number
): { state: PreviewState; text: string } {
  const hypothesis = withoutBoundaryEcho(state, withoutLeadIn(state, rawHypothesis))
  const stable = agreedPrefix(hypothesis, state.open)
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
  const commitStart = n
    ? Math.min(hypothesis[n - 1].end, edge)
    : Math.max(state.commitStart, Math.min(open[0]?.start ?? edge, edge) - GUARD_S - 0.2)

  return {
    state: { committed, commitStart, open },
    text: [...committed, ...open.map((w) => w.word)].join(' ')
  }
}
