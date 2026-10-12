/**
 * Wire constants the voice worker and its host share — and nothing else.
 *
 * Deliberately a module with NO imports: the host (`local-voice-server.ts`, part
 * of the app's own bundle) needs the name of the token variable, and reaching it
 * through `main.ts` would pull the worker's server and recognizer code into
 * `index.js` for the sake of one string.
 */

/** The per-spawn secret's environment variable — env, never argv (argv is readable by every local user). */
export const VOICE_TOKEN_ENV = 'CLAUDEUI_VOICE_TOKEN'
