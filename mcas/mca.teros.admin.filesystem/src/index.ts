#!/usr/bin/env npx tsx

/**
 * Teros Filesystem (Admin)
 *
 * Re-uses the user MCA handlers via the `mca.teros.filesystem` package.
 * Differences from the user MCA:
 *   - Transport: stdio (MCP)
 *   - Role: admin (no workspace jail — MCA_FS_ROLE=admin)
 */

import { createFilesystemServer } from 'mca.teros.filesystem/src/index';

process.env.MCA_FS_ROLE = 'admin';
process.env.MCA_TRANSPORT = process.env.MCA_TRANSPORT || 'stdio';

const server = createFilesystemServer({
  id: 'mca.teros.admin.filesystem',
  name: 'Filesystem (Admin)',
});

server
  .start()
  .then(() => {
    console.error('📁 Teros Filesystem (Admin) MCA running');
  })
  .catch((error) => {
    console.error('Failed to start Teros Filesystem (Admin):', error);
    process.exit(1);
  });
