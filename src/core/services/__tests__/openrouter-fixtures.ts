/**
 * Trimmed OpenRouter responses (probed 2026-10-27, regular inference key) for
 * `openrouter-dashboard.test.ts`. Committed to a public repo, so every account
 * identifier is a placeholder: creator id, workspace id and the key label.
 */

export const KEY_BODY = {
  data: {
    label: 'sk-or-v1-...abc',
    is_management_key: false,
    is_provisioning_key: false,
    limit: 100,
    limit_reset: 'monthly',
    limit_remaining: 57.5,
    include_byok_in_limit: false,
    budgets: [
      {
        scope: 'key_limit',
        guardrail_id: null,
        budget_id: null,
        limit_usd: 100,
        spend_usd: 42.5,
        remaining_usd: 57.5,
        reset_interval: 'monthly',
        resets_at: '2026-11-01T00:00:00.000Z',
        include_byok: false
      }
    ],
    effective_budget: {
      scope: 'key_limit',
      guardrail_id: null,
      budget_id: null,
      limit_usd: 100,
      spend_usd: 42.5,
      remaining_usd: 57.5,
      reset_interval: 'monthly',
      resets_at: '2026-11-01T00:00:00.000Z',
      include_byok: false
    },
    usage: 210.75,
    usage_daily: 0,
    usage_weekly: 3.25,
    usage_monthly: 42.5,
    byok_usage: 1.5,
    byok_usage_daily: 0,
    byok_usage_weekly: 0.5,
    byok_usage_monthly: 1,
    is_free_tier: false,
    expires_at: null,
    creator_user_id: 'user_TEST',
    organization_id: null,
    workspace_id: '00000000-0000-0000-0000-000000000000',
    allowed_data_regions: ['global'],
    free_model_daily_requests: { used: 0, limit: 1000, remaining: 1000 },
    rate_limit: {
      requests: -1,
      interval: '10s',
      note: 'This field is deprecated and safe to ignore.'
    }
  }
}

export const CREDITS_BODY = { data: { total_credits: 1500, total_usage: 480.25 } }

export const COUNT_BODY = { data: { count: 464 } }

const MODEL_BASE = {
  hugging_face_id: null,
  created: 1792225624,
  description: 'trimmed',
  top_provider: { context_length: 1048576, max_completion_tokens: 393216, is_moderated: false },
  per_request_limits: null
}

/** `/models/user`: three rows, one of them without reasoning support. */
export const MODELS_USER_BODY = {
  data: [
    {
      ...MODEL_BASE,
      id: 'deepseek/deepseek-v4.1-flash-1017',
      canonical_slug: 'deepseek/deepseek-v4.1-flash-20261017',
      name: 'DeepSeek: DeepSeek V4.1 Flash 1017',
      context_length: 1048576,
      architecture: {
        modality: 'text+image->text',
        input_modalities: ['text', 'image'],
        output_modalities: ['text']
      },
      pricing: {
        prompt: '0.000000195',
        completion: '0.00000078',
        input_cache_read: '0.0000000039'
      },
      supported_parameters: ['max_tokens', 'reasoning', 'tools']
    },
    {
      ...MODEL_BASE,
      id: 'moonshotai/kimi-k3',
      canonical_slug: 'moonshotai/kimi-k3-20260715',
      name: 'MoonshotAI: Kimi K3',
      context_length: 1048576,
      architecture: {
        modality: 'text->text',
        input_modalities: ['text'],
        output_modalities: ['text']
      },
      pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' },
      supported_parameters: ['max_tokens', 'tools']
    },
    {
      ...MODEL_BASE,
      id: 'z-ai/glm-5.3-flash',
      canonical_slug: 'z-ai/glm-5.3-flash-20260826',
      name: 'Z.ai: GLM 5.3 Flash',
      context_length: 262144,
      architecture: {
        modality: 'text->text',
        input_modalities: ['text'],
        output_modalities: ['text']
      },
      pricing: { prompt: '0.000000084', completion: '0.00000028' },
      supported_parameters: ['reasoning']
    }
  ],
  total_count: 3
}

/** `/models`: the public catalog; the router row prices at -1 (no fixed price). */
export const MODELS_ALL_BODY = {
  data: [
    ...MODELS_USER_BODY.data,
    {
      ...MODEL_BASE,
      id: 'openrouter/auto',
      canonical_slug: 'openrouter/auto',
      name: 'Auto Router',
      context_length: 2000000,
      architecture: {
        modality: 'text->text',
        input_modalities: ['text'],
        output_modalities: ['text']
      },
      pricing: { prompt: '-1', completion: '-1' },
      supported_parameters: ['max_tokens']
    }
  ],
  total_count: 4
}

/**
 * `/benchmarks`: Artificial Analysis rows carry the indices; other sources have
 * none. Two rows share the DeepSeek slug (variants), and the higher wins.
 */
export const BENCHMARKS_BODY = {
  data: [
    {
      source: 'artificial-analysis',
      model_permaslug: 'moonshotai/kimi-k3-20260715',
      display_name: 'Kimi K3 (Max)',
      intelligence_index: 43.6,
      coding_index: 76.2,
      agentic_index: 50
    },
    {
      source: 'design-arena',
      model_permaslug: 'moonshotai/kimi-k3-20260715',
      display_name: 'Kimi K3',
      arena: 'models',
      category: '3d',
      elo: 1385
    },
    {
      source: 'artificial-analysis',
      model_permaslug: 'deepseek/deepseek-v4.1-flash-20261017',
      display_name: 'DeepSeek V4.1 Flash (Non-reasoning)',
      intelligence_index: 24.7,
      coding_index: 50.1
    },
    {
      source: 'artificial-analysis',
      model_permaslug: 'deepseek/deepseek-v4.1-flash-20261017',
      display_name: 'DeepSeek V4.1 Flash (Max)',
      intelligence_index: 39.5,
      coding_index: null
    }
  ],
  meta: {}
}

/** `/models/deepseek/deepseek-v4.1-flash/endpoints`: two providers, one degraded. */
export const ENDPOINTS_BODY = {
  data: {
    id: 'deepseek/deepseek-v4.1-flash',
    name: 'DeepSeek: DeepSeek V4.1 Flash',
    endpoints: [
      {
        name: 'OpenInference | deepseek/deepseek-v4.1-flash-20260910',
        model_id: 'deepseek/deepseek-v4.1-flash',
        context_length: 1048576,
        pricing: {
          prompt: '0.00000002',
          completion: '0.000000081571',
          input_cache_read: '0.000000015',
          discount: 0
        },
        provider_name: 'OpenInference',
        tag: 'open-inference/fp4',
        quantization: 'fp4',
        status: 0,
        uptime_last_30m: 100,
        uptime_last_5m: 100,
        uptime_last_1d: 97.98611111111111,
        latency_last_30m: { p50: 732, p75: 1395.25 },
        throughput_last_30m: { p50: 91, p75: 53 }
      },
      {
        name: 'Relace | deepseek/deepseek-v4.1-flash-20260910',
        model_id: 'deepseek/deepseek-v4.1-flash',
        context_length: 1048576,
        pricing: { prompt: '0.00000007', completion: '0.0000005', discount: 0 },
        provider_name: 'Relace',
        tag: 'relace',
        quantization: 'unknown',
        status: -2,
        uptime_last_30m: 80.5,
        uptime_last_1d: null,
        latency_last_30m: null,
        throughput_last_30m: { p50: null }
      }
    ]
  }
}
