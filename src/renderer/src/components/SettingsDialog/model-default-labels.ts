/**
 * The "no explicit choice" row of each settings model picker, in one place so a
 * dialog that edits the same setting (ReplaceModelReferencesDialog) reads the
 * same words as the setting's own row.
 */
import { PI_DEFAULT_MODEL } from '../../../../shared/engine-meta'

/** Label for the judge-model picker's "no explicit choice" row (judgeModel unset). */
export const JUDGE_MODEL_DEFAULT_LABEL = 'Same as session model (default)'
/** Label for the fallback-judge picker's "no explicit choice" row (fallbackJudgeModel unset). */
export const FALLBACK_JUDGE_EMPTY_LABEL = 'None (ask me instead)'
/** Label for the dispatch default-model picker's "no explicit choice" row. */
export const DISPATCH_MODEL_DEFAULT_LABEL = '(not set)'
/** Label for the opencode default/small model pickers' "no explicit choice" row. */
export const OPENCODE_MODEL_DEFAULT_LABEL = 'Default (use opencode default)'
/** Label for pi's default-model picker's "no explicit choice" row. */
export const PI_MODEL_DEFAULT_LABEL = `Default (${PI_DEFAULT_MODEL})`
