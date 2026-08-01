/**
 * PiJudge — the auto-mode {@link JudgeTransport} for the pi engine
 * (`docs/automode-rework-plan.md` phase 4, §7 Q1).
 *
 * ## Shape
 *
 * A WARM `pi --mode rpc --no-session --no-tools --system-prompt <policy>`
 * process, owned per PiSession, spawned lazily on the first judge call and
 * reused for every later one. It is the exact spawn choreography
 * `PiSession.askSideQuestion` proved (locate the binary, `PiRpcClient`,
 * `agent_settled` listener registered BEFORE the prompt, bounded timeout,
 * dispose-once), with three differences:
 *
 * 1. the classifier's `system` rides `--system-prompt` at spawn rather than
 *    being folded into the user turn;
 * 2. the process is REUSED — statelessness comes from an RPC `new_session`
 *    between calls rather than from a fresh spawn;
 * 3. it THROWS on failure instead of returning null. That is the contract
 *    `classify()` wants: a transport throw becomes
 *    `{block: true, unavailable: true}`, which the wiring maps to "ask the
 *    human". Swallowing errors here would silently fail OPEN-ish (a
 *    fabricated verdict) instead.
 *
 * ## Why tools are safe here
 *
 * `--no-tools` disables tools at the PROCESS level — bash/edit/write are never
 * registered, so there is nothing for a prompt-injected judge to reach. This is
 * categorically stronger than opencode's judge, which is a real session with a
 * deny-all ruleset patched onto it (and whose instance-global `approved` list
 * can outrank that patch — plan §7 Q5). No bridge extension is loaded at all,
 * so §7 Q5 has no pi analogue.
 *
 * The discovery flags matter just as much and are NOT cargo-culted from
 * askSideQuestion: pi's `--system-prompt` "replaces the default prompt;
 * **context files and skills are still appended**" (usage.md:240). Without
 * `--no-context-files` the repository's own `AGENTS.md`/`CLAUDE.md` — content
 * the agent under judgement can write — would be appended to the SECURITY
 * JUDGE'S SYSTEM PROMPT. `--no-skills` / `--no-extensions` /
 * `--no-prompt-templates` close the same class of channel for the other
 * discovery paths.
 *
 * ## Statelessness — probed, not assumed
 *
 * Probed against the vendored pi (2026-08-01, `--mode rpc --no-session
 * --no-tools --system-prompt …`): `new_session` responds
 * `{success: true, data: {cancelled: false}}`, mints a new `sessionId`, and
 * resets `get_state().messageCount` and `get_messages()` to zero. The judge
 * confirmed statelessness behaviourally (it answered `UNKNOWN` about a fact
 * from the previous exchange), and BOTH the `--system-prompt` and the
 * `set_model` selection survive the reset. So the warm-process design holds and
 * respawn-per-call is not needed. A `new_session` that fails or reports
 * `cancelled` still falls back to a respawn — correctness before cost.
 *
 * ## Advisory request fields (ADR-023-style deviation)
 *
 * `JudgeRequest.maxTokens` / `stopSequences` are IGNORED, exactly as opencode's
 * transport ignores them: pi's `prompt` RPC exposes neither. The classifier
 * still populates them for a future direct-API transport (plan phase 5), and
 * ignoring an advisory field is the documented contract. The practical cost is
 * that stage 1's 64-token `</block>` stop-sequence budget is not enforced —
 * the stage-1 instruction's "respond with ONLY <block>…" wording is what keeps
 * it terse instead.
 */
import type { JudgeRequest, JudgeTransport } from '../automode/classifier'
import { logger } from '../services/logger'
import { locatePiBinary } from './pi-locate'
import { PiRpcClient } from './PiRpcClient'
import type { PiEvent, PiRpcCommand, PiRpcResponse } from './pi-protocol'
import type { PiGetLastAssistantTextData } from './pi-protocol'

/**
 * Whole-call budget: spawn (cold) or reset (warm) + the model round trip.
 * Generous because stage 2 reasons: the phase-3 bench measured p50 latencies
 * from ~6 s (gpt-5.6 class) to ~33 s (glm), so a tight bound would turn a slow
 * but healthy judge into a stream of human prompts. Exceeding it tears the
 * process down and throws → `unavailable` → the human decides, which is the
 * same place a hung judge should land anyway.
 */
export const PI_JUDGE_CALL_TIMEOUT_MS = 90_000

/**
 * Everything except `--system-prompt <text>`, which is appended per spawn.
 * See the module doc for why each `--no-*` flag is load-bearing rather than
 * defensive noise.
 */
