import type { ModelTier } from '../../../shared/model-tier'

/**
 * The text colour of each model tier (`--color-model-tier-*` in app.css). Whole
 * class names: Tailwind reads source text, so a template would emit nothing.
 */
export const MODEL_TIER_TEXT_CLASS: Record<ModelTier, string> = {
  top: 'text-model-tier-top',
  high: 'text-model-tier-high',
  mid: 'text-model-tier-mid',
  low: 'text-model-tier-low'
}
