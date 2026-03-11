#!/usr/bin/env npx tsx

/**
 * Trello MCA v1.0
 *
 * Trello project management using McaServer with HTTP transport.
 * Secrets are fetched on-demand from backend via callbackUrl.
 *
 * Deployment: per-app (each installed app gets its own process)
 */

import { HealthCheckBuilder, McaServer } from '../mca-sdk-dist/index.js';

// =============================================================================
// TYPES
// =============================================================================

interface TrelloSecrets {
  TRELLO_API_KEY?: string;
  TRELLO_TOKEN?: string;
}

interface TrelloConfig {
  secrets: TrelloSecrets;
}

// =============================================================================
// TRELLO CLIENT FACTORY
// =============================================================================

/**
 * Creates a Trello API client from secrets
 */
function createTrelloClient(secrets: TrelloSecrets) {
  const apiKey = secrets.TRELLO_API_KEY;
  const token = secrets.TRELLO_TOKEN;

  if (!apiKey || !token) {
    throw new Error('Trello credentials not configured. Missing TRELLO_API_KEY or TRELLO_TOKEN.');
  }

  return {
    apiKey,
    token,
    baseUrl: 'https://api.trello.com/1',
  };
}

/**
 * Helper function to make Trello API requests
 */
async function trelloRequest(
  client: ReturnType<typeof createTrelloClient>,
  endpoint: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  body?: any,
): Promise<any> {
  const url = new URL(`${client.baseUrl}${endpoint}`);
  url.searchParams.append('key', client.apiKey!);
  url.searchParams.append('token', client.token!);

  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
  };

  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url.toString(), options);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Trello API error: ${response.status} ${response.statusText}\n${errorText}`);
  }

  return response.json();
}

// =============================================================================
// SERVER SETUP
// =============================================================================

const server = new McaServer<TrelloConfig>({
  id: 'mca.trello',
  name: 'Trello',
  version: '1.0.0',
  description: 'Trello project management - boards, lists, cards, labels, members',

  async onConfig() {
    // Fetch secrets from backend
    const secrets = await server.getSecrets(['TRELLO_API_KEY', 'TRELLO_TOKEN']);

    return {
      secrets,
    };
  },

  async healthCheck(config) {
    try {
      const client = createTrelloClient(config.secrets);
      await trelloRequest(client, '/members/me');

      return HealthCheckBuilder.ok()
        .data({ authenticated: true })
        .message('Trello API connection successful')
        .build();
    } catch (error: any) {
      return HealthCheckBuilder.error()
        .data({ authenticated: false, error: error.message })
        .message(`Trello API connection failed: ${error.message}`)
        .build();
    }
  },
});

// =============================================================================
// BOARD OPERATIONS
// =============================================================================

server.tool(
  'list-boards',
  {
    description: 'List all boards accessible to authenticated user',
    parameters: {
      filter: {
        type: 'string',
        description: 'Filter boards: all, open, closed, members, organization, public, starred',
        enum: ['all', 'open', 'closed', 'members', 'organization', 'public', 'starred'],
        default: 'open',
      },
    },
  },
  async (config, { filter = 'open' }) => {
    const client = createTrelloClient(config.secrets);
    const boards = await trelloRequest(client, `/members/me/boards?filter=${filter}`);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(boards, null, 2),
        },
      ],
    };
  },
);

server.tool(
  'create-board',
  {
    description: 'Create a new board',
    parameters: {
      name: {
        type: 'string',
        description: 'Name of board',
        required: true,
      },
      desc: {
        type: 'string',
        description: 'Description of board (optional)',
      },
      defaultLists: {
        type: 'boolean',
        description: 'Whether to create default lists (To Do, Doing, Done). Default: true',
        default: true,
      },
      prefs_background: {
        type: 'string',
        description:
          'Background color or image (optional, e.g., "blue", "orange", "gradient-rainbow")',
      },
    },
  },
  async (config, { name, desc, defaultLists = true, prefs_background }) => {
    const client = createTrelloClient(config.secrets);
    const body: any = { name, defaultLists };

    if (desc) body.desc = desc;
    if (prefs_background) body.prefs_background = prefs_background;

    const board = await trelloRequest(client, '/boards', 'POST', body);

    return {
      content: [
        {
          type: 'text',
          text: `Board created successfully!\n\n${JSON.stringify(board, null, 2)}`,
        },
      ],
    };
  },
);

server.tool(
  'get-board',
  {
    description: 'Get details of a specific board',
    parameters: {
      boardId: {
        type: 'string',
        description: 'The ID or short URL of board',
        required: true,
      },
    },
  },
  async (config, { boardId }) => {
    const client = createTrelloClient(config.secrets);
    const board = await trelloRequest(client, `/boards/${boardId}`);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(board, null, 2),
        },
      ],
    };
  },
);

server.tool(
  'update-board',
  {
    description: 'Update board properties (name, description, background, etc)',
    parameters: {
      boardId: {
        type: 'string',
        description: 'The ID of board to update',
        required: true,
      },
      name: {
        type: 'string',
        description: 'New name for board (optional)',
      },
      desc: {
        type: 'string',
        description: 'New description for board (optional)',
      },
      prefs_background: {
        type: 'string',
        description:
          'Background color or image (optional, e.g., "blue", "orange", "gradient-rainbow")',
      },
    },
  },
  async (config, { boardId, name, desc, prefs_background }) => {
    const client = createTrelloClient(config.secrets);
    const body: any = {};

    if (name) body.name = name;
    if (desc) body.desc = desc;
    if (prefs_background) body.prefs_background = prefs_background;

    const board = await trelloRequest(client, `/boards/${boardId}`, 'PUT', body);

    return {
      content: [
        {
          type: 'text',
          text: `Board updated successfully!\n\n${JSON.stringify(board, null, 2)}`,
        },
      ],
    };
  },
);

server.tool(
  'delete-board',
  {
    description: 'Delete a board permanently',
    parameters: {
      boardId: {
        type: 'string',
        description: 'The ID of board to delete',
        required: true,
      },
    },
  },
  async (config, { boardId }) => {
    const client = createTrelloClient(config.secrets);
    await trelloRequest(client, `/boards/${boardId}`, 'DELETE');

    return {
      content: [
        {
          type: 'text',
          text: 'Board deleted successfully!',
        },
      ],
    };
  },
);

// =============================================================================
// LIST OPERATIONS
// =============================================================================

server.tool(
  'list-board-lists',
  {
    description: 'Get all lists in a board',
    parameters: {
      boardId: {
        type: 'string',
        description: 'The ID or short URL of board',
        required: true,
      },
    },
  },
  async (config, { boardId }) => {
    const client = createTrelloClient(config.secrets);
    const lists = await trelloRequest(client, `/boards/${boardId}/lists`);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(lists, null, 2),
        },
      ],
    };
  },
);

server.tool(
  'create-list',
  {
    description: 'Create a new list in a board',
    parameters: {
      boardId: {
        type: 'string',
        description: 'The ID of board',
        required: true,
      },
      name: {
        type: 'string',
        description: 'Name of list',
        required: true,
      },
      pos: {
        type: 'string',
        description: 'Position: top, bottom, or a positive number (optional)',
      },
    },
  },
  async (config, { boardId, name, pos }) => {
    const client = createTrelloClient(config.secrets);
    const body: any = { name, idBoard: boardId };

    if (pos) body.pos = pos;

    const list = await trelloRequest(client, '/lists', 'POST', body);

    return {
      content: [
        {
          type: 'text',
          text: `List created successfully!\n\n${JSON.stringify(list, null, 2)}`,
        },
      ],
    };
  },
);

server.tool(
  'update-list',
  {
    description: 'Update a list (change color, name, position, etc)',
    parameters: {
      listId: {
        type: 'string',
        description: 'The ID of list to update',
        required: true,
      },
      name: {
        type: 'string',
        description: 'New name for list (optional)',
      },
      color: {
        type: 'string',
        description:
          'Color for list (optional): pink, yellow, lime, blue, black, orange, red, purple, sky, green',
        enum: [
          'pink',
          'yellow',
          'lime',
          'blue',
          'black',
          'orange',
          'red',
          'purple',
          'sky',
          'green',
        ],
      },
      pos: {
        type: 'string',
        description: 'New position: top, bottom, or a positive number (optional)',
      },
      closed: {
        type: 'boolean',
        description: 'Whether to archive the list (optional)',
      },
    },
  },
  async (config, { listId, name, color, pos, closed }) => {
    const client = createTrelloClient(config.secrets);
    const body: any = {};

    if (name) body.name = name;
    if (color) body.color = color;
    if (pos) body.pos = pos;
    if (closed !== undefined) body.closed = closed;

    const list = await trelloRequest(client, `/lists/${listId}`, 'PUT', body);

    return {
      content: [
        {
          type: 'text',
          text: `List updated successfully!\n\n${JSON.stringify(list, null, 2)}`,
        },
      ],
    };
  },
);

// =============================================================================
// CARD OPERATIONS
// =============================================================================

server.tool(
  'list-cards',
  {
    description: 'Get all cards in a list',
    parameters: {
      listId: {
        type: 'string',
        description: 'The ID of list',
        required: true,
      },
    },
  },
  async (config, { listId }) => {
    const client = createTrelloClient(config.secrets);
    const cards = await trelloRequest(client, `/lists/${listId}/cards`);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(cards, null, 2),
        },
      ],
    };
  },
);

server.tool(
  'get-card',
  {
    description: 'Get details of a specific card',
    parameters: {
      cardId: {
        type: 'string',
        description: 'The ID or short URL of card',
        required: true,
      },
    },
  },
  async (config, { cardId }) => {
    const client = createTrelloClient(config.secrets);
    const card = await trelloRequest(client, `/cards/${cardId}`);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(card, null, 2),
        },
      ],
    };
  },
);

server.tool(
  'create-card',
  {
    description: 'Create a new card in a list',
    parameters: {
      listId: {
        type: 'string',
        description: 'The ID of list to create card in',
        required: true,
      },
      name: {
        type: 'string',
        description: 'The name/title of card',
        required: true,
      },
      desc: {
        type: 'string',
        description: 'The description of card (optional)',
      },
      pos: {
        type: 'string',
        description: 'Position of card: top, bottom, or a positive number (optional)',
      },
      due: {
        type: 'string',
        description: 'Due date in ISO 8601 format (optional)',
      },
      labels: {
        type: 'string',
        description: 'Comma-separated list of label IDs (optional)',
      },
    },
  },
  async (config, { listId, name, desc, pos, due, labels }) => {
    const client = createTrelloClient(config.secrets);
    const body: any = { idList: listId, name };

    if (desc) body.desc = desc;
    if (pos) body.pos = pos;
    if (due) body.due = due;
    if (labels) body.idLabels = labels;

    const card = await trelloRequest(client, '/cards', 'POST', body);

    return {
      content: [
        {
          type: 'text',
          text: `Card created successfully!\n\n${JSON.stringify(card, null, 2)}`,
        },
      ],
    };
  },
);

server.tool(
  'update-card',
  {
    description: 'Update a card (move to different list, change name, description, etc)',
    parameters: {
      cardId: {
        type: 'string',
        description: 'The ID of card to update',
        required: true,
      },
      name: {
        type: 'string',
        description: 'New name for card (optional)',
      },
      desc: {
        type: 'string',
        description: 'New description for card (optional)',
      },
      idList: {
        type: 'string',
        description: 'ID of list to move card to (optional)',
      },
      due: {
        type: 'string',
        description: 'New due date in ISO 8601 format (optional)',
      },
      closed: {
        type: 'boolean',
        description: 'Whether to archive card (optional)',
      },
    },
  },
  async (config, { cardId, name, desc, idList, due, closed }) => {
    const client = createTrelloClient(config.secrets);
    const body: any = {};

    if (name) body.name = name;
    if (desc) body.desc = desc;
    if (idList) body.idList = idList;
    if (due) body.due = due;
    if (closed !== undefined) body.closed = closed;

    const card = await trelloRequest(client, `/cards/${cardId}`, 'PUT', body);

    return {
      content: [
        {
          type: 'text',
          text: `Card updated successfully!\n\n${JSON.stringify(card, null, 2)}`,
        },
      ],
    };
  },
);

server.tool(
  'add-comment',
  {
    description: 'Add a comment to a card',
    parameters: {
      cardId: {
        type: 'string',
        description: 'The ID of card',
        required: true,
      },
      text: {
        type: 'string',
        description: 'The comment text',
        required: true,
      },
    },
  },
  async (config, { cardId, text }) => {
    const client = createTrelloClient(config.secrets);
    const comment = await trelloRequest(client, `/cards/${cardId}/actions/comments`, 'POST', {
      text,
    });

    return {
      content: [
        {
          type: 'text',
          text: `Comment added successfully!\n\n${JSON.stringify(comment, null, 2)}`,
        },
      ],
    };
  },
);

server.tool(
  'get-card-actions',
  {
    description: 'Get actions/activity history for a card',
    parameters: {
      cardId: {
        type: 'string',
        description: 'The ID of card',
        required: true,
      },
      filter: {
        type: 'string',
        description: 'Filter actions: all, commentCard, updateCard, createCard, etc',
        default: 'all',
      },
    },
  },
  async (config, { cardId, filter = 'all' }) => {
    const client = createTrelloClient(config.secrets);
    const actions = await trelloRequest(client, `/cards/${cardId}/actions?filter=${filter}`);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(actions, null, 2),
        },
      ],
    };
  },
);

// =============================================================================
// LABEL OPERATIONS
// =============================================================================

server.tool(
  'list-labels',
  {
    description: 'List all labels on a board',
    parameters: {
      boardId: {
        type: 'string',
        description: 'The ID of board',
        required: true,
      },
    },
  },
  async (config, { boardId }) => {
    const client = createTrelloClient(config.secrets);
    const labels = await trelloRequest(client, `/boards/${boardId}/labels`);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(labels, null, 2),
        },
      ],
    };
  },
);

server.tool(
  'create-label',
  {
    description: 'Create a label on a board',
    parameters: {
      boardId: {
        type: 'string',
        description: 'The ID of board',
        required: true,
      },
      name: {
        type: 'string',
        description: 'Name of label',
        required: true,
      },
      color: {
        type: 'string',
        description:
          'Color of label: yellow, purple, blue, red, green, orange, black, sky, pink, lime',
        enum: [
          'yellow',
          'purple',
          'blue',
          'red',
          'green',
          'orange',
          'black',
          'sky',
          'pink',
          'lime',
        ],
        required: true,
      },
    },
  },
  async (config, { boardId, name, color }) => {
    const client = createTrelloClient(config.secrets);
    const body = { name, color };

    const label = await trelloRequest(client, `/boards/${boardId}/labels`, 'POST', body);

    return {
      content: [
        {
          type: 'text',
          text: `Label created successfully!\n\n${JSON.stringify(label, null, 2)}`,
        },
      ],
    };
  },
);

server.tool(
  'add-label-to-card',
  {
    description: 'Add a label to a card',
    parameters: {
      cardId: {
        type: 'string',
        description: 'The ID of card',
        required: true,
      },
      labelId: {
        type: 'string',
        description: 'The ID of label to add',
        required: true,
      },
    },
  },
  async (config, { cardId, labelId }) => {
    const client = createTrelloClient(config.secrets);
    await trelloRequest(client, `/cards/${cardId}/idLabels`, 'POST', { value: labelId });

    return {
      content: [
        {
          type: 'text',
          text: 'Label added to card successfully!',
        },
      ],
    };
  },
);

server.tool(
  'remove-label-from-card',
  {
    description: 'Remove a label from a card',
    parameters: {
      cardId: {
        type: 'string',
        description: 'The ID of card',
        required: true,
      },
      labelId: {
        type: 'string',
        description: 'The ID of label to remove',
        required: true,
      },
    },
  },
  async (config, { cardId, labelId }) => {
    const client = createTrelloClient(config.secrets);
    await trelloRequest(client, `/cards/${cardId}/idLabels/${labelId}`, 'DELETE');

    return {
      content: [
        {
          type: 'text',
          text: 'Label removed from card successfully!',
        },
      ],
    };
  },
);

// =============================================================================
// SEARCH OPERATIONS
// =============================================================================

server.tool(
  'search',
  {
    description: 'Search for cards across all boards',
    parameters: {
      query: {
        type: 'string',
        description: 'Search query',
        required: true,
      },
      modelTypes: {
        type: 'string',
        description: 'Comma-separated list: cards, boards, members (default: cards)',
        default: 'cards',
      },
      partial: {
        type: 'boolean',
        description: 'Whether to match partial words (default: false)',
        default: false,
      },
    },
  },
  async (config, { query, modelTypes = 'cards', partial = false }) => {
    const client = createTrelloClient(config.secrets);
    const results = await trelloRequest(
      client,
      `/search?query=${encodeURIComponent(query)}&modelTypes=${modelTypes}&partial=${partial}`,
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(results, null, 2),
        },
      ],
    };
  },
);

// =============================================================================
// START SERVER
// =============================================================================

server.start().catch(console.error);
