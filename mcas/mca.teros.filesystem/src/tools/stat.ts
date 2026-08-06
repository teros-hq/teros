import type { ToolConfig } from '@teros/mca-sdk';
import { existsSync, lstatSync } from 'node:fs';
import { basename } from 'node:path';
import { detectFileKind, humanizeBytes } from '../lib/formatters';
import { detectMimeType } from '../lib/mime';
import { getDefaultGuard } from '../lib/path-safety';
import { wrap } from '../lib/structured';

export const stat: ToolConfig = {
  description:
    'Return metadata for a single path: exists, type (file/directory/symlink), size, mtime, permissions. Does NOT read content. Prefer this over `read` when you only need to check existence or size.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or workspace-relative path' },
    },
    required: ['path'],
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true },
  handler: async (args) => {
    const rawPath = args.path as string;
    const guard = getDefaultGuard();

    let canonical: string;
    try {
      canonical = guard.resolveNoFollow(rawPath);
    } catch (err) {
      if (err instanceof Error && /outside allowed roots/.test(err.message)) throw err;
      // path doesn't exist — jail check already done by resolveNoFollow via parent realpath
      return wrap({
        path: rawPath,
        exists: false,
      });
    }

    if (!existsSync(canonical)) {
      return wrap({
        path: canonical,
        name: basename(canonical),
        exists: false,
      });
    }

    const st = lstatSync(canonical);
    const type = st.isDirectory()
      ? 'directory'
      : st.isSymbolicLink()
        ? 'symlink'
        : st.isFile()
          ? 'file'
          : 'other';

    const mimeType = type === 'file' ? await detectMimeType(canonical) : null;

    return wrap({
      path: canonical,
      name: basename(canonical),
      exists: true,
      type,
      size: st.size,
      sizeHuman: humanizeBytes(st.size),
      mtime: st.mtime.toISOString(),
      ctime: st.ctime.toISOString(),
      birthtime: st.birthtime.toISOString(),
      permissions: (st.mode & 0o777).toString(8).padStart(3, '0'),
      ...(type === 'file' ? { kind: detectFileKind(canonical), mimeType } : {}),
    });
  },
};
