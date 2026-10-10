/**
 * Subagent children's rulesets on opencode 2.x (ADR-097 §3, S6) — one
 * implementation for the chat (`OpencodeSession`, S5) and the dispatcher's
 * opencode targets (`cross-engine-dispatcher.ts`, S9).
 *
 * A child copies its parent's WHOLE session ruleset at creation, after its own
 * agent's rules, so a parent allow outranks the agent's deny until ClaudeUI
 * PATCHes `childSessionRuleset(parent, agent)` onto it — on
 * `session.created{parentID}`, on the child's `session.agent.selected` and on
 * every parent re-apply (the child's copy is a snapshot). The `claudeui-xeng`
 * plugin holds the agent's own rules meanwhile; {@link
 * ChildRulesetKeeper.refusal} is the host's backstop for an ask that comes
 * before the PATCH (or that the agent carves itself).
 *
 * PATCHes are serialized per child and read the parent's rules after every
 * await, so the last one to land is always the newest. A PATCH that fails
 * twice fails CLOSED: the child is interrupted and its asks are refused until
 * a PATCH lands.
 */
import type { OpencodeClient } from './OpencodeClient'
import type { Agent_Info } from './protocol-v2/openapi'
import type { V2Rule } from './permission-v2'
import { childSessionRuleset, evaluateChildCall } from './subagent-permissions'
import { logger } from '../services/logger'

/**
 * Test seam: hold every child ruleset PATCH until the returned promise
 * settles (the contract proves the plugin hook closes the create → PATCH
 * window without winning a race). Null in production.
 */
let childPatchGate: ((childID: string) => Promise<void>) | null = null
export function __holdChildPatchesForTests(
  gate: ((childID: string) => Promise<void>) | null
): void {
  childPatchGate = gate
}

/** A subagent child (or grandchild) of the root session. */
interface ChildSession {
  readonly parentID: string
  /** The child's agent id (`session.created.agent`, then `session.agent.selected`). */
  agent?: string
  /** The ruleset last computed for it (what a grandchild's ruleset builds on). */
  rules?: V2Rule[]
  /** What was last PATCHed (skip an unchanged one). */
  patchedKey?: string
  /** The parent ruleset (its key) the child's rules were last computed from. */
  parentKey?: string
  /** PATCHes for this child run one at a time, in order (never a stale one last). */
  chain: Promise<void>
  /**
   * Its ruleset could not be applied (twice): the child was interrupted and
   * every ask it raises is refused until a PATCH lands (fail closed).
   */
  unpatched?: boolean
}

/** The client calls the keeper makes. */
export type ChildRulesetClient = Pick<
  OpencodeClient,
  'setSessionPermissions' | 'interrupt' | 'getSession' | 'listSessions'
>

