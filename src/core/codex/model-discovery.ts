import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import type { EngineModelGroup } from '../../shared/types'
import { credentialSync } from '../auth/vault/CredentialSync'
import { CodexService } from './CodexService'
import { codexBinaryAvailable, locateCodexBinary } from './codex-locate'
import { assertCodexProvider } from './model-selection'

export interface CodexModelDiscoveryOptions {
  /** Ignore the memo and re-ask the binary. Nothing wires this yet except the tests. */
  refresh?: boolean
}

/**
 * The binary's identity: its located path plus size and mtime, both of which move
 * on a re-vendor. `null` means the identity could not be read — no install, or a
 * stat that threw — and a discovery keyed `null` still runs, it is simply never
 * memoised.
 */
function codexBinaryIdentity(): string | null {
  const path = locateCodexBinary()
  if (path === null) return null
  try {
    const stat = statSync(path)
    return `${path} ${stat.size} ${stat.mtimeMs}`
  } catch {
    return null
  }
}

/**
 * The identity the discovery runs under. Codex fills its catalog with
 * `RefreshStrategy::OnlineIfUncached` (`app-server/src/models.rs`): a signed-in
 * process may fetch the list online, so what a subscription can see is a
 * property of the account asking. `null` is the native-only login.
 */
async function activeAccountId(): Promise<string | null> {
  try {
    return (await credentialSync.getStatus()).activeId ?? null
  } catch {
    return null
  }
}

let memo: { key: string; groups: EngineModelGroup[] } | null = null
let inflight: { promise: Promise<EngineModelGroup[]> } | null = null

/**
 * The native model catalog, memoised for the life of the process per binary
 * identity and active account. Unlike opencode and pi, whose providers change
 * on the fly, Codex's list moves only with a re-vendor or a different signed-in
 * identity; without a memo every cwd change in the composer spawned and killed
 * one more app-server for an answer already known (and collided with the
 * session's own start, F8/F9).
 */
export async function discoverCodexModels(
  options: CodexModelDiscoveryOptions = {}
): Promise<EngineModelGroup[]> {
  if (!codexBinaryAvailable()) return []
  // Single-flight, reserved BEFORE the first await: boot lands two model
  // requests at once and the composer re-fetches on every cwd change, so
  // callers landing together share one discovery instead of racing each other
  // (the account lookup below is asynchronous, so the reservation cannot wait
  // for it). A refresh joins a discovery that is ALREADY spawning — it is asking
  // the binary right now, so its answer is as fresh as a second spawn's.
  if (inflight !== null) return inflight.promise
  const entry: { promise: Promise<EngineModelGroup[]> } = { promise: Promise.resolve([]) }
  inflight = entry
  entry.promise = (async () => {
    const binary = codexBinaryIdentity()
    // Keyed by binary AND account: a re-vendor moves the first, a switch the second.
    const key = binary === null ? null : `${binary} | ${(await activeAccountId()) ?? 'native'}`
    if (options.refresh) memo = null
    else if (memo !== null && key !== null && memo.key === key) return memo.groups
    const groups = await runDiscovery()
    // Only a succeeded, non-empty catalog is memoised, so a transient failure or
    // an empty answer never sticks for the life of the process.
    if (groups.length > 0 && key !== null) memo = { key, groups }
    return groups
  })()
  try {
    return await entry.promise
  } finally {
    if (inflight === entry) inflight = null
  }
}

async function runDiscovery(): Promise<EngineModelGroup[]> {
  // Discovery runs under the vault's ChatGPT account (ADR-068 §1): the catalog a
  // subscription can see is a property of the identity asking for it. Under
  // ADR-069 that account's HOST answers, so a discovery no longer spawns.
  const service = new CodexService({
    cwd: homedir(),
    identity: { accountId: null },
    label: 'discovery'
  })
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
