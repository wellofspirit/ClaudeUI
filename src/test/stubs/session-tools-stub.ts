/**
 * The session tools' service, stubbed for suites that double `sync-host` with just
 * `emitEvent`: CodexSession, PiSession and OpencodeSession import the real module,
 * whose import pulls in the canonical-state graph (`syncCore`) those doubles do not
 * carry. The tools are off here (`sessionToolsAvailable()` is false), so a session
 * advertises none and runs none.
 *
 *   vi.mock('../../core/services/session-tools', async () => await import('../../test/stubs/session-tools-stub'))
 */
export const configureSessionTools = (): void => {}
export const sessionToolsAvailable = (): boolean => false
export const sessionToolsGate = (): { behavior: 'deny'; message: string } => ({
  behavior: 'deny',
  message: 'The session tools are stubbed in this suite'
})
export const runSessionTool = async (): Promise<{ text: string; isError: true }> => ({
  text: 'The session tools are stubbed in this suite',
  isError: true
})
export const auditSessionToolDenial = (): void => {}
