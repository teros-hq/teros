#!/usr/bin/env npx tsx

import { McaServer } from '@teros/mca-sdk';
import { domainSearch, emailFinder, emailVerifier, healthCheck } from './tools';

export function createHunterServer(): McaServer {
  const server = new McaServer({
    id: 'mca.hunter',
    name: 'Hunter',
    version: '1.0.0',
  });

  server.tool('-health-check', healthCheck);
  server.tool('domain-search', domainSearch);
  server.tool('email-finder', emailFinder);
  server.tool('email-verifier', emailVerifier);

  return server;
}

const isDirectEntry = import.meta.url === `file://${process.argv[1]}`;
if (isDirectEntry) {
  const server = createHunterServer();
  server
    .start()
    .then(() => {
      console.error('Hunter MCA server running');
    })
    .catch((err) => {
      console.error('Failed to start Hunter MCA:', err);
      process.exit(1);
    });
}
