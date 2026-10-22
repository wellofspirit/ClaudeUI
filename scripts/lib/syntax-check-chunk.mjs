import { execFileSync } from 'node:child_process'

/**
 * Parse one standalone ESM chunk without evaluating code or resolving imports.
 * @returns {string|null} Node stderr on failure, null on success
 */
export function syntaxCheckChunk(bytes) {
  try {
    execFileSync(process.execPath, ['--input-type=module', '--check'], {
      input: bytes,
      stdio: ['pipe', 'ignore', 'pipe'],
      maxBuffer: 8 * 1024 * 1024
    })
    return null
  } catch (err) {
    return err.stderr?.toString() || err.message
  }
}
