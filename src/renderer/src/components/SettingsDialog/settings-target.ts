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

/**
 * Key of a group's engine-segment selection: `<pageId>/<groupId>`.
 *
 * Both presentations and the container index `engineByGroup` with it, so it
 * lives here rather than in either view — a phone and a desktop that disagreed
 * about the key would show two different engines for the same card after a
 * rotation.
 */
export const groupKey = (page: SettingsPageId, group: string): string => `${page}/${group}`

/**
 * The `{ page, group? }` detail of an `open-settings` event, or `undefined` for
 * the bare "just open Settings" form.
 *
 * Both dialog hosts (SettingsPanel on the desktop, SessionView on the phone)
 * parse the same event, and a detail without a `page` must NOT become a target
 * — `{ page: undefined }` would navigate the dialog to a page that does not
 * exist instead of leaving it on the last one.
 */
export function settingsTargetFromEvent(event: Event): SettingsTarget | undefined {
  const detail = (event as CustomEvent<Partial<SettingsTarget> | undefined>).detail
  return detail?.page ? { page: detail.page, group: detail.group } : undefined
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
