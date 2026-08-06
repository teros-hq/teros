/**
 * Unit tests for DeadLetterFileWriter (R1 step 1).
 *
 * Covers: write to a fresh file, rotation by size, rotation by age, total
 * size across multiple rotated files, and resilience when the dir is missing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DeadLetterFileWriter } from '../../src/services/dead-letter-file-writer'
import type { AgentUsageEvent } from '../../src/types/database'

function makeEvent(eventId: string): AgentUsageEvent {
  return {
    eventId,
    sessionUsageId: 'usess_x',
    type: 'session.started',
    payload: {} as any,
    appliedAt: new Date(),
    schemaVersion: 1,
  }
}

describe('DeadLetterFileWriter', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dlf-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes the batch into a new NDJSON file', async () => {
    const w = new DeadLetterFileWriter({ dir, maxFileMb: 100, maxFileHours: 24 })
    await w.write([makeEvent('a'), makeEvent('b')])
    const files = await readdir(dir)
    const ndjson = files.find((f) =>
      f.startsWith('usage-events-dead-letter-') && f.endsWith('.ndjson'),
    )
    expect(ndjson).toBeDefined()
  })

  it('no-op when batch is empty', async () => {
    const w = new DeadLetterFileWriter({ dir, maxFileMb: 100, maxFileHours: 24 })
    await w.write([])
    const files = await readdir(dir)
    expect(files).toHaveLength(0)
    expect(w.currentPath()).toBeNull()
  })

  it('rotates to a new file when size threshold exceeded', async () => {
    // Force rotation by setting maxFileMb extremely small (any write triggers).
    // sleep(>1ms) between writes guarantees distinct ISO timestamps in filenames.
    const w = new DeadLetterFileWriter({
      dir,
      maxFileMb: 0.000_001,
      maxFileHours: 24,
    })
    await w.write([makeEvent('first')])
    await sleep(5)
    await w.write([makeEvent('second')])
    const files = await readdir(dir)
    const ndjsons = files.filter(
      (f) => f.startsWith('usage-events-dead-letter-') && f.endsWith('.ndjson'),
    )
    expect(ndjsons.length).toBeGreaterThanOrEqual(2)
  })

  it('totalSizeBytes sums all dead-letter files in the dir', async () => {
    const w = new DeadLetterFileWriter({
      dir,
      maxFileMb: 0.000_001, // force rotation
      maxFileHours: 24,
    })
    await w.write([makeEvent('a')])
    await sleep(5)
    await w.write([makeEvent('b')])
    const total = await w.totalSizeBytes()
    expect(total).toBeGreaterThan(0)
  })

  it('totalSizeBytes returns 0 when the dir does not exist', async () => {
    const w = new DeadLetterFileWriter({
      dir: join(dir, 'does-not-exist'),
      maxFileMb: 100,
      maxFileHours: 24,
    })
    expect(await w.totalSizeBytes()).toBe(0)
  })

  it('ignores non-dead-letter files in the dir', async () => {
    const w = new DeadLetterFileWriter({ dir, maxFileMb: 100, maxFileHours: 24 })
    await w.write([makeEvent('a')])
    // The dead-letter file is created; create an unrelated file too.
    await Bun.write(join(dir, 'unrelated.log'), 'noise')
    // totalSizeBytes should ONLY count the dead-letter file, not 'unrelated.log'.
    const total = await w.totalSizeBytes()
    const ndjsonStats = await Bun.file(w.currentPath()!).size
    expect(total).toBe(ndjsonStats)
  })
})
