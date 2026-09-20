/**
 * Leaf types shared by the settings model, the shell, and the item bodies.
 *
 * This module exists to break a cycle: `settings-pages.tsx` imports the item
 * definitions from `settings-sections.tsx`, so `settings-sections.tsx` can never
 * import back from it — yet an item body (About, the sandbox cross-link) needs
 * the navigation vocabulary. Everything both sides need lives here, and nothing
 * here imports anything.
 */

/**
 * Every settings page id (ADR-065). Display ORDER is `PAGES`'s business; this
 * list exists so an id arriving from OUTSIDE the type system — an
 * `open-settings` event's detail — can be checked before it is trusted.
 */
export const SETTINGS_PAGE_IDS = [
  'appearance',
  'chat',
  'sessions',
  'advanced',
  'about',
  'models',
  'dispatch',
  'mockups',
  'remote',
  'claude',
  'opencode',
  'pi',
  'codex'
] as const

export type SettingsPageId = (typeof SETTINGS_PAGE_IDS)[number]

const isSettingsPageId = (value: unknown): value is SettingsPageId =>
  (SETTINGS_PAGE_IDS as readonly unknown[]).includes(value)

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
 *
 * Nor must an UNKNOWN page: a `CustomEvent` detail is untyped at runtime, and
 * the page lookup throws on an id it does not know — from inside render, so one
 * mistyped deep link took the whole window to the error boundary. An unknown
 * id opens Settings where it was, which is what the bare form does.
 */
export function settingsTargetFromEvent(event: Event): SettingsTarget | undefined {
  const detail = (event as CustomEvent<Partial<SettingsTarget> | undefined>).detail
  if (!isSettingsPageId(detail?.page)) return undefined
  return { page: detail.page, group: typeof detail.group === 'string' ? detail.group : undefined }
}

/**
 * Open Settings › Models & providers — the one answer for a credential ClaudeUI
 * cannot drive a flow for (ADR-030): an engine-native `opencode:*` / `pi:*`
 * token lives in that engine's own store, so a sign-in dialog would have
 * nothing to run. The pill, the transcript row and the dialog's provider list
 * all offer this escape for the same rows, so it has one definition — here,
 * beside the event shape it dispatches, in a leaf every one of them can import
 * without closing a cycle.
 */
export function openProviderSettings(): void {
  const detail: SettingsTarget = { page: 'models', group: 'providers' }
  window.dispatchEvent(new CustomEvent('open-settings', { detail }))
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
