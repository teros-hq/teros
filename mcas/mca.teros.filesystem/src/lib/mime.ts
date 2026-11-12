/**
 * Detect MIME type by matching the first 4KB of a buffer against
 * the `file-type` registry (magic bytes). Falls back to `null` if no match.
 *
 * In the ctx.volume architecture, the caller reads the file via ctx.volume.read()
 * and passes the decoded Buffer to this function.
 */
export async function detectMimeTypeFromBuffer(buf: Buffer): Promise<string | null> {
  if (buf.length === 0) return null;
  const slice = buf.subarray(0, Math.min(4100, buf.length));
  try {
    const { fileTypeFromBuffer } = await import('file-type');
    const result = await fileTypeFromBuffer(slice);
    return result?.mime ?? null;
  } catch {
    return null;
  }
}
