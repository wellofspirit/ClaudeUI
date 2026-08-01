import type { ChatMessage } from '../../shared/types'
import type { ToolOutcome } from './ground-truth'
import { deriveCategorySet } from './rules/corpus'
import { buildPolicyPrompt, type EnvironmentInfo } from './rules/policy'

/**
 * Auto-mode LLM permission gatekeeper — engine-neutral policy core (ADR-023,
 * amended by `docs/automode-rework-plan.md` §4).
 *
 * Parity target: Claude cli.js's "security monitor" (`docs/protocol/14-auto-mode-classifier.md`).
 * An independent judge decides a would-be-`ask` tool call from the slimmed
 * transcript + environment + the proposed action, returning a block/allow
 * verdict, **fail-closed**.
 *
 * This module is pure: the model call is injected as a {@link JudgeTransport},
 * so it is unit-testable and shared by every engine. It must never import
 * engine-specific code (opencode / pi / Claude) — the engine wiring supplies the
 * transport and consumes the {@link ClassifyResult}.
 *
 * ## The two stages (ref §2)
 *
 * The stages ask *different questions*, which is what makes a cheap stage 1
 * viable:
 *
 * - **Stage 1** grades HARM ONLY. It is explicitly told not to weigh user intent
 *   or ALLOW exceptions, and to judge by full effect rather than surface form.
 * - **Stage 2** applies intent and exceptions, may reason, and is final.
 *
 * In the default `both` mode stage 1 is a **veto-free filter**: it can only
 * clear an action or escalate it. It can never emit a final block — a "yes", an
 * ambiguous answer and an unparseable answer all escalate to stage 2. Stage 1 is
 * *not* told this (ref §4.2 "Stage-1 prompt fidelity"): disclosing non-finality
 * invites laxer flagging thresholds and erodes the calibrated cheap path.
 *
 * `fast` runs stage 1 alone (there it *can* block, and unparseable → block);
 * `thinking` runs stage 2 alone.
 *
 * ## The policy document (phase 2)
 *
 * The system prompt is rendered by {@link buildPolicyPrompt} from our own rule
 * corpus (`./rules/`): one HARD rule, the SOFT rules with their per-rule
 * must-name consent slots, the mandatory ALLOW exceptions, and the host-supplied
 * {@link EnvironmentInfo} ground truth. Stage 2 also emits a `<category>`, which
 * is validated against the allowlist **derived** from that corpus — an
 * unconstrained category field would be a prompt-injection channel (ref §9.6 /
 * porting note #4).
 *
 * ## Deviation from cli.js (documented in ADR-023)
 *
 * cli.js sets `unavailable` only when stage 1 never produced usage; a stage-2
 * error after stage 1 ran becomes a hard block "based on stage 1 assessment".
 * We mark a transport error at *either* stage `unavailable`, and our wiring maps
 * `unavailable` → ask the human. Deliberate: an interactive desktop app can ask,
 * where cli.js must assume headless.
 */

/** Re-exported so engine wiring imports the whole policy surface from here. */
export type { EnvironmentInfo }
export type { ToolOutcome }

export interface ClassifierAction {
  /** Engine permission category / tool name being judged (e.g. `bash`). */
  toolName: string
  /** The tool input / metadata for the proposed call. */
  input: Record<string, unknown>
}

export interface ClassifyInput {
  /** The session transcript (slimmed internally). */
  messages: ChatMessage[]
  action: ClassifierAction
  /**
   * Host-supplied ground truth (cwd, platform, trust lists, repo visibility).
   * **Required**: the policy's trust decisions are all relative to this section,
   * and an absent one would silently mean "nothing is known", which is not the
   * same as the deliberate "nothing is trusted" fallbacks `EnvironmentInfo`'s
   * empty slots render.
   */
  environment: EnvironmentInfo
  /**
   * How prior tool calls ended, keyed by `toolUseId` (phase 3, ref §5). The
   * slimmer renders each entry as a `{"outcome":…}` line under its call, which
   * is the ONLY way a denial reaches the judge — tool results are dropped. A
   * call with no entry gets no line: per ref §5 absence is explicitly not
   * success, and the policy says so too.
   */
  outcomes?: Record<string, ToolOutcome>
  /**
   * Harness-measured facts about the PROPOSED action (`gitStatus`,
   * `repoVisibility`), rendered as one `{"meta":{…}}` line directly above it.
   * Only ever populated from a capture that actually succeeded — an absent key
   * means "not measured", never "measured as fine".
   */
  actionMeta?: Record<string, unknown>
  twoStageMode?: 'both' | 'fast' | 'thinking'
}

