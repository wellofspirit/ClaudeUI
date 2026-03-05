import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as https from 'node:https'
import { logger } from './logger'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TunnelState = 'stopped' | 'starting' | 'downloading' | 'connected' | 'error' | 'restarting'

export interface TunnelStatus {
  state: TunnelState
  url: string | null
  error: string | null
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLOUDFLARED_VERSION = '2026.2.0'

/** Platform-specific download URLs from GitHub releases. */
const DOWNLOAD_URLS: Record<string, string> = {
  'win32-x64': `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-windows-amd64.exe`,
  'win32-arm64': `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-windows-arm64.exe`,
  'darwin-x64': `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-darwin-amd64.tgz`,
  'darwin-arm64': `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-darwin-arm64.tgz`,
  'linux-x64': `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64`,
  'linux-arm64': `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-arm64`
}

const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/
const START_TIMEOUT_MS = 60_000
const RESTART_DELAY_MS = 3_000

// ---------------------------------------------------------------------------
// TunnelManager
// ---------------------------------------------------------------------------

export class TunnelManager {
  private proc: ChildProcess | null = null
  private status: TunnelStatus = { state: 'stopped', url: null, error: null }
  private statusHandler: ((status: TunnelStatus) => void) | null = null
  private restartTimer?: ReturnType<typeof setTimeout>
  private localPort = 0
  private destroyed = false

  /** Register a callback fired on every status change. */
  setStatusHandler(cb: (status: TunnelStatus) => void): void {
    this.statusHandler = cb
  }

  /** Get current tunnel status. */
  getStatus(): TunnelStatus {
    return { ...this.status }
  }

  /**
   * Start a quick tunnel to the given local port.
   * Downloads the cloudflared binary on first use.
   * Resolves with the tunnel URL once available.
   */
  async start(localPort: number): Promise<string> {
    if (this.proc) throw new Error('Tunnel already running')

    this.localPort = localPort
    this.destroyed = false

    // Ensure binary exists
    this.setStatus({ state: 'downloading', url: null, error: null })
    const binaryPath = await this.ensureBinary()

    // Spawn cloudflared
    this.setStatus({ state: 'starting', url: null, error: null })
    return this.spawnAndWaitForUrl(binaryPath)
  }

  /** Stop the tunnel and kill the cloudflared process. */
  stop(): void {
    this.destroyed = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    this.killProcess()
    this.setStatus({ state: 'stopped', url: null, error: null })
  }

  // ---------------------------------------------------------------------------
  // Binary management
  // ---------------------------------------------------------------------------

  /** Return the path to the cloudflared binary, downloading if needed. */
  private async ensureBinary(): Promise<string> {
    const binDir = this.getBinDir()
    const binaryName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
    const binaryPath = path.join(binDir, binaryName)

    if (fs.existsSync(binaryPath)) {
      return binaryPath
    }

    const key = `${process.platform}-${process.arch}`
    const url = DOWNLOAD_URLS[key]
    if (!url) {
      throw new Error(`No cloudflared binary available for ${key}`)
    }

    logger.info('tunnel-manager', `Downloading cloudflared from ${url}`)
    fs.mkdirSync(binDir, { recursive: true })

    const isTgz = url.endsWith('.tgz')
    const tmpPath = isTgz ? path.join(binDir, 'cloudflared.tgz') : binaryPath + '.tmp'
    await this.download(url, tmpPath)

    if (isTgz) {
      // macOS: extract the binary from the tarball
      execFileSync('tar', ['-xzf', tmpPath, '-C', binDir])
      fs.unlinkSync(tmpPath)
      if (!fs.existsSync(binaryPath)) {
        throw new Error('cloudflared binary not found after extracting .tgz')
      }
    } else {
      // Linux/Windows: downloaded file is the binary itself
      fs.renameSync(tmpPath, binaryPath)
    }

    // Make executable on Unix
    if (process.platform !== 'win32') {
      fs.chmodSync(binaryPath, 0o755)
    }

    // macOS: remove quarantine attribute so Gatekeeper doesn't block execution
    if (process.platform === 'darwin') {
      try {
        execFileSync('xattr', ['-d', 'com.apple.quarantine', binaryPath])
      } catch {
        // Attribute may not exist if downloaded via certain methods — safe to ignore
      }
    }

    logger.info('tunnel-manager', `cloudflared downloaded to ${binaryPath}`)
    return binaryPath
  }

  /** Get the directory for the cloudflared binary — ~/.claude/ui/cloudflared/ */
  private getBinDir(): string {
    return path.join(os.homedir(), '.claude', 'ui', 'cloudflared')
  }

