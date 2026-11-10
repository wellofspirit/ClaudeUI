import type { AccountAPI } from './api/account'
import type { AutomationAPI } from './api/automation'
import type { FileAPI } from './api/files'
import type { GitAPI } from './api/git'
import type { McpAPI } from './api/mcp'
import type { PiAuthStatus } from './auth'
import type { PluginAPI } from './api/plugin'
import type { RemoteAPI } from './api/remote'
import type { SessionAPI } from './api/session'
import type { SharedProviderAPI } from './api/shared-provider'
import type { TerminalAPI } from './api/terminal'
import type { VendorAuthAPI } from './api/vendor-auth'
import type { VoiceAPI } from './api/voice'
import type { WebauthnAPI } from './api/webauthn'

export interface ClaudeAPI
  extends
    SessionAPI,
    GitAPI,
    McpAPI,
    TerminalAPI,
    AutomationAPI,
    FileAPI,
    AccountAPI,
    VendorAuthAPI,
    RemoteAPI,
    WebauthnAPI,
    VoiceAPI,
    SharedProviderAPI,
    PluginAPI {
  /** Relay a log message from the renderer to the main process logger */
  logRelay(level: string, source: string, message: string): void
  /** App + SDK version info for display in Settings */
  getVersionInfo(): Promise<{ appVersion: string; cliVersion: string }>
  /** Open the standalone log viewer window */
  openLogViewer(): Promise<void>
  /** The pi a user can run in a terminal (`locatePiDisplayPath()`): the resolved
   *  executable, or a System pi's shim rather than its `cli.js`; null if not
   *  found. Settings › pi's subscription hint block (`pi /login`). */
  getPiBinaryPath(): Promise<string | null>
  /** Read-only ChatGPT auth-vault connection status (M6c). Drives
   *  PiVendors.tsx's "Connect ChatGPT" UI — never returns token material. */
  getPiAuthStatus(): Promise<PiAuthStatus>
}
