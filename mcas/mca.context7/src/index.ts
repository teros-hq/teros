#!/usr/bin/env npx tsx

import { McaServer } from '@teros/mca-sdk';
import { getDocs, healthCheck, resolveLibrary } from './tools';

export function createContext7Server(): McaServer {
  const server = new McaServer({
    id: 'mca.context7',
    name: 'Context7',
    version: '1.0.0',
  });

  server.tool('-health-check', healthCheck);
  server.tool('resolve-library', resolveLibrary);
  server.tool('get-docs', getDocs);

  return server;
}

const isDirectEntry = import.meta.url === `file://${process.argv[1]}`;
if (isDirectEntry) {
  const server = createContext7Server();
  server
    .start()
    .then(() => {
      console.error('Context7 MCA server running');
    })
    .catch((err) => {
      console.error('Failed to start Context7 MCA:', err);
      process.exit(1);
    });
}