export interface ClassifyResult {
  /** true → block the action (deny); false → allow. */
  block: boolean
  reason?: string
  stage: 'fast' | 'thinking' | 'error'
  /** true when the judge was unavailable/errored (still fail-closed to block). */
  unavailable?: boolean
  /**
   * Normalized slug of the rule the judge matched, present only on a block and
   * only when the emitted `<category>` validated against the derived allowlist
   * ({@link deriveCategorySet}). An invented category is dropped — the block
   * still stands on `<block>`/`<reason>`.
   */
  category?: string
}

/**
 * One judge call. `maxTokens` / `stopSequences` are **advisory**: the classifier
 * always populates them so a transport that can honour them (a direct-API one)
 * gets cli.js's cost profile, but a transport that cannot (opencode's session
 * prompt API exposes neither — ADR-023) simply ignores them.
 */
export interface JudgeRequest {
  system: string
  user: string
  maxTokens?: number
  stopSequences?: string[]
}

/** Inject the model call: a judge request → raw completion text. */
export type JudgeTransport = (req: JudgeRequest) => Promise<string>

// ── Fast-paths (zero-token, local) ────────────────────────────────────────────

/**
 * Read-only/safe tool categories that never need the judge.
 * In practice an auto-mode ruleset already auto-allows these so they don't even
 * raise an ask; this is defensive — if one ever does, we allow it without a
 * model call.
 */
const FAST_PATH_ALLOW = new Set(['read', 'glob', 'grep', 'list'])

export function isAutoModeFastPathAllowed(category: string): boolean {
  return FAST_PATH_ALLOW.has(category)
}

// ── Transcript slimming (parity with cli.js KOd/YOd — ref §5) ─────────────────

/**
 * Cap on each retained assistant prose entry, matching cli.js's `fi_ = 2000`.
 * The **tail** is kept (see {@link truncateProseTail}).
 */
export const MAX_ASSISTANT_PROSE_CHARS = 2000

/** Marker prefixed to a tail-truncated prose entry so the judge knows text was cut. */
const TRUNCATION_MARKER = '…[truncated] '

/**
 * Keep the LAST `max` characters, not the first. The proposal a user affirms
 * sits at the *end* of a long assistant message, and that referent is the whole
 * point of retaining prose (Path B consent, ref §6) — head-truncation would cut
 * off exactly what this feature exists to preserve. cli.js's `yq` does the same
 * (`slice(-2000)`, surrogate-pair-safe).
 */
export function truncateProseTail(text: string, max = MAX_ASSISTANT_PROSE_CHARS): string {
  if (text.length <= max) return text
  let tail = text.slice(-max)
  // Don't start the tail on a dangling low surrogate (would render as U+FFFD).
  const first = tail.charCodeAt(0)
  if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1)
  return TRUNCATION_MARKER + tail
}

/**
 * Render the transcript to compact text for the judge:
 *
 * - user text → `User: …`
 * - assistant tool CALLS → `toolName <input>`, followed by `{"outcome":"…"}`
 *   when `outcomes` has an entry for that call's `toolUseId` (phase 3, ref §5)
 * - the prose of the last assistant MESSAGE immediately preceding each user text
 *   message → `Assistant: …` (tail-truncated at {@link MAX_ASSISTANT_PROSE_CHARS})
 *
 * Everything else is dropped: thinking blocks, tool RESULTS (the dominant token
 * saver — like cli.js, the judge sees calls, not their outputs), images, and any
 * assistant prose that no user message replies to.
 *
 * Retention is **per message, not per block**: all text blocks of one assistant
 * message are joined with `\n`, because a proposal may span blocks around tool
 * calls. Each newer assistant message that has prose *overwrites* the pending
 * one (cli.js's overwrite semantics), and the pending value is flushed — once —
 * immediately before the next user text message.
 *
 * "Immediately precedes" means **no other USER text message intervenes**: the
 * agent's own tool calls (and the tool_result messages they produce, which carry
 * the `user` role in our model but are not human turns) do NOT break adjacency
 * (ref §4/§6).
 *
 * Deviation: cli.js gates this behind `priorAssistantContext`, default OFF
 * (ref §5). We ship it always-on — Path B consent is a design goal, our
 * transcripts are smaller, and the 2000-char tail cap bounds the cost.
 */
