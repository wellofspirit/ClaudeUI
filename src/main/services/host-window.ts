/**
 * The desktop shell's primary window handle — or `null`, which is a real mode
 * (SyncCore phase 4d).
 *
 * Core boots before any window decision (`src/main/boot-core.ts`) and a
 * `CLAUDEUI_NO_WINDOW=1` run never makes one at all, so nothing on the sync,
 * session or service path may CAPTURE a window at registration time. Everything
 * that genuinely needs the host's window — the `host-local` delivery lane, a
 * native folder picker, the spawn handle engines hold for voice capture — reads
 * it from here, at use time, and copes with `null`.
 *
 * One handle, one owner: `createWindow()` publishes it, and it is the only
 * answer to "is there a host window?". A module that stored its own copy would
 * be a second answer that a windowless boot could not falsify — which is exactly
 * how "no window" stayed an untested edge case until 4d.
 */

import type { BrowserWindow } from 'electron'

let hostWindow: BrowserWindow | null = null

/**
 * Publish the host's primary window (or clear it). Called synchronously from
 * `createWindow()` BEFORE the window loads its document, so no renderer invoke
 * can observe an unpublished window; called with `null` by a windowless boot.
 */
export function setHostWindow(win: BrowserWindow | null): void {
  hostWindow = win
}

/** The host's primary window, or `null` when the app runs windowless. */
export function getHostWindow(): BrowserWindow | null {
  return hostWindow
}
