#!/usr/bin/env npx tsx

/**
 * Teros Filesystem
 *
 *   - Role-aware path validation (MCA_FS_ROLE):
 *       workspace role → strict /workspace prefix, volume-relative paths via ctx.volume
 *       admin role     → full host access from / via native node:fs
 *   - Path-traversal safe (workspace role)
 *   - Shell-injection safe (execa with args arrays, never shell:true)
 *   - ripgrep-backed grep with content + context + pagination
 *   - structuredContent + cursor pagination + stability annotations
 *   - DRY: shared handlers, admin MCA re-uses this entry via the sibling package
 */

import { McaServer } from '@teros/mca-sdk';
import {
  appendFile,
  copyFile,
  createDirectory,
  createFile,
  deleteFile,
  editFile,
  fileInfo,
  findFiles,
  hashFile,
  healthCheck,
  listFiles,
  listRoots,
  moveFile,
  patchFile,
  readBinary,
  readFile,
  readFiles,
  searchInFiles,
  treeView,
} from './tools';
import { getFsRole } from './lib/path-safety';
import { withNativeVolume } from './lib/native-volume';
import type { ToolConfig } from '@teros/mca-sdk';

/**
 * Wrap a tool so that, in the ADMIN role, every call receives a
 * NativeVolumeStorage (native node:fs rooted at the host root `/`) instead of
 * the SDK's callback-backed ctx.volume. In the workspace role the context
 * passes through untouched. Selected at handler-context build time based on
 * MCA_FS_ROLE — the admin MCA sets it in its entry before starting the server.
 */
function roleAware(name: string, config: ToolConfig): { name: string; config: ToolConfig } {
  if (getFsRole() !== 'admin') {
    return { name, config };
  }
  return {
    name,
    config: {
      ...config,
      handler: async (args: Record<string, unknown>, ctx: unknown) =>
        config.handler(args, withNativeVolume(ctx as Parameters<typeof config.handler>[1])),
    },
  };
}

export function createFilesystemServer(options: { id: string; name: string }) {
  const server = new McaServer({
    id: options.id,
    name: options.name,
    version: '2.3.0',
  });

  const register = (name: string, config: ToolConfig) => {
    const wrapped = roleAware(name, config);
    server.tool(wrapped.name, wrapped.config);
  };

  register('health-check', healthCheck);
  register('list-roots', listRoots);

  register('read-file', readFile);
  register('read-files', readFiles);
  register('read-binary', readBinary);
  register('create-file', createFile);
  register('append-file', appendFile);
  register('edit-file', editFile);
  register('patch-file', patchFile);

  register('list-files', listFiles);
  register('tree-view', treeView);
  register('file-info', fileInfo);
  register('hash-file', hashFile);

  register('find-files', findFiles);
  register('search-in-files', searchInFiles);

  register('delete-file', deleteFile);
  register('copy-file', copyFile);
  register('move-file', moveFile);
  register('create-directory', createDirectory);

  return server;
}

const isDirectEntry = import.meta.url === `file://${process.argv[1]}`;

if (isDirectEntry) {
  const server = createFilesystemServer({
    id: 'mca.teros.filesystem',
    name: 'Filesystem',
  });
  server
    .start()
    .then(() => {
      console.error('📁 Teros Filesystem MCA running');
    })
    .catch((error) => {
      console.error('Failed to start Teros Filesystem:', error);
      process.exit(1);
    });
}