  /** Download a URL to a local file path. Follows redirects. */
  private download(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath)
      const request = (targetUrl: string, redirectCount = 0): void => {
        if (redirectCount > 5) {
          file.close()
          reject(new Error('Too many redirects'))
          return
        }
        // Handle both http and https
        const mod = targetUrl.startsWith('https') ? https : require('node:http')
        mod.get(targetUrl, (res: import('node:http').IncomingMessage) => {
          // Follow redirects
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume() // discard response body
            request(res.headers.location, redirectCount + 1)
            return
          }
          if (res.statusCode !== 200) {
            file.close()
            reject(new Error(`Download failed: HTTP ${res.statusCode}`))
            return
          }
          res.pipe(file)
          file.on('finish', () => {
            file.close()
            resolve()
          })
        }).on('error', (err: Error) => {
          file.close()
          try { fs.unlinkSync(destPath) } catch { /* best effort cleanup */ }
          reject(err)
        })
      }
      request(url)
    })
  }

  // ---------------------------------------------------------------------------
  // Process management
  // ---------------------------------------------------------------------------

  /** Spawn cloudflared and wait for the tunnel URL to appear. */
  private spawnAndWaitForUrl(binaryPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let resolved = false
      let stderrBuffer = ''

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          this.killProcess()
          const msg = `Tunnel start timeout (${START_TIMEOUT_MS / 1000}s). stderr:\n${stderrBuffer.slice(-500)}`
          this.setStatus({ state: 'error', url: null, error: msg })
          reject(new Error(msg))
        }
      }, START_TIMEOUT_MS)

      try {
        this.proc = spawn(binaryPath, ['tunnel', '--url', `http://localhost:${this.localPort}`], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        })
      } catch (err) {
        clearTimeout(timeout)
        const msg = `Failed to spawn cloudflared: ${err instanceof Error ? err.message : String(err)}`
        this.setStatus({ state: 'error', url: null, error: msg })
        reject(new Error(msg))
        return
      }

      const handleLine = (line: string): void => {
        const match = TUNNEL_URL_REGEX.exec(line)
        if (match && !resolved) {
          resolved = true
          clearTimeout(timeout)
          const url = match[0]
          this.setStatus({ state: 'connected', url, error: null })
          logger.info('tunnel-manager', `Tunnel connected: ${url}`)
          resolve(url)
        }
      }

      // cloudflared outputs the URL to stderr
      this.proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        stderrBuffer += text
        for (const line of text.split('\n')) {
          handleLine(line)
        }
      })

      // Also check stdout just in case
      this.proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        for (const line of text.split('\n')) {
          handleLine(line)
        }
      })

      this.proc.on('error', (err) => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          const msg = `cloudflared error: ${err.message}`
          this.setStatus({ state: 'error', url: null, error: msg })
          reject(new Error(msg))
        }
      })

      this.proc.on('exit', (code, signal) => {
        this.proc = null

        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          const msg = `cloudflared exited with code ${code} (signal: ${signal}). stderr:\n${stderrBuffer.slice(-500)}`
          this.setStatus({ state: 'error', url: null, error: msg })
          reject(new Error(msg))
          return
        }

        // Process exited after we already had the URL — unexpected death
        if (!this.destroyed) {
          logger.warn('tunnel-manager', `cloudflared exited unexpectedly (code ${code}, signal ${signal}), scheduling restart`)
          this.scheduleRestart(binaryPath)
        }
      })
    })
  }

  /** Schedule a restart after the process dies unexpectedly. */
  private scheduleRestart(binaryPath: string): void {
    if (this.destroyed) return

    this.setStatus({ state: 'restarting', url: this.status.url, error: null })

    this.restartTimer = setTimeout(async () => {
      if (this.destroyed) return
      try {
        logger.info('tunnel-manager', 'Restarting cloudflared tunnel...')
        this.setStatus({ state: 'starting', url: null, error: null })
        await this.spawnAndWaitForUrl(binaryPath)
        // Status is set to 'connected' inside spawnAndWaitForUrl on success
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error('tunnel-manager', `Restart failed: ${msg}`)
        this.setStatus({ state: 'error', url: null, error: msg })
      }
    }, RESTART_DELAY_MS)
  }

  /** Kill the cloudflared process if running. */
  private killProcess(): void {
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM')
      } catch {
        // Process may have already exited
      }
      this.proc = null
    }
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  private setStatus(status: TunnelStatus): void {
    this.status = status
    this.statusHandler?.(status)
  }
}
