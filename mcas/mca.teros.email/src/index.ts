#!/usr/bin/env npx tsx

/**
 * Email MCA (mca.teros.email) — PERSONAL plane: self-hosted email over
 * Stalwart (JMAP) for Teros agents (and humans with a personal mailbox).
 *
 * Each installed instance IS one mailbox (MAIL_ACCOUNT user secret):
 * it reads folders and messages, sends with its own identity, marks read
 * and destroys. The admin plane (domains, accounts, DNS, rename) lives in
 * mca.teros.admin.email — split decision 1-nov (two MCAs: personal for
 * agents, admin for the human).
 *
 * Transport: direct baseUrl + admin token (single transport, e.g. relay.teros.ai).
 * JMAP errors inside HTTP 200 are detected and thrown (never swallowed).
 *
 * Uses McaServer from @teros/mca-sdk for automatic transport detection.
 */

import { McaServer } from '@teros/mca-sdk';
import { destroy } from './tools/destroy';
import { healthCheck } from './tools/health-check';
import { listFolders } from './tools/list-folders';
import { listMessages } from './tools/list-messages';
import { markRead } from './tools/mark-read';
import { readMessage } from './tools/read-message';
import { send } from './tools/send';
import { sessionInfo } from './tools/session-info';

const server = new McaServer({
  id: 'mca.teros.email',
  name: 'Email',
  version: '0.2.0',
});

// Private (always allowed, outside the permission map)
server.tool('-health-check', healthCheck);

// Mail — read (seeded allow via readOnlyHint)
server.tool('session-info', sessionInfo);
server.tool('list-folders', listFolders);
server.tool('list-messages', listMessages);
server.tool('read-message', readMessage);

// Mail — mutations (seeded ask)
server.tool('send', send);
server.tool('mark-read', markRead);
server.tool('destroy', destroy);

server.start().catch((error) => {
  console.error('[Email MCA] Fatal error:', error);
  process.exit(1);
});