/** What the keeper reads from its owner (read on every use: leases change). */
export interface ChildRulesetHost {
  /** The current lease's client, or null when disconnected. */
  client(): ChildRulesetClient | null
  /** The root opencode session (the chat's own, or the dispatch target). */
  rootSessionId(): string | null
  /** The ruleset last applied to the root, or undefined before the first apply. */
  rootRules(): readonly V2Rule[] | undefined
  /** Loads (and caches) the agent list; null when it cannot be read. */
  loadAgents(): Promise<readonly Agent_Info[] | null>
  /** A cached agent by id (the default agent for an unnamed one). */
  agentInfo(id: string | undefined): Agent_Info | undefined
  /** The logger source of the owner. */
  readonly logSource: string
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export class ChildRulesetKeeper {
  private readonly children = new Map<string, ChildSession>()

  constructor(private readonly host: ChildRulesetHost) {}

  has(sessionID: string): boolean {
    return this.children.has(sessionID)
  }

  /** `session.created`: a child of the root (or of a known child) — learn it and PATCH it. */
  onSessionCreated(data: { sessionID: string; parentID?: string; agent?: string }): void {
    const { sessionID, parentID } = data
    const root = this.host.rootSessionId()
    if (!parentID || sessionID === root) return
    if (parentID !== root && !this.children.has(parentID)) return
    if (!this.children.has(sessionID))
      this.children.set(sessionID, {
        parentID,
        chain: Promise.resolve(),
        ...(data.agent ? { agent: data.agent } : {})
      })
    void this.patchChild(sessionID)
  }

  /** `session.agent.selected` on a known child: its agent's rules changed. */
  onAgentSelected(data: { sessionID: string; agent: string }): void {
    const child = this.children.get(data.sessionID)
    if (!child || child.agent === data.agent) return
    child.agent = data.agent
    void this.patchChild(data.sessionID, true)
  }

  /** Re-derive every direct child (each cascades to its own); unchanged parents are skipped. */
  repatchChildren(): void {
    const root = this.host.rootSessionId()
    for (const [childID, child] of this.children)
      if (child.parentID === root) void this.patchChild(childID)
  }

  /**
   * PATCH `childSessionRuleset(parent's rules, its agent's rules)` onto a
   * child, then onto its own children — skipped when the parent ruleset it was
   * computed from is unchanged (`force`: its agent changed).
   */
  patchChild(childID: string, force = false): Promise<void> {
    const child = this.children.get(childID)
    if (!child) return Promise.resolve()
    const next = child.chain.then(() => this.patchChildNow(childID, force))
    child.chain = next.catch(() => {})
    return next
  }

  private async patchChildNow(childID: string, force: boolean): Promise<void> {
    const child = this.children.get(childID)
    const client = this.host.client()
    if (!child || !client) return
    if (childPatchGate) await childPatchGate(childID)
    await this.host.loadAgents()
    const parentRules =
      child.parentID === this.host.rootSessionId()
        ? this.host.rootRules()
        : this.children.get(child.parentID)?.rules
    if (!parentRules) return
    const parentKey = JSON.stringify(parentRules)
    if (!force && !child.unpatched && child.parentKey === parentKey) return
    const agent = this.host.agentInfo(child.agent)
    if (!agent)
      logger.warn(
        this.host.logSource,
        `subagent ${child.agent ?? '(default)'}: agent rules unknown — the child gets the parent's rules (its agent's own rules still hold in the plugin hook)`
      )
    const rules = childSessionRuleset(parentRules, agent?.permissions ?? [])
    child.rules = rules
    child.parentKey = parentKey
    const key = JSON.stringify(rules)
    if (child.patchedKey !== key || child.unpatched) {
      let failure: unknown
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await client.setSessionPermissions(childID, rules)
          failure = undefined
          break
        } catch (err) {
          failure = err
        }
      }
      if (failure === undefined) {
        child.patchedKey = key
        child.unpatched = false
      } else {
        // FAIL CLOSED: a child left on a stale (looser) snapshot must not run on.
        child.unpatched = true
        logger.error(
          this.host.logSource,
          `child ruleset PATCH failed twice (${childID}) — interrupting it: ${errText(failure)}`
        )
        void Promise.resolve()
          .then(() => client.interrupt(childID))
          .catch((err) =>
            logger.warn(this.host.logSource, `child interrupt failed: ${errText(err)}`)
          )
      }
    }
    for (const [grandchildID, grandchild] of this.children)
      if (grandchild.parentID === childID) void this.patchChild(grandchildID)
  }

  /**
   * A resumed root's children from an earlier process (any of them can be
   * resumed by a later call with its `sessionID`): learn them all (breadth
   * first, at most `maxReads` lists). The next parent apply PATCHes them.
   */
  async adoptStored(maxReads: number): Promise<void> {
    const client = this.host.client()
    const own = this.host.rootSessionId()
    if (!client || !own) return
    const queue = [own]
    for (let read = 0; queue.length > 0 && read < maxReads; read++) {
      const parentID = queue.shift()!
      let listed: Awaited<ReturnType<ChildRulesetClient['listSessions']>>
      try {
        listed = await client.listSessions({ parentID })
      } catch (err) {
        logger.debug(this.host.logSource, `children of ${parentID} not listed: ${errText(err)}`)
        continue
      }
      for (const info of listed) {
        if (this.children.has(info.id) || info.id === own) continue
        this.children.set(info.id, {
          parentID,
          chain: Promise.resolve(),
          ...(info.agent ? { agent: info.agent } : {})
        })
        queue.push(info.id)
      }
    }
  }

  /** A re-read linked children whose `session.created` fell in a gap: learn and PATCH them. */
  async adoptUnknown(followed: readonly string[]): Promise<void> {
    const client = this.host.client()
    if (!client) return
    const root = this.host.rootSessionId()
    for (const id of followed) {
      if (id === root || this.children.has(id)) continue
      try {
        const info = await client.getSession(id)
        if (!info.parentID) continue
        this.onSessionCreated({
          sessionID: id,
          parentID: info.parentID,
          ...(info.agent ? { agent: info.agent } : {})
        })
      } catch (err) {
        logger.debug(this.host.logSource, `child ${id} not readable: ${errText(err)}`)
      }
    }
  }

  /**
   * S6 backstop: the reject message for a child's ask its OWN agent denies
   * (the window before the child's ruleset PATCH lands, or a deny the agent
   * carves itself), or for any ask of a child whose PATCH failed; undefined
   * when the keeper has nothing to say.
   */
  refusal(
    approval: { toolName: string; patterns?: readonly string[] },
    childID: string
  ): string | undefined {
    const child = this.children.get(childID)
    if (!child) return undefined
    if (child.unpatched) {
      logger.info(
        this.host.logSource,
        `child ask ${approval.toolName} refused: its ruleset is not applied`
      )
      return "ClaudeUI could not apply this subagent's permission rules, so its tool calls are refused"
    }
    const agent = this.host.agentInfo(child.agent)
    if (!agent) return undefined
    const resources = approval.patterns && approval.patterns.length > 0 ? approval.patterns : ['*']
    const denied = resources.find(
      (resource) => evaluateChildCall(agent.permissions, approval.toolName, resource) === 'deny'
    )
    if (denied === undefined) return undefined
    logger.info(
      this.host.logSource,
      `child ask ${approval.toolName} refused by its agent ${agent.id}`
    )
    return `Denied by the ${agent.id} agent's permission rules: ${approval.toolName}(${denied})`
  }
}