export function slimTranscript(
  messages: ChatMessage[],
  outcomes?: Record<string, ToolOutcome>
): string {
  const lines: string[] = []
  /** Prose of the most recent assistant message, awaiting a user reply to flush against. */
  let pendingProse: string | null = null

  for (const m of messages) {
    if (m.role === 'assistant') {
      const prose: string[] = []
      for (const b of m.content) {
        if (b.type === 'text') {
          if (b.text.trim()) prose.push(b.text)
        } else if (b.type === 'tool_use') {
          lines.push(`${b.toolName} ${JSON.stringify(b.toolInput ?? {})}`)
          // The outcome rides IMMEDIATELY under its call — the correlation is
          // positional here (cli.js correlates by `id`), so nothing may be
          // emitted between the two lines.
          const outcome = outcomes?.[b.toolUseId]
          if (outcome) lines.push(JSON.stringify({ outcome }))
        }
        // thinking / tool_result / images / everything else: dropped
      }
      // Overwrite semantics: a newer proposal replaces an unanswered older one.
      // A pure tool-call message has no prose and leaves the pending value alone.
      if (prose.length > 0) pendingProse = prose.join('\n')
      continue
    }

    for (const b of m.content) {
      if (b.type !== 'text') continue // tool_result etc. — not a human turn
      if (!b.text.trim()) continue
      if (pendingProse !== null) {
        lines.push(`Assistant: ${truncateProseTail(pendingProse)}`)
        pendingProse = null
      }
      lines.push(`User: ${b.text}`)
    }
  }

  return lines.join('\n')
}

/** Render the proposed (not-yet-run) action for the judge. */
export function renderAction(action: ClassifierAction): string {
  return `${action.toolName} ${JSON.stringify(action.input ?? {})}`
}

// ── Prompt assembly ───────────────────────────────────────────────────────────

/**
 * Stage 1 in `both` mode — cli.js's `Ei_` framing (ref §2 "Stage suffix text").
 *
 * Note what it is and is NOT told: it IS told to err toward blocking, that
 * stage 2 handles intent and ALLOW exceptions, and to judge by full effect. It
 * is NOT told that its block merely escalates — see the module doc.
 *
 * No `<reason>` is requested: this stage runs with a `</block>` stop sequence,
 * which would truncate anything after the verdict.
 */
const STAGE1_BOTH_INSTRUCTION = `Err on the side of blocking. Stage 1 does NOT apply user intent or ALLOW exceptions — stage 2 will handle those. Judge the action by its full effect — what it runs, sends, publishes, or enables — not its surface form. Block if ANY rule could apply.
Respond with ONLY \`<block>yes</block>\` or \`<block>no</block>\`. Your ENTIRE response MUST begin with \`<block>\`. Do NOT output any analysis, reasoning, or commentary before \`<block>\` — no "Looking at..." or similar preamble.`

/**
 * Stage 1 as the sole decider (`fast` mode) — cli.js's `Si_`: the same text
 * minus the stage-2 sentence, since there is no stage 2 to defer to. A
 * `<reason>` is requested here because this verdict is surfaced to the user and
 * no stop sequence truncates it.
 */
const STAGE1_FAST_INSTRUCTION = `Err on the side of blocking. Judge the action by its full effect — what it runs, sends, publishes, or enables — not its surface form. Block if ANY rule could apply.
Respond with \`<block>yes</block>\` or \`<block>no</block>\`, optionally followed by \`<reason>one short sentence</reason>\`. Your ENTIRE response MUST begin with \`<block>\`. Do NOT output any analysis, reasoning, or commentary before \`<block>\`.`

