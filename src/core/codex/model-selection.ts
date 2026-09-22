import type { Model } from './protocol/v2/Model'

export function selectCodexModel(
  catalog: Model[],
  configured: string | null | undefined,
  explicit?: string
): string | undefined {
  const model = explicit ?? configured ?? catalog.find((entry) => entry.isDefault)?.model
  if (model !== undefined && catalog.length && !catalog.some((entry) => entry.model === model))
    throw new Error('Codex requested model is unavailable in the native catalog')
  return model
}

export function assertCodexProvider(provider: string | null | undefined): void {
  if (provider && provider !== 'openai')
    throw new Error(
      'Codex currently supports only the native OpenAI provider; configured model_provider is unsupported'
    )
}
