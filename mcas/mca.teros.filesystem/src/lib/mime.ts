import { open } from 'node:fs/promises';

/**
 * Detect MIME type by reading the first 4KB of a file and matching against
 * the `file-type` registry (magic bytes). Falls back to `null` if no match.
 *
 * Imported lazily so the dep is only loaded when actually needed.
 */
export async function detectMimeType(absolutePath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(absolutePath, 'r');
    const { buffer, bytesRead } = await handle.read({
      buffer: Buffer.alloc(4100),
      position: 0,
    });
    if (bytesRead === 0) return null;
    const slice = buffer.subarray(0, bytesRead);
    const { fileTypeFromBuffer } = await import('file-type');
    const result = await fileTypeFromBuffer(slice);
    return result?.mime ?? null;
  } catch {
    return null;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // ignore
      }
    }
  }
}
