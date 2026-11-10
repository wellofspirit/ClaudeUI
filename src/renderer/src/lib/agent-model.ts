/**
 * The model an agent row runs on, for the roster and the task card, which must
 * not disagree (so both call this).
 *
 * First match wins:
 *  1. the newest message of the agent's own transcript THAT HAS a `model`
 *     ({@link latestMessageModel}): what the engine reports it ran on. A newer
 *     message without one (an error row) does not clear it;
 *  2. the model the spawn asked for (`view.model`; for pi the host-written result
 *     line, which is the model the child was actually started on);
 *  3. none.
 * No parent fallback: a Claude `Explore` child runs Haiku by definition, and the
 * parent's model would be wrong until the first message and then flip.
 *
 * A cross-engine dispatch is the actual model if any message has one, else the
 * `dispatch.model` it asked the target engine for.
 */
import type { ChatMessage, EngineId, ModelInfo } from '../../../shared/types'
import { shortModelName } from '../components/usage/usage-utils'
import { modelDisplayName } from './model-display-name'

const byBucket = new WeakMap<readonly ChatMessage[], string | undefined>()

/**
 * The `model` of the newest assistant message that has one. Cached by array
 * identity, like the roster's transcript scan: the store replaces a bucket's
 * array on every change, so a hit is always current.
 */
export function latestMessageModel(
  messages: readonly ChatMessage[] | undefined
): string | undefined {
  if (!messages || messages.length === 0) return undefined
  if (byBucket.has(messages)) return byBucket.get(messages)
  let found: string | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && m.model) {
      found = m.model
      break
    }
  }
  byBucket.set(messages, found)
  return found
}

export interface AgentModelInput {
  /** {@link latestMessageModel} of the agent's transcript. */
  latestModel?: string
  /** The spawn's model (`view.model`). */
  requested?: string
  engine?: EngineId
  /** Set for a cross-engine dispatch. */
  dispatch?: { engine: string; model?: string }
}

export function resolveAgentModel(input: AgentModelInput): string | undefined {
  if (input.latestModel) return input.latestModel
  if (input.dispatch) return input.dispatch.model || undefined
  if (input.requested) return input.requested
  return undefined
}

/**
 * A short name for a model id the UI shows (the task card's chip, the settings
 * column), or undefined when only the raw id will do. In order: the picker's own
 * name for it; else the family short name the usage views derive for a Claude id
 * (`claude-opus-5-5` is "Opus 5.5"); else none, and the caller shows the id.
 */
export function agentModelShortName(
  models: readonly ModelInfo[],
  engineId: EngineId | undefined,
  model: string
): string | undefined {
  const named = modelDisplayName(models, engineId, model)
  if (named) return named
  const short = shortModelName(model)
  return short !== model ? short : undefined
}
