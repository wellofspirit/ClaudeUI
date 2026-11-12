import { describe, expect, it, vi } from 'vitest'
import { createCoreStop, type CoreStopDeps } from '../core-stop'

function harness(prepareQuit: () => Promise<void> = () => Promise.resolve()): {
  deps: CoreStopDeps
  calls: string[]
  onPrepareError: ReturnType<typeof vi.fn>
} {
  const calls: string[] = []
  const rec = (name: string) => (): void => void calls.push(name)
  const onPrepareError = vi.fn()
  return {
    calls,
    onPrepareError,
    deps: {
      credentialSync: {
        prepareQuit: () => {
          calls.push('credentialSync.prepareQuit')
          return prepareQuit()
        },
        stop: rec('credentialSync.stop')
      },
      automationManager: { stopAll: rec('automationManager.stopAll') },
      hostAnchor: { stop: rec('hostAnchor.stop') },
      usageHubClient: { stop: rec('usageHubClient.stop') },
      releaseDispatchParents: rec('releaseDispatchParents'),
      serviceSession: { stop: rec('serviceSession.stop') },
      opencodeServerManager: { dispose: rec('opencodeServerManager.dispose') },
      localVoiceServer: {
        stop: () => {
          calls.push('localVoiceServer.stop')
          return Promise.resolve()
        }
      },
      onPrepareError
    }
  }
}

describe('createCoreStop', () => {
  it('stop() runs the host-neutral steps in the desktop teardown order', () => {
    const { deps, calls } = harness()
    createCoreStop(deps).stop()
    expect(calls).toEqual([
      'automationManager.stopAll',
      'credentialSync.stop',
      'hostAnchor.stop',
      'usageHubClient.stop',
      'releaseDispatchParents',
      'serviceSession.stop',
      'opencodeServerManager.dispose',
      'localVoiceServer.stop'
    ])
  })

  it('prepareStop() calls credentialSync.prepareQuit()', async () => {
    const { deps, calls } = harness()
    await createCoreStop(deps).prepareStop()
    expect(calls).toEqual(['credentialSync.prepareQuit'])
  })

  it('prepareStop() resolves and reports when prepareQuit rejects', async () => {
    const err = new Error('boom')
    const { deps, onPrepareError } = harness(() => Promise.reject(err))
    await expect(createCoreStop(deps).prepareStop()).resolves.toBeUndefined()
    expect(onPrepareError).toHaveBeenCalledWith(err)
  })
})