export const PI_JUDGE_BASE_ARGS: readonly string[] = [
  '--mode',
  'rpc',
  '--no-session',
  '--no-tools',
  '--no-extensions',
  '--no-skills',
  '--no-context-files',
  '--no-prompt-templates'
]

/**
 * Windows caps a `CreateProcess` command line at 32767 chars, and the rendered
 * policy is ~24 KB before the user's trust lists are added — close enough that
 * an unusually large corpus could push it over. Crossing this line is only
 * LOGGED, never worked around: a spawn that does fail rejects `start()`, which
 * this transport turns into a throw → `unavailable` → the human. Failing safe
 * beats silently truncating the policy the judge reasons from.
 */
const SYSTEM_PROMPT_WARN_CHARS = 28_000

/** The subset of `PiRpcClient` this module uses — the seam the tests inject through. */
export interface PiJudgeClient {
  start(): Promise<void>
  request<T = unknown>(cmd: PiRpcCommand, timeoutMs?: number): Promise<PiRpcResponse<T>>
  onEvent(cb: (ev: PiEvent) => void): () => void
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): () => void
  dispose(): void
}

export interface PiJudgeOptions {
  /** Working directory for the judge process — the session's own cwd. */
  cwd: string
  /**
   * The judge model, resolved LAZILY at each spawn so a mid-session
   * `setModel()` (or an edited `autoMode.judgeModel`) is picked up on the next
   * respawn. `null` leaves pi on its own default; a failing `set_model` is
   * swallowed for the same reason (mirrors askSideQuestion).
   */
  resolveModel: () => { vendorId: string; modelId: string } | null
  /** Injectable for tests; defaults to the real vendored-binary locator. */
  locateBinary?: () => string | null
  /** Injectable for tests; defaults to a real `PiRpcClient`. */
  createClient?: (bin: string, opts: { cwd: string; args: string[] }) => PiJudgeClient
  /** Injectable for tests. */
  timeoutMs?: number
}

/**
 * Owns the warm judge process. One instance per PiSession; `dispose()` from the
 * session's own teardown.
 */
export class PiJudge {
  private client: PiJudgeClient | null = null
  /** The `--system-prompt` the live process was spawned with — a change forces a respawn. */
  private spawnedSystem: string | null = null
  /**
   * True only while the live process's conversation is empty (right after a
   * spawn or a successful `new_session`). Set false the instant a prompt goes
   * out, so an aborted/timed-out call can never be mistaken for a clean slate.
   */
  private conversationEmpty = false
  /** Serializes calls — one warm process cannot host two conversations at once. */
  private chain: Promise<unknown> = Promise.resolve()
  private disposed = false

  private readonly locateBinary: () => string | null
  private readonly createClient: (bin: string, opts: { cwd: string; args: string[] }) => PiJudgeClient
  private readonly timeoutMs: number

  constructor(private readonly opts: PiJudgeOptions) {
    this.locateBinary = opts.locateBinary ?? locatePiBinary
    this.createClient = opts.createClient ?? ((bin, o) => new PiRpcClient(bin, o))
    this.timeoutMs = opts.timeoutMs ?? PI_JUDGE_CALL_TIMEOUT_MS
  }

  /**
   * The {@link JudgeTransport} to hand `classify()`. Bound as a field so a bare
   * reference keeps `this`.
   *
   * Calls are queued rather than run concurrently: two approvals can be in
   * flight at once (pi gates each `tool_call` independently), and a second
   * `prompt` into the same process would be steered into the first
   * conversation. The queue is also what makes `new_session` between calls
   * meaningful.
   */
  readonly transport: JudgeTransport = (req: JudgeRequest): Promise<string> => {
    if (this.disposed) return Promise.reject(new Error('pi judge: disposed'))
    // Chain off the previous call's SETTLEMENT (either outcome) so one failure
    // never poisons the queue, and never propagate the predecessor's result.
    const task = this.chain.then(
      () => this.runExclusive(req),
      () => this.runExclusive(req)
    )
    this.chain = task.then(
      () => undefined,
      () => undefined
    )
    return task
  }

