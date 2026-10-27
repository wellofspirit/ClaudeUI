/** Overview / model / endpoint fixtures for the OpenRouter tab's tests. */

import type {
  OpenRouterEndpointRow,
  OpenRouterKeyInfo,
  OpenRouterModelRow,
  OpenRouterOverview
} from '../../../../../shared/openrouter'

export function makeKey(overrides: Partial<OpenRouterKeyInfo> = {}): OpenRouterKeyInfo {
  return {
    label: 'sk-or-v1-…abc',
    limitUsd: 100,
    limitRemainingUsd: 57.5,
    limitReset: 'monthly',
    resetsAt: '2099-01-01T00:00:00Z',
    includeByokInLimit: false,
    usage: { dailyUsd: 0, weeklyUsd: 3.25, monthlyUsd: 42.5, totalUsd: 210.75 },
    byokUsage: { dailyUsd: 0, weeklyUsd: 0, monthlyUsd: 0, totalUsd: 0 },
    isFreeTier: false,
    expiresAt: null,
    dataRegions: ['global'],
    freeModelRequests: { used: 0, limit: 1000, remaining: 1000 },
    ...overrides
  }
}

export function makeOverview(overrides: Partial<OpenRouterOverview> = {}): OpenRouterOverview {
  return {
    fetchedAt: Date.now(),
    key: makeKey(),
    credits: { totalUsd: 1500, usedUsd: 480.25 },
    models: { available: 2, total: 464 },
    ledger: { sinceUtc: '2026-10-01T00:00:00Z', costUsd: 41.1, machines: 1 },
    partialErrors: {},
    ...overrides
  }
}

export function makeModel(overrides: Partial<OpenRouterModelRow> = {}): OpenRouterModelRow {
  return {
    id: 'deepseek/deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    contextLength: 1_048_576,
    promptPerM: 0.195,
    completionPerM: 0.78,
    cacheReadPerM: 0.0039,
    inputModalities: ['text', 'image'],
    reasoning: true,
    intelligenceIndex: 24.7,
    codingIndex: null,
    ...overrides
  }
}

export function makeEndpoint(
  overrides: Partial<OpenRouterEndpointRow> = {}
): OpenRouterEndpointRow {
  return {
    provider: 'Together',
    tag: 'together',
    quantization: null,
    promptPerM: 0.3,
    completionPerM: 1.2,
    contextLength: 1_048_576,
    status: 0,
    uptime1d: 100,
    uptime30m: 100,
    latencyP50Ms: 619,
    throughputP50: 208,
    ...overrides
  }
}
