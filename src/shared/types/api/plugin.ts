import type { PluginInfo, PluginViewWithOwner } from '../plugins'

export interface PluginAPI {
  listPlugins(): Promise<PluginInfo[]>
  reloadPlugin(id: string): Promise<void>
  getPluginViews(): Promise<PluginViewWithOwner[]>
  getPluginPreloadPath(): Promise<string>
  onPluginViewsChanged(cb: (views: PluginViewWithOwner[]) => void): () => void

  // Mockup preview
  readMockupHtml(cwd: string, directory: string): Promise<string>
  watchMockup(cwd: string, directory: string): Promise<void>
  unwatchMockup(cwd: string, directory: string): Promise<void>
  /**
   * The iframe `src` for a mockup preview. Platform-specific transport:
   * desktop returns a `mockup-asset://` URL (privileged Electron protocol);
   * the web client returns an HTTP URL on the remote server. Synchronous —
   * it's a pure URL builder.
   */
  getMockupPreviewUrl(cwd: string, directory: string, opts?: { dark?: boolean }): string
}
