import { CodexAppServerClient, type CodexClientOptions } from './CodexAppServerClient'
import type { CodexMethods } from './protocol/methods'
import type { InitializeParams } from './protocol/InitializeParams'

/** Typed host-only API. The generic transport remains available for protocol probes. */
export class CodexClient {
  private readonly transport: CodexAppServerClient

  constructor(options: CodexClientOptions) {
    this.transport = new CodexAppServerClient(options)
  }

  start(params: InitializeParams) {
    return this.transport.start(params)
  }

  request<M extends keyof CodexMethods>(
    method: M,
    params: CodexMethods[M]['params']
  ): Promise<CodexMethods[M]['result']> {
    return this.transport.request(method, params)
  }

  abortServerRequests(threadId: string, turnId: string): void {
    this.transport.abortServerRequests(threadId, turnId)
  }

  dispose(): void {
    this.transport.dispose()
  }
}