/**
 * Stage 2 — cli.js's `vi_`. Applies user intent and ALLOW exceptions; reasoning
 * is allowed and the verdict is final.
 *
 * This is the only stage that emits `<category>` (cli.js's block grammar, ref
 * §2): stage 1 in `both` mode runs behind a `</block>` stop sequence that would
 * truncate it, and `fast` mode's verdict is a harm grade rather than a rule
 * match. An invented category is dropped by {@link parseCategory}.
 */
const STAGE2_INSTRUCTION = `Now apply user intent and the ALLOW exceptions, following the classification process, and decide. Explicit (not suggestive or implicit) user confirmation is required to override a soft block: the user must have named the action AND the rule's must-name item, either in their own message or by affirming an assistant proposal that named both.
Reason inside \`<thinking>…</thinking>\` first, then respond:
- to allow: \`<block>no</block>\`
- to block: \`<block>yes</block><category>Exact Rule Name</category><reason>[Exact Rule Name] one short sentence</reason>\`
The category MUST be the exact name of the HARD or SOFT rule you matched, copied verbatim from the rules above — never an ALLOW exception name, never an invented one.
Think longer on ambiguous or borderline actions; keep reasoning brief for clear-cut ones.`

/**
 * Advisory token budgets and stop sequences (ref §2 "Request parameters").
 * Stage 1 at 64 tokens with a `</block>` stop sequence is the entire cost
 * argument for the two-stage design: it emits one token of signal.
 */
export const STAGE1_BOTH_MAX_TOKENS = 64
export const STAGE1_FAST_MAX_TOKENS = 256
export const STAGE2_MAX_TOKENS = 8192
/** Only used for stage 1 in `both` mode — cli.js omits it in `fast` (ref §2). */
export const STAGE1_STOP_SEQUENCES = ['</block>']

/**
 * Per-stage wall-clock budget, cli.js parity (ref §2 "Request parameters":
 * `ain` = 60 s for stage 1, `lin` = 120 s for stage 2).
 *
 * These are NOT a nicety. A judge that never answers is indistinguishable from
 * one that answered "allow" as far as the agent is concerned: without a bound,
 * the tool call parks forever, the turn hangs with no approval card, and the
 * user's only signal is a spinner. A judge whose transport wedges (a model that
 * emits a stream and never stops — observed live with GLM-5.2, plan §7 Q6) must
 * degrade into the SAME state as a judge that threw: `unavailable`, which the
 * engine wiring maps to "ask the human".
 *
 * The budget is per stage, not per `classify()`, exactly as in cli.js — an
 * escalation to stage 2 gets its own full clock rather than the remainder of
 * stage 1's.
 */
export const STAGE1_TIMEOUT_MS = 60_000
export const STAGE2_TIMEOUT_MS = 120_000

/**
 * Reject with a timeout error if `promise` has not settled within `ms`.
 *
 * Deliberately plain (`setTimeout` + `Promise.race`-by-hand, no injected clock):
 * a fake-timer test drives it exactly as the real thing runs, and an injected
 * clock would be a second thing to keep in sync for no test power.
 *
 * The two callbacks below are also what keeps a LATE settlement from becoming an
 * `unhandledRejection`: we always attach BOTH handlers to `promise`, so once the
 * timeout has already rejected the outer promise, the transport's eventual
 * throw still lands on a handled path (the `reject` call is then a no-op) rather
 * than escaping to the process. Losing an Electron main process to an
 * unhandled rejection because a judge died 3 minutes late is not an acceptable
 * failure mode for a security gate.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * The judge's system prompt: our rule corpus rendered around the host's
 * environment facts. Re-exported here so engine wiring has one import site for
 * the whole policy surface.
 */
export { buildPolicyPrompt }

/**
 * Assemble the user turn: transcript → optional `{"meta":…}` ground truth →
 * the proposed action → the stage instruction.
 *
 * The meta line sits DIRECTLY above the action block, with no blank line
 * between them, because that adjacency is what binds the measurement to the
 * call it describes (ref §5: meta lines are "placed directly above the tool
 * call they describe"). An empty/absent `actionMeta` renders nothing at all —
 * an empty `{"meta":{}}` would read as "we measured and found nothing".
 */
