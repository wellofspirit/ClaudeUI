/**
 * The auto-mode judge's candidate rules, shared by the judge settings
 * (`AutoModeSection`) and the replace dialog so the two surfaces cannot drift.
 *
 * ClaudeUI makes the judge's model call itself (ADR-081), so only models the
 * judge route resolver can call may be offered (`judgeModelSupport`). Until that
 * answer arrives, or if asking fails, every model stays listed: the session
 * refuses an unroutable judge at call time either way, with a banner.
 */
import { useEffect, useState } from 'react'
import type { AutoModeConfig, JudgeModelSupport, ModelInfo } from '../../../../shared/types'

export const FALLBACK_SAME_JUDGE_WARNING =
  'Same model on the same account as the judge — it would hit the same limit. Pick another model, or another account under Advanced.'

export type JudgeSupportMap = Record<string, JudgeModelSupport>

export interface JudgeSupportState {
  /** `loading` also covers "nothing to ask about": an empty model list is never asked. */
  status: 'loading' | 'answered' | 'failed'
  /** Per model value, whether ClaudeUI can call it as the judge; null = not known. */
  support: JudgeSupportMap | null
}

/**
 * Asks `judgeModelSupport` about `models` (an engine's own list). Keyed on the
 * engine and the model VALUES, not the array identity, and back to `loading`
 * whenever either changes.
 */
export function useJudgeModelSupport(
  engineId: 'opencode' | 'pi',
  models: ModelInfo[]
): JudgeSupportState {
  const valuesKey = models.map((m) => m.value).join('\n')
  const key = `${engineId}\n${valuesKey}`
  const [answer, setAnswer] = useState<{ key: string; support: JudgeSupportMap | null } | null>(
    null
  )

  useEffect(() => {
    // An empty list says nothing about routes (discovery found nothing), so
    // there is nothing to ask about.
    if (valuesKey === '') return
    let live = true
    window.api
      .judgeModelSupport(engineId, valuesKey.split('\n'))
      .then((support) => {
        if (live) setAnswer({ key, support })
      })
      .catch(() => {
        if (live) setAnswer({ key, support: null })
      })
    return () => {
      live = false
    }
  }, [engineId, valuesKey, key])

  if (answer?.key !== key) return { status: 'loading', support: null }
  return answer.support
    ? { status: 'answered', support: answer.support }
    : { status: 'failed', support: null }
}

/** Only an explicit refusal hides a model; an unanswered value stays listed. */
export function judgeCandidates(models: ModelInfo[], support: JudgeSupportMap | null): ModelInfo[] {
  return support ? models.filter((m) => support[m.value]?.ok !== false) : models
}

/**
 * The patch a fallback-judge choice writes. A model known NOT to route through
 * ChatGPT has one account: a saved fallback account would only mislabel it, so
 * it is cleared with it (and with an emptied choice).
 */
export function fallbackJudgePatch(
  value: string,
  support: JudgeSupportMap | null
): Pick<AutoModeConfig, 'fallbackJudgeModel' | 'fallbackJudgeAccount'> {
  return {
    fallbackJudgeModel: value || undefined,
    ...(!value || (support && support[value] && support[value].chatgpt !== true)
      ? { fallbackJudgeAccount: undefined }
      : {})
  }
}

/**
 * Same model on the same account as the judge would hit the very limit that sent
 * the call to the fallback. Another account (ChatGPT only) is the one thing that
 * makes it a new route.
 */
export function fallbackSameAsJudge({
  judge,
  fallback,
  fallbackAccount,
  activeAccountId,
  support
}: {
  judge: string
  fallback: string
  fallbackAccount: string
  activeAccountId: string | null
  support: JudgeSupportMap | null
}): boolean {
  const accountOn = fallbackAccount !== ''
  const fallbackIsChatgpt = support === null || support[fallback]?.chatgpt === true
  return (
    fallback !== '' &&
    fallback === judge &&
    (!accountOn || !fallbackIsChatgpt || fallbackAccount === activeAccountId)
  )
}
