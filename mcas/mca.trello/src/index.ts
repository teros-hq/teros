#!/usr/bin/env npx tsx

/**
 * Trello MCA v1.0 — portado al SDK real (TER-507).
 *
 * El archivo original importaba `'../mca-sdk-dist/index.js'` (un dist local
 * fosilizado que NO existe en el repo) con una API antigua (McaServer
 * genérico + onConfig/healthCheck en el constructor + server.tool de 3
 * argumentos) → el proceso moría al arrancar con Cannot find module,
 * teniendo enabled: true en el manifest. Las 19 tools viven ahora en
 * ./tools.ts con la firma HttpToolConfig actual.
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { createTrelloClient, trelloRequest, type TrelloSecrets } from './client';
import {
  addComment,
  addLabelToCard,
  createBoard,
  createCard,
  createLabel,
  createList,
  deleteBoard,
  getBoard,
  getCard,
  getCardActions,
  listBoardLists,
  listBoards,
  listCards,
  listLabels,
  removeLabelFromCard,
  search,
  updateBoard,
  updateCard,
  updateList,
} from './tools';

const VERSION = '1.0.0';

const server = new McaServer({
  id: 'mca.trello',
  name: 'Trello',
  version: VERSION,
});

server.tool('-health-check', {
  description: 'Internal health check. Verifies Trello credentials and API connectivity.',
  parameters: { type: 'object', properties: {} },
  annotations: {
    version: VERSION,
    stability: 'stable',
    readOnlyHint: true,
    openWorldHint: true,
  },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder()
      .setVersion(VERSION)
      .setUptime(Math.floor(process.uptime()));

    let secrets: TrelloSecrets;
    try {
      secrets = (await context.getUserSecrets()) as TrelloSecrets;
    } catch {
      builder.addIssue('AUTH_REQUIRED', 'Cannot retrieve user secrets', {
        type: 'admin_action',
        description: 'Ensure callbackUrl is provided and backend is reachable.',
      });
      return builder.build();
    }

    if (!secrets.TRELLO_API_KEY || !secrets.TRELLO_TOKEN) {
      builder.addIssue('AUTH_REQUIRED', 'Missing TRELLO_API_KEY or TRELLO_TOKEN', {
        type: 'user_action',
        description: 'Configure your Trello API key and token in the app settings.',
      });
      return builder.build();
    }

    try {
      const client = createTrelloClient(secrets);
      await trelloRequest(client, '/members/me');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('401')) {
        builder.addIssue('AUTH_EXPIRED', 'Trello credentials are invalid or expired', {
          type: 'user_action',
          description: 'Re-check your Trello API key and token in the app settings.',
        });
      } else {
        builder.addIssue('DEPENDENCY_UNAVAILABLE', `Trello API unreachable: ${message}`, {
          type: 'auto_retry',
          description: 'Check that the Trello API is available.',
        });
      }
    }

    return builder.build();
  },
});

server.tool('list-boards', listBoards);
server.tool('create-board', createBoard);
server.tool('get-board', getBoard);
server.tool('update-board', updateBoard);
server.tool('delete-board', deleteBoard);
server.tool('list-board-lists', listBoardLists);
server.tool('create-list', createList);
server.tool('update-list', updateList);
server.tool('list-cards', listCards);
server.tool('get-card', getCard);
server.tool('create-card', createCard);
server.tool('update-card', updateCard);
server.tool('add-comment', addComment);
server.tool('get-card-actions', getCardActions);
server.tool('list-labels', listLabels);
server.tool('create-label', createLabel);
server.tool('add-label-to-card', addLabelToCard);
server.tool('remove-label-from-card', removeLabelFromCard);
server.tool('search', search);

server.start().catch(console.error);
