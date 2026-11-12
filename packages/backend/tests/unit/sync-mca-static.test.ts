/**
 * sync-mca-static tests — symlink farm integrity for MCA static assets.
 *
 * nginx serves /static/ straight from packages/backend/static/, so every MCA
 * with icons needs a symlink static/mcas/<id> -> ../../../../mcas/<id>/static.
 * These were hand-made (and hand-committed), so new MCAs 404'd until someone
 * remembered. The sync script makes it idempotent; these tests MORDER the
 * four behaviors it must guarantee:
 *
 *   create  — new MCA with static/ gets its link
 *   repair  — drifted or dangling link is re-pointed at the real target
 *   remove  — link whose target vanished (MCA removed) is cleaned up
 *   warn    — a real file/dir in the farm is NEVER touched
 *
 * Everything runs in temp dirs; nothing touches the real static/mcas farm.
 *
 * NOTE on removal assertions: "removed" is asserted with lstat (the directory
 * entry itself is gone), NOT existsSync — existsSync follows the link and
 * returns false for a DANGLING link too, so it cannot tell "removed" from
 * "still there but broken". That distinction is exactly what bit us on Node
 * 24.11, where sync unlink silently fails on dangling symlinks.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative, resolve } from 'path'
import { discoverMcasWithStatic, syncMcaStaticSymlinks } from '../../src/scripts/sync-mca-static'

let root: string
let mcasDir: string
let staticMcasDir: string

function makeMca(dir: string, id: string): void {
  mkdirSync(join(dir, id, 'static'), { recursive: true })
  writeFileSync(join(dir, id, 'static', 'icon.png'), 'png-bytes')
}

/** True when the directory entry itself is gone (lstat, not existsSync). */
function entryGone(path: string): boolean {
  try {
    lstatSync(path)
    return false
  } catch {
    return true
  }
}