  /** Tear the judge down for good (session cancel/dispose). Idempotent. */
  dispose(): void {
    this.disposed = true
    this.teardown()
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async runExclusive(req: JudgeRequest): Promise<string> {
    if (this.disposed) throw new Error('pi judge: disposed')
    try {
      const client = await this.ensureReady(req.system)
      return await this.withDeadline(this.ask(client, req.user))
    } catch (err) {
      // ANY failure retires the process: a half-answered conversation, a wedged
      // child or a mid-flight timeout must not be reused for the next verdict.
      // The next call spawns fresh.
      this.teardown()
      throw err instanceof Error ? err : new Error(String(err))
    }
  }

  /**
   * A live process whose `--system-prompt` matches `system`, with an EMPTY
   * conversation. Reuses the warm one when it can, respawns when it cannot
   * (different system prompt, no process, or a `new_session` that did not take).
   */
  private async ensureReady(system: string): Promise<PiJudgeClient> {
    if (this.client && this.spawnedSystem === system) {
      if (this.conversationEmpty) return this.client
      if (await this.resetConversation(this.client)) return this.client
      // The reset did not take — fall through to a respawn rather than judge
      // the next action against the previous one's context.
      this.teardown()
    } else if (this.client) {
      // Environment update → a different policy document. pi has no RPC to
      // swap the system prompt, so the process is replaced.
      logger.debug('PiJudge', 'system prompt changed — respawning the judge process')
      this.teardown()
    }
    return this.spawn(system)
  }

  /** `new_session` → true when the conversation is verifiably empty again. */
  private async resetConversation(client: PiJudgeClient): Promise<boolean> {
    try {
      const resp = await client.request<{ cancelled?: boolean }>({ type: 'new_session' })
      // An extension could cancel the switch (rpc.md) — we load none, but a
      // `cancelled: true` still means the old conversation is intact.
      if (!resp.success || resp.data?.cancelled) return false
      this.conversationEmpty = true
      return true
    } catch (err) {
      logger.debug(
        'PiJudge',
        `new_session failed (respawning instead): ${err instanceof Error ? err.message : String(err)}`
      )
      return false
    }
  }

  private async spawn(system: string): Promise<PiJudgeClient> {
    const bin = this.locateBinary()
    if (!bin) throw new Error('pi judge: pi binary not found')
    if (system.length > SYSTEM_PROMPT_WARN_CHARS) {
      logger.warn(
        'PiJudge',
        `policy prompt is ${system.length} chars — close to the Windows command-line limit; a spawn failure here falls back to asking the human`
      )
    }
    const client = this.createClient(bin, {
      cwd: this.opts.cwd,
      args: [...PI_JUDGE_BASE_ARGS, '--system-prompt', system]
    })
    await client.start()
    this.client = client
    this.spawnedSystem = system
    this.conversationEmpty = true
    // Forget a process that died on its own, so the next call spawns instead of
    // writing into a dead stdin. Identity-guarded: a stale exit must not clear a
    // successor (mirrors PiSession's own onExit identity guard).
    client.onExit(() => {
      if (this.client !== client) return
      this.client = null
      this.spawnedSystem = null
      this.conversationEmpty = false
    })

    // Best-effort, exactly like askSideQuestion's: a judge on pi's default
    // model is far better than no judge at all (which means "ask the human"
    // for every gated action).
    const model = this.opts.resolveModel()
    if (model) {
      try {
        await client.request({ type: 'set_model', provider: model.vendorId, modelId: model.modelId })
      } catch (err) {
        logger.debug(
          'PiJudge',
          `set_model failed (judge runs on pi's default): ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
    return client
  }

  /** One prompt → the assistant's text. Throws on anything unusable. */
  private async ask(client: PiJudgeClient, user: string): Promise<string> {
    // Registered BEFORE the prompt so a fast settle cannot race the listener
    // (same ordering askSideQuestion and drivePiTurn use).
    const settled = new Promise<void>((resolve) => {
      const unsubscribe = client.onEvent((ev) => {
        if (ev.type === 'agent_settled') {
          unsubscribe()
          resolve()
        }
      })
    })

    // Dirty from here on, whatever happens next.
    this.conversationEmpty = false
    const resp = await client.request({ type: 'prompt', message: user })
    if (!resp.success) throw new Error('pi judge: prompt was rejected')

    await settled
    const textResp = await client.request<PiGetLastAssistantTextData>({
      type: 'get_last_assistant_text'
    })
    const text = textResp.success ? textResp.data?.text : undefined
    if (!text) throw new Error('pi judge: no assistant text')
    return text
  }

  /**
   * Bound the whole call. On expiry the caller's `catch` tears the process
   * down, which rejects whatever request was still in flight — so nothing is
   * left running behind the timeout.
   */
  private withDeadline<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`pi judge: timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs
      )
      timer.unref?.()
      promise.then(
        (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        (e) => {
          clearTimeout(timer)
          reject(e)
        }
      )
    })
  }

  private teardown(): void {
    const client = this.client
    this.client = null
    this.spawnedSystem = null
    this.conversationEmpty = false
    try {
      client?.dispose()
    } catch (err) {
      logger.debug('PiJudge', `dispose failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