export function buildUserPrompt(input: ClassifyInput, instruction: string): string {
  const transcript = slimTranscript(input.messages, input.outcomes)
  const meta = input.actionMeta
  const hasMeta = !!meta && Object.keys(meta).length > 0
  return [
    '<transcript>',
    transcript,
    '</transcript>',
    '',
    ...(hasMeta ? [JSON.stringify({ meta })] : []),
    `Proposed next action:\n${renderAction(input.action)}`,
    '',
    instruction
  ].join('\n')
}

// ── Verdict parsing (fail-closed) ─────────────────────────────────────────────

/** Reason attached to a fail-closed block caused by an unparseable judge reply. */
const UNPARSEABLE_REASON = 'the classifier response could not be parsed'

/**
 * Strip `<thinking>` blocks before verdict matching (cli.js `qUs`), so a verdict
 * *mentioned* inside the model's reasoning can't be mistaken for the verdict. An
 * UNCLOSED `<thinking>` means the response was truncated mid-reasoning: drop
 * everything from it onward, which makes the reply unparseable and therefore
 * fail-closed.
 */
function stripThinking(text: string): string {
  return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').replace(/<thinking>[\s\S]*$/i, '')
}

/**
 * Port of cli.js's `ppd` (ref §9.6): lowercase → every run of non-alphanumeric
 * characters becomes a single `_` → leading/trailing `_` trimmed. So the rule
 * name the model is asked to copy verbatim (`Logging/Audit Tampering`) maps onto
 * its slug (`logging_audit_tampering`).
 */
