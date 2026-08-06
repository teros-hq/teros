#!/usr/bin/env npx tsx

/**
 * Teros Filesystem
 *
 *   - Path-traversal safe (CVE-2025-53109 / 53110 pattern)
 *   - Shell-injection safe (execa with args arrays, never shell:true)
 *   - ripgrep-backed grep with content + context + pagination
 *   - structuredContent + cursor pagination + stability annotations
 *   - DRY: shared handlers, admin MCA re-uses this entry via the sibling package
 */

import { McaServer } from '@teros/mca-sdk';
import {
  append,
  copy,
  deleteTool,
  edit,
  glob,
  grep,
  hash,
  healthCheck,
  list,
  listRoots,
  mkdir,
  move,
  patch,
  read,
  readBatch,
  readMedia,
  stat,
  tree,
  write,
} from './tools';

export function createFilesystemServer(options: { id: string; name: string }) {
  const server = new McaServer({
    id: options.id,
    name: options.name,
    version: '2.1.0',
  });

  server.tool('-health-check', healthCheck);
  server.tool('list-roots', listRoots);

  server.tool('read', read);
  server.tool('read-batch', readBatch);
  server.tool('read-media', readMedia);
  server.tool('write', write);
  server.tool('append', append);
  server.tool('edit', edit);
  server.tool('patch', patch);

  server.tool('list', list);
  server.tool('tree', tree);
  server.tool('stat', stat);
  server.tool('hash', hash);

  server.tool('glob', glob);
  server.tool('grep', grep);

  server.tool('delete', deleteTool);
  server.tool('copy', copy);
  server.tool('move', move);
  server.tool('mkdir', mkdir);

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
