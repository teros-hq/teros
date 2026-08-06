/**
 * Dead-letter file writer for the agent usage event buffer.
 *
 * Encapsulates the file-system concerns of the dead-letter pipeline:
 *   - Rotating the NDJSON file by size (max MB) and age (max hours).
 *   - Including the instance id in the filename so concurrent instances
 *     do not stomp on the same file on a shared volume.
 *   - Reporting the total size of pending files (input to the
 *     `dead_letter_total_size_bytes` Prometheus gauge).
 *
 * Extracted from `UsageEventBuffer` as part of R1 (refactor plan). The buffer
 * now treats this writer as an opaque dependency: it calls `write(batch)` and
 * lets the writer handle rotation transparently.
 *
 *
 */

import { appendFile, mkdir, readdir, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { INSTANCE_ID, sanitizeInstanceIdForFilename } from "../lib/instance-id.js"
import type { AgentUsageEvent } from "../types/database.js"

export interface DeadLetterFileWriterOptions {
  /** Directory where NDJSON files live. Created lazily if absent. */
  dir: string
  /** Rotate when the current file exceeds this size. */
  maxFileMb: number
  /** Rotate when the current file is older than this. */
  maxFileHours: number
}

interface OpenFile {
  path: string
  bytesWritten: number
  openedAt: number
}

/**
 * Filenames follow the pattern `usage-events-dead-letter-<instance>-<ts>.ndjson`.
 * The replay script discovers them via this prefix, so changing it requires a
 * coordinated update there too.
 */
const FILENAME_PREFIX = "usage-events-dead-letter-"
const FILENAME_SUFFIX = ".ndjson"

export class DeadLetterFileWriter {
  private current: OpenFile | null = null

  constructor(public readonly opts: DeadLetterFileWriterOptions) {}

  /**
   * Append the batch to the current dead-letter file. Rotates first if the
   * file exceeded its size or age budget. Creates a new file on demand.
   */
  async write(events: AgentUsageEvent[]): Promise<void> {
    if (events.length === 0) return
    this.rotateIfNeeded()
    const file = await this.ensureOpen()
    const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n"
    await appendFile(file.path, lines, "utf-8")
    file.bytesWritten += Buffer.byteLength(lines, "utf-8")
  }

  /**
   * Sum of the sizes of all dead-letter NDJSON files in `dir`. Used for the
   * `dead_letter_total_size_bytes` Prometheus gauge + Sentry alarm threshold.
   */
  async totalSizeBytes(): Promise<number> {
    try {
      const entries = await readdir(this.opts.dir)
      let total = 0
      for (const entry of entries) {
        if (!entry.startsWith(FILENAME_PREFIX) || !entry.endsWith(FILENAME_SUFFIX)) continue
        const fullPath = resolve(this.opts.dir, entry)
        try {
          const stats = await stat(fullPath)
          total += stats.size
        } catch {
          // Ignore stat failures for individual files (race with rotation, etc.).
        }
      }
      return total
    } catch {
      // Directory missing or unreadable; report 0 rather than throw.
      return 0
    }
  }

  /**
   * Test/debug helper — returns the path of the currently open file, or
   * null when there is none.
   */
  currentPath(): string | null {
    return this.current?.path ?? null
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private rotateIfNeeded(): void {
    if (!this.current) return
    const ageHours = (Date.now() - this.current.openedAt) / 3_600_000
    const sizeMb = this.current.bytesWritten / (1024 * 1024)
    if (sizeMb >= this.opts.maxFileMb || ageHours >= this.opts.maxFileHours) {
      this.current = null
    }
  }

  private async ensureOpen(): Promise<OpenFile> {
    if (this.current) return this.current
    await mkdir(this.opts.dir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, "-")
    const instance = sanitizeInstanceIdForFilename(INSTANCE_ID)
    const path = resolve(
      this.opts.dir,
      `${FILENAME_PREFIX}${instance}-${ts}${FILENAME_SUFFIX}`,
    )
    this.current = { path, bytesWritten: 0, openedAt: Date.now() }
    return this.current
  }
}