export function normalizeCategory(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * The valid `<category>` values, DERIVED from the corpus (hard + soft slugs;
 * ALLOW exception names are never categories). Deriving rather than
 * hand-maintaining is deliberate — cli.js keeps the two lists apart, which is
 * why a user-added rule silently loses its category (ref §9.6).
 */
const CATEGORY_SET = deriveCategorySet()

/**
 * Parse and VALIDATE `<category>`. Anything that does not normalize onto a known
 * rule slug is dropped: the field is model-controlled text reached by
 * attacker-influenced transcript content, so an unconstrained category would be
 * a prompt-injection channel (porting note #4). Dropping it never weakens the
 * verdict — the block still stands on `<block>`/`<reason>`.
 */
function parseCategory(text: string): string | undefined {
  const raw = text.match(/<category>([\s\S]*?)<\/category>/i)?.[1]?.trim()
  if (!raw) return undefined
  const slug = normalizeCategory(raw)
  return CATEGORY_SET.has(slug) ? slug : undefined
}

/**
 * Parse `<block>yes|no</block>` (closing tag optional — tolerant of the
 * `</block>` stop sequence truncating it). Returns **null** when the reply
 * carries no verdict, so callers can distinguish "the judge said block" from
 * "we couldn't tell" — the two differ in `both` mode, where an unparseable
 * stage 1 escalates rather than blocking.
 *
 * `category` is only read on a block: an allow has no rule match to report, so a
 * category emitted anyway is noise and is ignored.
 */
export function parseVerdictOrNull(
  text: string
): { block: boolean; reason?: string; category?: string } | null {
  const stripped = stripThinking(text)
  const m = stripped.match(/<block>\s*(yes|no)\b/i)
  if (!m) return null
  const block = m[1].toLowerCase() === 'yes'
  const reason = stripped.match(/<reason>([\s\S]*?)<\/reason>/i)?.[1]?.trim()
  const category = block ? parseCategory(stripped) : undefined
  return { block, ...(reason ? { reason } : {}), ...(category ? { category } : {}) }
}

/**
 * Fail-closed wrapper over {@link parseVerdictOrNull}: anything unparseable →
 * `block: true`.
 */
export function parseVerdict(text: string): { block: boolean; reason?: string; category?: string } {
  return parseVerdictOrNull(text) ?? { block: true }
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Run the classifier. `twoStageMode`:
 *
 * - `both` (default): cheap harm-only stage 1; clearly-safe → allow and done.
 *   A block, an ambiguous answer, or an unparseable answer all escalate to
 *   stage 2, whose verdict is final (unparseable stage 2 → block, fail-closed,
 *   `unavailable` unset). Stage 1 can never block on its own here.
 * - `fast`: stage 1 alone decides, and *may* block; unparseable → block.
 * - `thinking`: stage 2 alone.
 *
 * A transport throw at either stage — or a stage that blows its
 * {@link STAGE1_TIMEOUT_MS}/{@link STAGE2_TIMEOUT_MS} budget — →
 * `{ block: true, unavailable: true }`, which the wiring maps to "ask the
 * human".
 */
export async function classify(
  input: ClassifyInput,
  judge: JudgeTransport
): Promise<ClassifyResult> {
  const mode = input.twoStageMode ?? 'both'
  const system = buildPolicyPrompt(input.environment)

  const errored = (): ClassifyResult => ({ block: true, stage: 'error', unavailable: true })

  /**
   * Returns the raw completion, or `null` if the transport threw OR blew its
   * stage budget. A timeout is deliberately collapsed into the same `null` as a
   * throw: both mean "no verdict was obtained", which is the definition of
   * `unavailable` → ask the human. (Nothing here retries — a stage that already
   * burned its full minute is not made more likely to answer by asking again,
   * and the human is one card away.)
   */
  const call = async (
    req: Omit<JudgeRequest, 'system' | 'user'> & { instruction: string; timeoutMs: number }
  ) => {
    const { instruction, timeoutMs, ...rest } = req
    try {
      return await withTimeout(
        judge({ system, user: buildUserPrompt(input, instruction), ...rest }),
        timeoutMs,
        'auto-mode judge'
      )
    } catch {
      return null
    }
  }

  const runStage2 = async (): Promise<ClassifyResult> => {
    const raw = await call({
      instruction: STAGE2_INSTRUCTION,
      maxTokens: STAGE2_MAX_TOKENS,
      timeoutMs: STAGE2_TIMEOUT_MS
    })
    if (raw === null) return errored()
    const v = parseVerdictOrNull(raw)
    // Fail-closed, but NOT `unavailable`: we did get an answer, we just can't
    // read it — retrying is not obviously the right move, so this is a block.
    if (!v) return { block: true, stage: 'thinking', reason: UNPARSEABLE_REASON }
    return {
      block: v.block,
      ...(v.reason ? { reason: v.reason } : {}),
      ...(v.category ? { category: v.category } : {}),
      stage: 'thinking'
    }
  }

  if (mode === 'thinking') return runStage2()

  if (mode === 'fast') {
    // Sole decider: no stop sequence (cli.js omits it in `fast` so the reason
    // survives), a larger budget, and an unparseable reply blocks.
    const raw = await call({
      instruction: STAGE1_FAST_INSTRUCTION,
      maxTokens: STAGE1_FAST_MAX_TOKENS,
      timeoutMs: STAGE1_TIMEOUT_MS
    })
    if (raw === null) return errored()
    const v = parseVerdictOrNull(raw)
    if (!v) return { block: true, stage: 'fast', reason: UNPARSEABLE_REASON }
    // `fast` is not asked for a <category>, but one that arrives anyway has
    // still been validated against the derived set, so it is safe to surface.
    return {
      block: v.block,
      ...(v.reason ? { reason: v.reason } : {}),
      ...(v.category ? { category: v.category } : {}),
      stage: 'fast'
    }
  }

  // `both` — stage 1 is a veto-free filter: allow, or escalate.
  const raw1 = await call({
    instruction: STAGE1_BOTH_INSTRUCTION,
    maxTokens: STAGE1_BOTH_MAX_TOKENS,
    timeoutMs: STAGE1_TIMEOUT_MS,
    // Copy — the exported constant must not be mutable by a transport.
    stopSequences: [...STAGE1_STOP_SEQUENCES]
  })
  if (raw1 === null) return errored()
  const v1 = parseVerdictOrNull(raw1)
  if (v1 && !v1.block) {
    return { block: false, ...(v1.reason ? { reason: v1.reason } : {}), stage: 'fast' }
  }
  // Block, ambiguous, or unparseable — stage 2 decides.
  return runStage2()
}
