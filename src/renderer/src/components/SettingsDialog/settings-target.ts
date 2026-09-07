/**
 * Leaf types shared by the settings model, the shell, and the item bodies.
 *
 * This module exists to break a cycle: `settings-pages.tsx` imports the item
 * definitions from `settings-sections.tsx`, so `settings-sections.tsx` can never
 * import back from it — yet an item body (About, the sandbox cross-link) needs
 * the navigation vocabulary. Everything both sides need lives here, and nothing
 * here imports anything.
 */

/** The 11 settings pages (ADR-065). Order is defined by `PAGES`. */
export type SettingsPageId =
  | 'appearance'
  | 'chat'
  | 'sessions'
  | 'advanced'
  | 'models'
  | 'dispatch'
  | 'mockups'
  | 'remote'
  | 'claude'
  | 'opencode'
  | 'pi'

/** A place in the settings dialog: a page, optionally a group inside it. */
export interface SettingsTarget {
  page: SettingsPageId
  group?: string
}

export interface VersionInfo {
  appVersion: string
  cliVersion: string
}

/**
 * The 7th positional argument of `SettingItem.render`. Optional for every
 * existing body (they declare fewer parameters and ignore it); used by the
 * rows that show app metadata or link to another page.
 */
export interface SettingsRenderContext {
  versionInfo: VersionInfo | null
  navigate: (target: SettingsTarget) => void
}
