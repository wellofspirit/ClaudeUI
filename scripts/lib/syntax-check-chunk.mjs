import { execFileSync } from 'node:child_process'

/**
 * Args that make Node parse stdin as one ESM module without evaluating it or
 * resolving its imports (`--check` only parses).
 */
const CHECK_ARGS = ['--input-type=module', '--check']

/** A hung check must fail the build, not hang it. */
const TIMEOUT_MS = 60_000

const MAX_BUFFER = 8 * 1024 * 1024

/**
 * Canary sources. A real Node rejects the first with a SyntaxError on stderr and
 * accepts the second. Bun cannot: its `--check` is a project-wide TypeScript
 * check that never parses the piped chunk, so it either accepts the malformed
 * source or exits with tsc diagnostics — and Bun's `node` shim
 * (`%TEMP%\bun-node-<rev>\node.exe`) exits 1 for everything. Both fail one of
 * the two canaries, so neither can be mistaken for a checker.
 */
const INVALID_CANARY = 'export const value = ;'
const VALID_CANARY = 'export {}'

/**
 * The runtime to check with: our own binary when the host is Node, `node` from
 * PATH when it is Bun. It is only a candidate — `validate()` proves it parses.
 * @returns {string}
 */
function nodeCommand() {
  return process.versions.bun ? 'node' : process.execPath
}

/** @param {any} err @returns {string} */
function stderrOf(err) {
  const stderr = err?.stderr
  return stderr ? stderr.toString() : ''
}

/** @param {string} text @returns {string} */
function firstLine(text) {
  return (
    text
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() ?? text.trim()
  )
}

/**
 * Why a spawn produced no usable diagnostic: a timeout, a signal, a non-zero
 * exit with empty stderr, or a spawn error (ENOENT, …).
 * @param {any} err
 * @returns {string}
 */
function describeSpawnFailure(err) {
  if (err?.code === 'ETIMEDOUT') return `timed out after ${TIMEOUT_MS} ms`
  if (err?.signal) return `was killed by ${err.signal}`
  if (typeof err?.status === 'number') return `exited ${err.status} without a diagnostic`
  return firstLine(String(err?.message ?? err))
}

/**
 * Build a chunk checker backed by `command`. The command is proved once, with
 * the canary, on the first check and then reused, so a fake command (or a Bun
 * shim) cannot quietly pass every chunk.
 *
 * @param {string} [command] executable to spawn; defaults to a Node candidate
 * @param {string[]} [checkArgs] args that syntax-check stdin (test seam)
 */
export function createSyntaxChecker(command = nodeCommand(), checkArgs = CHECK_ARGS) {
  let validated = false
  let version = ''

  /**
   * @param {string[]} args
   * @param {Buffer|string} [input]
   * @param {('pipe'|'ignore')[]} [stdio]
   */
  function spawn(args, input, stdio = ['pipe', 'ignore', 'pipe']) {
    return execFileSync(command, args, {
      input,
      stdio,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER
    })
  }

  /** @param {string} detail @returns {Error} */
  function notRealNode(detail) {
    return new Error(
      `syntax check needs a real Node.js: "${command}" is not one (${firstLine(String(detail))})`
    )
  }

  /** A real Node must reject the invalid canary with a parser diagnostic… */
  function validateRejects() {
    let rejection
    try {
      spawn(checkArgs, INVALID_CANARY)
    } catch (err) {
      rejection = err
    }
    if (!rejection) throw notRealNode(`accepted ${JSON.stringify(INVALID_CANARY)} as valid`)

    const stderr = stderrOf(rejection)
    if (!/SyntaxError/.test(stderr)) {
      throw notRealNode(stderr || describeSpawnFailure(rejection))
    }
  }

  /** …and accept the valid one. */
  function validateAccepts() {
    try {
      spawn(checkArgs, VALID_CANARY)
    } catch (err) {
      throw notRealNode(stderrOf(err) || describeSpawnFailure(err))
    }
  }

  function validate() {
    if (validated) return
    validateRejects()
    validateAccepts()
    try {
      version = String(spawn(['--version'], undefined, ['ignore', 'pipe', 'pipe'])).trim()
    } catch {
      // Both canaries passed, so this is a Node; only the log label suffers.
      version = 'unknown'
    }
    validated = true
  }

  /**
   * @param {Buffer|string} bytes one chunk's source
   * @returns {string|null} stderr for a real syntax error, null when it parses
   */
  function check(bytes) {
    validate()
    try {
      spawn(checkArgs, bytes)
      return null
    } catch (err) {
      // Fail closed on anything that is not a parser diagnostic: a killed or
      // timed-out child, or an exit with nothing on stderr, is a broken
      // checker rather than a broken chunk.
      if (err?.signal || err?.code === 'ETIMEDOUT') {
        throw new Error(
          `syntax check did not finish: "${command}" ${describeSpawnFailure(err)} (chunk not checked)`,
          { cause: err }
        )
      }
      const stderr = stderrOf(err)
      if (typeof err?.status !== 'number' || !stderr.trim()) {
        throw new Error(
          `syntax check did not run: "${command}" ${describeSpawnFailure(err)} (chunk not checked)`,
          { cause: err }
        )
      }
      return stderr
    }
  }

  return {
    check,
    /**
     * The validated Node's `--version` (e.g. `v26.7.0`), for build logs.
     * @returns {string}
     */
    version() {
      validate()
      return version
    }
  }
}

/** @type {ReturnType<typeof createSyntaxChecker>|undefined} */
let sharedChecker

/** @returns {ReturnType<typeof createSyntaxChecker>} */
function shared() {
  sharedChecker ??= createSyntaxChecker()
  return sharedChecker
}

/**
 * Parse one standalone ESM chunk without evaluating code or resolving imports.
 * Throws when no real Node can be spawned — a missing or fake checker is an
 * environment error, never a chunk diagnostic.
 *
 * @param {Buffer|string} bytes
 * @returns {string|null} Node stderr on failure, null on success
 */
export function syntaxCheckChunk(bytes) {
  return shared().check(bytes)
}

/**
 * Version of the Node binary chunk checks run under, e.g. `v26.7.0`. Validates
 * the command exactly like `syntaxCheckChunk` and caches the result.
 * @returns {string}
 */
export function syntaxCheckNodeVersion() {
  return shared().version()
}
