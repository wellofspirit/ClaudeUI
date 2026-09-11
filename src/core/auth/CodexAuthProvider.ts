import { homedir } from 'node:os'
import type { EngineAuthProvider } from './EngineAuthProvider'
import type { VendorAuthMap } from '../../shared/types'
import type { CodexAuthStatus, CodexLoginState } from '../../shared/codex-types'
import { CodexService } from '../codex/CodexService'
import { codexBinaryAvailable } from '../codex/codex-locate'

export class CodexAuthProvider implements EngineAuthProvider {
  private state: CodexLoginState = { status: 'idle' }
  private cancel?: () => void

  constructor(private readonly service = new CodexService({ cwd: homedir() })) {}

  async status(): Promise<CodexAuthStatus> {
    if (!codexBinaryAvailable())
      return {
        available: false,
        authenticated: false,
        authKind: null,
        error: 'Codex is not installed for this platform'
      }
    const [status, catalog] = await Promise.all([
      this.service.accountStatus(),
      this.service
        .modelOptions()
        .then(({ catalog }) => ({ modelCount: catalog.filter((model) => !model.hidden).length }))
        .catch(() => ({
          catalogError:
            'The native default model/provider could not be resolved. Only native OpenAI is supported; choose an available model or check native configuration.'
        }))
    ])
    return status.available
      ? {
          available: true,
          authenticated: status.authenticated,
          authKind: status.authKind,
          ...catalog
        }
      : {
          available: status.failure !== 'unavailable',
          authenticated: false,
          authKind: null,
          error: 'Native Codex account status failed; retry or sign in explicitly'
        }
  }

  async probe(): Promise<VendorAuthMap> {
    const status = await this.status()
    return {
      openai: {
        authState:
          !status.available || status.error || status.authKind === 'amazonBedrock'
            ? 'unknown'
            : status.authenticated
              ? 'authenticated'
              : 'unauthenticated',
        billingType:
          status.authKind === 'chatgpt'
            ? 'subscription'
            : status.authKind === 'apiKey'
              ? 'apiKey'
              : 'unknown',
        requiresLogin: status.available && !status.error && !status.authenticated,
        error: status.error ?? status.catalogError,
        label: status.authKind === 'chatgpt' ? 'Native ChatGPT' : 'Native Codex'
      }
    }
  }

  loginStatus(): CodexLoginState {
    return { ...this.state }
  }

  async loginStart(): Promise<CodexLoginState> {
    if (!codexBinaryAvailable()) throw new Error('Codex is not installed for this platform')
    if (this.cancel) throw new Error('A native Codex login is already pending')
    this.state = { status: 'starting' }
    // Device flow is reachable from both hosts; never opens a host browser.
    let flow: ReturnType<CodexService['startLogin']>
    try {
      flow = this.service.startLogin({ type: 'chatgptDeviceCode' })
    } catch {
      this.state = { status: 'failed' }
      throw new Error('Native Codex login could not start')
    }
    this.cancel = flow.cancel
    void flow.completed.then((result) => {
      this.state = result
      this.cancel = undefined
    })
    const started = await flow.started.catch(() => {
      this.state = { status: 'failed' }
      flow.cancel()
      this.cancel = undefined
      throw new Error('Native Codex login failed to start')
    })
    if (started.type !== 'chatgptDeviceCode') throw new Error('Unexpected native login response')
    const url = new URL(started.verificationUrl)
    if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname)) {
      flow.cancel()
      throw new Error('Native login returned an unsupported verification URL')
    }
    if (this.loginStatus().status === 'starting')
      this.state = { status: 'waiting', verificationUrl: url.href, userCode: started.userCode }
    return this.loginStatus()
  }

  loginCancel(): void {
    this.cancel?.()
  }
  dispose(): void {
    this.service.dispose()
  }
}

export const codexAuthProvider = new CodexAuthProvider()
