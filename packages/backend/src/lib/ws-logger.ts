/**
 * WsLogger — Structured NDJSON logger for WebSocket actions
 *
 * Writes one JSON line per request to a daily rotating log file:
 *   logs/ws-YYYY-MM-DD.ndjson
 *
 * Each line contains:
 *   ts          — ISO timestamp
 *   userId      — authenticated user (or "anon")
 *   sessionId   — session identifier
 *   action      — action name (e.g. "channel.send-message") or message type (e.g. "auth", "ping")
 *   inputBytes  — JSON size of the incoming data payload
 *   outputBytes — JSON size of the outgoing result (0 on error)
 *   durationMs  — handler wall-clock time in milliseconds
 *   status      — "ok" | "error"
 *   errorCode   — present on error (e.g. "NOT_FOUND", "INTERNAL_ERROR")
 *   errorMsg    — short error message (truncated to 200 chars)
 */

import * as fs from 'fs'
import * as path from 'path'

export interface WsLogEntry {
  ts: string
  ip: string
  userId: string
  sessionId: string
  action: string
  inputBytes: number
  outputBytes: number
  durationMs: number
  status: 'ok' | 'error'
  errorCode?: string
  errorMsg?: string
}

export class WsLogger {
  private logDir: string
  private currentDate: string = ''
  private stream: fs.WriteStream | null = null

  constructor(logDir: string) {
    this.logDir = logDir
    fs.mkdirSync(logDir, { recursive: true })
  }

  write(entry: WsLogEntry): void {
    const stream = this.getStream()
    stream.write(JSON.stringify(entry) + '\n')
  }

  /** Returns (or creates) the write stream for today's log file */
  private getStream(): fs.WriteStream {
    const today = new Date().toISOString().slice(0, 10) // "YYYY-MM-DD"

    if (today !== this.currentDate || !this.stream) {
      // Close previous stream if date rolled over
      if (this.stream) {
        this.stream.end()
        this.stream = null
      }
      this.currentDate = today
      const filePath = path.join(this.logDir, `ws-${today}.ndjson`)
      this.stream = fs.createWriteStream(filePath, { flags: 'a' })

      this.stream.on('error', (err) => {
        console.error(`[WsLogger] Write stream error: ${err.message}`)
      })
    }

    return this.stream!
  }

  /** Graceful shutdown — flush and close the stream */
  close(): void {
    if (this.stream) {
      this.stream.end()
      this.stream = null
    }
  }
}

// ============================================================================
// SINGLETON — shared across the backend process
// ============================================================================

let _instance: WsLogger | null = null

export function getWsLogger(): WsLogger {
  if (!_instance) {
    const logDir = process.env.WS_LOG_DIR ?? path.join(process.cwd(), 'logs')
    _instance = new WsLogger(logDir)
    console.log(`[WsLogger] Writing to ${logDir}/ws-YYYY-MM-DD.ndjson`)
  }
  return _instance
}

// ============================================================================
// HELPERS
// ============================================================================

export function jsonBytes(value: unknown): number {
  if (value === undefined || value === null) return 0
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return 0
  }
}
