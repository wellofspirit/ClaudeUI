import { homedir } from 'node:os'
import type { EngineModelGroup } from '../../shared/types'
import { CodexService } from './CodexService'
import { codexBinaryAvailable } from './codex-locate'
import { assertCodexProvider } from './model-selection'

export async function discoverCodexModels(): Promise<EngineModelGroup[]> {
  if (!codexBinaryAvailable()) return []
  const service = new CodexService({ cwd: homedir() })
  try {
    const [catalog, config] = await Promise.all([service.models(), service.effectiveConfig()])
    assertCodexProvider(config.model_provider)
    const model = config.model ?? catalog.find((entry) => entry.isDefault)?.model
    const visible = catalog.filter((entry) => !entry.hidden)
    visible.sort((a, b) => Number(b.model === model) - Number(a.model === model))
    return visible.length
      ? [
          {
            engineId: 'codex',
            vendorId: 'openai',
            vendorName: 'Native OpenAI',
            models: visible.map((entry) => ({
              value: entry.model,
              displayName: entry.displayName,
              description: entry.description,
              engineId: 'codex',
              vendorId: 'openai',
              supportsEffort: false,
              supportsAdaptiveThinking: false,
              supportsAutoMode: false,
              vision: entry.inputModalities.includes('image'),
              toolCalling: true,
              nativeEffortOptions: entry.supportedReasoningEfforts.map((option) => ({
                value: option.reasoningEffort,
                description: option.description
              })),
              nativeDefaultEffort: entry.defaultReasoningEffort
            }))
          }
        ]
      : []
  } finally {
    service.dispose()
  }
}
