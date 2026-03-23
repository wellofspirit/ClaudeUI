/**
 * Voice client service — manages the lifecycle of voice recording sessions.
 *
 * Connects to the voice server running inside cli.js (started via the
 * voice-server patch) over a TCP socket with newline-delimited JSON protocol.
 * Audio data is base64-encoded in JSON messages.
 *
 * Protocol (client → server):
 *   {"type":"voice_start","language":"en","keyterms":[]}
 *   {"type":"audio","data":"<base64 PCM>"}
 *   {"type":"voice_stop"}
 *
 * Protocol (server → client):
 *   {"type":"ready"}
 *   {"type":"transcript","text":"...","isFinal":true|false}
 *   {"type":"error","message":"..."}
 *   {"type":"closed"}
 */

import * as net from 'net'
import * as readline from 'readline'
import type { BrowserWindow } from 'electron'
import { startRecording, stopRecording } from './voice-capture'
import { logger } from './logger'
import type { VoiceState } from '../../shared/types'

interface VoiceServerConnection {
  socket: net.Socket
  rl: readline.Interface
}

export class VoiceClient {
  private port: number
  private win: BrowserWindow
  private routingId: string
  private conn: VoiceServerConnection | null = null
  private state: VoiceState = 'idle'
  private audioBuffer: Buffer[] = []
  private streamReady = false

  constructor(port: number, win: BrowserWindow, routingId: string) {
    this.port = port
    this.win = win
    this.routingId = routingId
  }

  /** Update the voice server port (e.g., after reconnection) */
  updatePort(port: number): void {
    this.port = port
  }

  /**
   * Start a voice recording session.
   * Native audio capture is already running (started by ClaudeSession for
   * zero-latency buffering). earlyBuffer contains chunks captured while
   * the SDK was spawning. This method connects to the voice server, flushes
   * the early buffer, then takes over live audio forwarding.
   */
  async startRecording(language: string, earlyBuffer: Buffer[] = []): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'connecting') {
      logger.warn('VoiceClient', `Cannot start recording in state: ${this.state}`)
      return
    }

    this.setState('connecting')
    this.audioBuffer = [...earlyBuffer]
    this.streamReady = false

    try {
      // Connect to the voice server in cli.js
      this.conn = await this.connect()

      // Set up message handling
      this.conn.rl.on('line', (line) => this.handleMessage(line))
      this.conn.socket.on('close', () => this.handleDisconnect())
      this.conn.socket.on('error', (err) => {
        logger.error('VoiceClient', `Socket error: ${err.message}`)
        this.sendError(`Connection error: ${err.message}`)
        this.cleanup()
      })

      // Send voice_start command
      this.sendToServer({ type: 'voice_start', language })

      // Take over live audio capture — native recording is already active,
      // just swap the callback to forward through VoiceClient
      stopRecording()
      const started = startRecording((buffer) => {
        if (this.state !== 'recording' && this.state !== 'connecting') return

        if (this.streamReady && this.conn) {
          this.sendToServer({ type: 'audio', data: buffer.toString('base64') })
        } else {
          this.audioBuffer.push(buffer)
        }
      })

      if (!started) {
        this.sendError('Failed to restart audio capture. Check microphone access.')
        this.cleanup()
        return
      }

      // Will transition to 'recording' on 'ready' message from voice server
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('VoiceClient', `Failed to start recording: ${msg}`)
      this.sendError(`Failed to connect to voice server: ${msg}`)
      this.cleanup()
    }
  }

  /** Stop the current recording session */
  async stopRecording(): Promise<void> {
    if (this.state === 'idle') return

    // Stop audio capture immediately
    stopRecording()

    if (this.conn && this.streamReady) {
      this.setState('processing')
      this.sendToServer({ type: 'voice_stop' })

      // Safety: if cli.js doesn't send 'closed' within 8s, force cleanup.
      // hb8's safety timeout is 5s, so 8s gives plenty of margin.
      setTimeout(() => {
        if (this.state === 'processing') {
          logger.warn('VoiceClient', 'Finalization timeout — forcing cleanup')
          this.cleanup()
        }
      }, 8000)
      // The server will send remaining transcripts, then 'closed'
    } else {
      this.cleanup()
    }
  }

  /** Clean up and destroy this client */
  destroy(): void {
    stopRecording()
    this.cleanup()
  }

  // -- Private methods --

  private connect(): Promise<VoiceServerConnection> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.port, '127.0.0.1')
      const rl = readline.createInterface({ input: socket })

      // Connection timeout — only for the initial handshake
      const connectTimer = setTimeout(() => {
        socket.destroy()
        reject(new Error('Connection timeout'))
      }, 5000)

      socket.on('connect', () => {
        clearTimeout(connectTimer)
        // Disable idle timeout — the socket may be idle for seconds during
        // voice finalization (Deepgram safety timeout is 5s)
        socket.setTimeout(0)
        resolve({ socket, rl })
      })

      socket.on('error', (err) => {
        clearTimeout(connectTimer)
        reject(err)
      })
    })
  }

  private handleMessage(line: string): void {
    let msg: { type: string; text?: string; isFinal?: boolean; message?: string }
    try {
      msg = JSON.parse(line)
    } catch {
      logger.warn('VoiceClient', `Invalid JSON from voice server: ${line.slice(0, 100)}`)
      return
    }

    switch (msg.type) {
      case 'ready':
        this.streamReady = true
        this.setState('recording')
        // Flush buffered audio
        if (this.conn) {
          for (const buf of this.audioBuffer) {
            this.sendToServer({ type: 'audio', data: buf.toString('base64') })
          }
        }
        this.audioBuffer = []
        break

      case 'transcript':
        if (msg.text !== undefined && msg.isFinal !== undefined) {
          this.win.webContents.send('voice:transcript', this.routingId, {
            text: msg.text,
            isFinal: msg.isFinal
          })
        }
        break

      case 'error':
        logger.error('VoiceClient', `Voice server error: ${msg.message}`)
        this.sendError(msg.message || 'Unknown voice error')
        break

      case 'closed':
        this.cleanup()
        break

      default:
        break
    }
  }

  private handleDisconnect(): void {
    if (this.state !== 'idle') this.cleanup()
  }

  private sendToServer(msg: Record<string, unknown>): void {
    if (!this.conn) return
    try {
      this.conn.socket.write(JSON.stringify(msg) + '\n')
    } catch (err) {
      logger.error('VoiceClient', `Failed to send to voice server: ${err}`)
    }
  }

  private setState(state: VoiceState): void {
    this.state = state
    this.win.webContents.send('voice:state', this.routingId, state)
  }

  private sendError(message: string): void {
    this.win.webContents.send('voice:error', this.routingId, message)
  }

  private cleanup(): void {
    stopRecording()
    this.streamReady = false
    this.audioBuffer = []

    if (this.conn) {
      try {
        this.conn.rl.close()
        this.conn.socket.destroy()
      } catch {
        /* ignore */
      }
      this.conn = null
    }

    this.setState('idle')
  }
}
