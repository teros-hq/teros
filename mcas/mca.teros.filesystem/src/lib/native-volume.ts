/**
 * NativeVolumeStorage — node:fs adapter implementing the SDK's VolumeStorage
 * interface, rooted at the HOST root `/`.
 *
 * Used when MCA_FS_ROLE=admin (the retired mca.teros.admin.filesystem —
 * @todo nira - 2026-10-19: dead code, remove with the admin role): full host access
 * with no path special-casing of any kind — bare host paths are the whole
 * point (`/opt/teros/...`, `/etc/...`, `/data/...`). `/workspace/<path>`
 * resolves naturally through the host filesystem exactly as a host shell sees
 * it (today via the global host symlink `/workspace`) — no custom
 * translation. Same mental model, same behavior, same rules as a host shell.
 *
 * Restores the pre-ctx.volume admin contract (native fs over the whole host)
 * AND makes the backend-callback 401 moot for this MCA: no callbacks involved.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { VolumeEntry, VolumeStat, VolumeStorage } from '@teros/mca-sdk';

export class NativeVolumeStorage implements VolumeStorage {
  /**
   * List entries in a host directory.
   * @param path Host path (e.g. `/opt/teros`)
   */
  async list(path: string): Promise<VolumeEntry[]> {
    const entries = await readdir(path, { withFileTypes: true });
    const result: VolumeEntry[] = [];
    for (const entry of entries) {
      const type: VolumeEntry['type'] = entry.isDirectory() ? 'directory' : 'file';
      let size: number | undefined;
      if (entry.isFile()) {
        try {
          const st = await stat(`${path === '/' ? '' : path}/${entry.name}`);
          size = st.size;
        } catch {
          // unreadable/stat-failed entries still list, just without size
        }
      }
      result.push({ name: entry.name, type, size });
    }
    return result;
  }

  /**
   * Read a host file as base64. Returns null if it does not exist.
   * @param path Host path (e.g. `/opt/teros/mcas/mca.teros.filesystem/manifest.json`)
   */
  async read(path: string): Promise<string | null> {
    try {
      const data = await readFile(path);
      return data.toString('base64');
    } catch {
      return null;
    }
  }

  /**
   * Write data (base64) to a host file. Parent directories are created
   * automatically. No path restrictions — admin role.
   */
  async write(path: string, data: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(data, 'base64'));
  }

  /**
   * Delete a host file or directory (recursive option for directories).
   */
  async delete(path: string, options?: { recursive?: boolean }): Promise<void> {
    await rm(path, { recursive: options?.recursive ?? false, force: true });
  }

  /**
   * Get metadata for a host path. Returns null if it does not exist.
   */
  async stat(path: string): Promise<VolumeStat | null> {
    try {
      const st = await stat(path);
      return {
        size: st.size,
        isDirectory: st.isDirectory(),
        modifiedAt: st.mtime.toISOString(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Create a host directory (recursive, idempotent).
   */
  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  /**
   * Temp path helper — pure path construction, no I/O. Scoped to a session
   * dir to avoid collisions between concurrent tool calls.
   */
  getTempPath(filename: string): string {
    const sessionId = process.env.MCA_REQUEST_ID || process.env.MCA_USER_ID || 'unknown';
    return `/tmp/${sessionId}/${filename}`;
  }
}

/** Extract the directory portion of a path without importing node:path. */
function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return '/';
  return path.slice(0, idx);
}

/**
 * Wrap a ToolContext so its `volume` is a NativeVolumeStorage (host root `/`).
 * All other context members pass through untouched. Used by the admin MCA —
 * selected at handler-context build time based on MCA_FS_ROLE.
 */
export function withNativeVolume<T extends { volume: unknown }>(ctx: T): T {
  return { ...ctx, volume: new NativeVolumeStorage() };
}