/** The link target the committed convention uses (relative, 4 levels up). */
function expectedLinkText(id: string): string {
  return join(relative(staticMcasDir, mcasDir), id, 'static')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sync-mca-static-'))
  mcasDir = join(root, 'mcas')
  staticMcasDir = join(root, 'static', 'mcas')
  mkdirSync(mcasDir, { recursive: true })
  mkdirSync(staticMcasDir, { recursive: true }) // parent must exist for test-made symlinks
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('discoverMcasWithStatic', () => {
  it('finds only mca.* directories that ship a static/ folder', () => {
    makeMca(mcasDir, 'mca.with-static')
    mkdirSync(join(mcasDir, 'mca.no-static'), { recursive: true }) // no static/
    mkdirSync(join(mcasDir, 'notmca.with-static', 'static'), { recursive: true }) // wrong prefix
    writeFileSync(join(mcasDir, 'README.md'), 'x') // file, not dir

    expect(discoverMcasWithStatic(mcasDir)).toEqual(['mca.with-static'])
  })

  it('returns [] when the mcas dir does not exist', () => {
    expect(discoverMcasWithStatic(join(root, 'nope'))).toEqual([])
  })
})

describe('syncMcaStaticSymlinks', () => {
  it('creates missing symlinks using the committed relative convention', async () => {
    makeMca(mcasDir, 'mca.alpha')
    makeMca(mcasDir, 'mca.beta')

    const result = await syncMcaStaticSymlinks({ mcasDir, staticMcasDir })

    expect(result.created.sort()).toEqual(['mca.alpha', 'mca.beta'])
    expect(result.warnings).toEqual([])
    for (const id of ['mca.alpha', 'mca.beta']) {
      const linkPath = join(staticMcasDir, id)
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)
      expect(readlinkSync(linkPath)).toBe(expectedLinkText(id))
      expect(resolve(staticMcasDir, readlinkSync(linkPath))).toBe(resolve(mcasDir, id, 'static'))
      expect(existsSync(join(linkPath, 'icon.png'))).toBe(true)
    }
  })

  it('is idempotent — a second run is a no-op', async () => {
    makeMca(mcasDir, 'mca.alpha')
    await syncMcaStaticSymlinks({ mcasDir, staticMcasDir })

    const second = await syncMcaStaticSymlinks({ mcasDir, staticMcasDir })

    expect(second.created).toEqual([])
    expect(second.repaired).toEqual([])
    expect(second.removed).toEqual([])
    expect(second.warnings).toEqual([])
    expect(second.total).toBe(1)
  })

  it('repairs a symlink whose target drifted', async () => {
    makeMca(mcasDir, 'mca.alpha')
    const decoy = join(root, 'decoy-static')
    mkdirSync(decoy, { recursive: true })
    symlinkSync(decoy, join(staticMcasDir, 'mca.alpha'))

    const result = await syncMcaStaticSymlinks({ mcasDir, staticMcasDir })

    expect(result.repaired).toEqual(['mca.alpha'])
    expect(resolve(staticMcasDir, readlinkSync(join(staticMcasDir, 'mca.alpha')))).toBe(
      resolve(mcasDir, 'mca.alpha', 'static'),
    )
  })

  it('repairs a dangling symlink when the MCA still exists', async () => {
    makeMca(mcasDir, 'mca.alpha')
    symlinkSync(join(root, 'gone', 'static'), join(staticMcasDir, 'mca.alpha'))

    const result = await syncMcaStaticSymlinks({ mcasDir, staticMcasDir })

    expect(result.repaired).toEqual(['mca.alpha'])
    expect(existsSync(join(staticMcasDir, 'mca.alpha', 'icon.png'))).toBe(true)
  })

  it('removes broken symlinks whose target vanished (removed MCA)', async () => {
    // Simulate the mca.multilogin case: link exists, MCA dir is gone
    const ghostStatic = join(root, 'ghost', 'static')
    mkdirSync(ghostStatic, { recursive: true })
    symlinkSync(ghostStatic, join(staticMcasDir, 'mca.ghost'))
    rmSync(join(root, 'ghost'), { recursive: true })

    const result = await syncMcaStaticSymlinks({ mcasDir, staticMcasDir })

    expect(result.removed).toEqual(['mca.ghost'])
    // lstat, not existsSync: the directory ENTRY must be gone (see file header)
    expect(entryGone(join(staticMcasDir, 'mca.ghost'))).toBe(true)
  })

  it('never touches a real directory — warns instead', async () => {
    makeMca(mcasDir, 'mca.alpha')
    mkdirSync(join(staticMcasDir, 'mca.alpha'), { recursive: true }) // real dir, not a link
    writeFileSync(join(staticMcasDir, 'mca.alpha', 'keep.txt'), 'precious')

    const result = await syncMcaStaticSymlinks({ mcasDir, staticMcasDir })

    expect(result.warnings.length).toBe(1)
    expect(result.warnings[0]).toContain('mca.alpha')
    expect(result.warnings[0]).toContain('directory')
    expect(result.created).toEqual([])
    expect(result.removed).toEqual([])
    expect(existsSync(join(staticMcasDir, 'mca.alpha', 'keep.txt'))).toBe(true)
    expect(lstatSync(join(staticMcasDir, 'mca.alpha')).isSymbolicLink()).toBe(false)
  })

  it('dry-run reports exactly what would change without touching the filesystem', async () => {
    makeMca(mcasDir, 'mca.alpha') // → would be created
    const ghostStatic = join(root, 'ghost', 'static')
    mkdirSync(ghostStatic, { recursive: true })
    symlinkSync(ghostStatic, join(staticMcasDir, 'mca.ghost'))
    rmSync(join(root, 'ghost'), { recursive: true }) // → would be removed

    const result = await syncMcaStaticSymlinks({ mcasDir, staticMcasDir, dryRun: true })

    expect(result.created).toEqual(['mca.alpha'])
    expect(result.removed).toEqual(['mca.ghost'])
    // filesystem untouched
    expect(entryGone(join(staticMcasDir, 'mca.alpha'))).toBe(true)
    // lstat (not existsSync — a dangling link stat-follows to false): entry still there
    expect(lstatSync(join(staticMcasDir, 'mca.ghost')).isSymbolicLink()).toBe(true)
  })

  it('keeps an absolute symlink that already points at the right target', async () => {
    makeMca(mcasDir, 'mca.alpha')
    symlinkSync(resolve(mcasDir, 'mca.alpha', 'static'), join(staticMcasDir, 'mca.alpha'))

    const result = await syncMcaStaticSymlinks({ mcasDir, staticMcasDir })

    expect(result.repaired).toEqual([])
    expect(result.created).toEqual([])
    expect(lstatSync(join(staticMcasDir, 'mca.alpha')).isSymbolicLink()).toBe(true)
  })
})
