/**
 * Tools de mca.trello portadas al SDK real (TER-507).
 *
 * El MCA importaba un '../mca-sdk-dist/index.js' fosilizado que NO existe
 * en el repo → el proceso moría al arrancar (Cannot find module) con
 * enabled: true en el manifest. Port mecánico de la firma vieja
 * (config, args) a HttpToolConfig con handler(args, context) +
 * context.getUserSecrets(). Los parameters JSON Schema vienen del fix de
 * TER-474 (PR #186, base de este stack).
 */

// biome-ignore-all lint/suspicious/noExplicitAny: destructuring con defaults del port mecánico
import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { createTrelloClient, trelloRequest, type TrelloSecrets } from './client';

export const listBoards: ToolConfig = {
annotations: { readOnlyHint: true },

    description: 'List all boards accessible to authenticated user',
    parameters: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description: 'Filter boards: all, open, closed, members, organization, public, starred',
          enum: ['all', 'open', 'closed', 'members', 'organization', 'public', 'starred'],
          default: 'open',
        },
      },
    },
  handler: async (rawArgs, context) => {
    const secrets = (await context.getUserSecrets()) as TrelloSecrets;
    const { filter = 'open' } = rawArgs as any;

    const client = createTrelloClient(secrets);
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
};

export const createBoard: ToolConfig = {
annotations: { readOnlyHint: false },

    description: 'Create a new board',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of board',
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
      required: ['name'],
    },
  handler: async (rawArgs, context) => {
    const secrets = (await context.getUserSecrets()) as TrelloSecrets;
    const { name, desc, defaultLists = true, prefs_background } = rawArgs as any;

    const client = createTrelloClient(secrets);
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
};

export const getBoard: ToolConfig = {
annotations: { readOnlyHint: true },

    description: 'Get details of a specific board',
    parameters: {
      type: 'object',
      properties: {
        boardId: {
          type: 'string',
          description: 'The ID or short URL of board',
        },
      },
      required: ['boardId'],
    },
  handler: async (rawArgs, context) => {
    const secrets = (await context.getUserSecrets()) as TrelloSecrets;
    const { boardId } = rawArgs as any;

    const client = createTrelloClient(secrets);
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
};

export const updateBoard: ToolConfig = {
annotations: { readOnlyHint: false },

    description: 'Update board properties (name, description, background, etc)',
    parameters: {
      type: 'object',
      properties: {
        boardId: {
          type: 'string',
          description: 'The ID of board to update',
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
      required: ['boardId'],
    },
  handler: async (rawArgs, context) => {
    const secrets = (await context.getUserSecrets()) as TrelloSecrets;
    const { boardId, name, desc, prefs_background } = rawArgs as any;

    const client = createTrelloClient(secrets);
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
};

export const deleteBoard: ToolConfig = {
annotations: { readOnlyHint: false, irreversible: true },

    description: 'Delete a board permanently',
    parameters: {
      type: 'object',
      properties: {
        boardId: {
          type: 'string',
          description: 'The ID of board to delete',
        },
      },
      required: ['boardId'],
    },
  handler: async (rawArgs, context) => {
    const secrets = (await context.getUserSecrets()) as TrelloSecrets;
    const { boardId } = rawArgs as any;

    const client = createTrelloClient(secrets);
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
};

export const listBoardLists: ToolConfig = {
annotations: { readOnlyHint: true },

    description: 'Get all lists in a board',
    parameters: {
      type: 'object',
      properties: {
        boardId: {
          type: 'string',
          description: 'The ID or short URL of board',
        },
      },
      required: ['boardId'],
    },
  handler: async (rawArgs, context) => {
    const secrets = (await context.getUserSecrets()) as TrelloSecrets;
    const { boardId } = rawArgs as any;

    const client = createTrelloClient(secrets);
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
};

export const createList: ToolConfig = {
annotations: { readOnlyHint: false },

    description: 'Create a new list in a board',
    parameters: {
      type: 'object',
      properties: {
        boardId: {
          type: 'string',
          description: 'The ID of board',
        },
        name: {
          type: 'string',
          description: 'Name of list',
        },
        pos: {
          type: 'string',
          description: 'Position: top, bottom, or a positive number (optional)',
        },
      },
      required: ['boardId', 'name'],
    },
  handler: async (rawArgs, context) => {
    const secrets = (await context.getUserSecrets()) as TrelloSecrets;
    const { boardId, name, pos } = rawArgs as any;

    const client = createTrelloClient(secrets);
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
};

export const updateList: ToolConfig = {
annotations: { readOnlyHint: false },

    description: 'Update a list (change color, name, position, etc)',
    parameters: {
      type: 'object',
      properties: {
        listId: {
          type: 'string',
          description: 'The ID of list to update',
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
      required: ['listId'],
    },
  handler: async (rawArgs, context) => {
    const secrets = (await context.getUserSecrets()) as TrelloSecrets;
    const { listId, name, color, pos, closed } = rawArgs as any;

    const client = createTrelloClient(secrets);
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
};

export const listCards: ToolConfig = {
annotations: { readOnlyHint: true },

    description: 'Get all cards in a list',
    parameters: {
      type: 'object',
      properties: {
        listId: {
          type: 'string',
          description: 'The ID of list',
        },
      },
      required: ['listId'],
    },
  handler: async (rawArgs, context) => {
    const secrets = (await context.getUserSecrets()) as TrelloSecrets;
    const { listId } = rawArgs as any;

    const client = createTrelloClient(secrets);
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
};

export const getCard: ToolConfig = {
annotations: { readOnlyHint: true },

    description: 'Get details of a specific card',
    parameters: {
      type: 'object',
      properties: {
        cardId: {
          type: 'string',
          description: 'The ID or short URL of card',
        },
      },
      required: ['cardId'],
    },
  handler: async (rawArgs, context) => {
    const secrets = (await context.getUserSecrets()) as TrelloSecrets;
    const { cardId } = rawArgs as any;

    const client = createTrelloClient(secrets);
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
};

export const createCard: ToolConfig = {
annotations: { readOnlyHint: false },

    description: 'Create a new card in a list',
    parameters: {
      type: 'object',
      properties: {
        listId: {
          type: 'string',
          description: 'The ID of list to create card in',
        },
        name: {
          type: 'string',
          description: 'The name/title of card',
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
      required: ['listId', 'name'],
    },
  handler: async (rawArgs, context) => {
    const secrets = (await context.getUserSecrets()) as TrelloSecrets;
    const { listId, name, desc, pos, due, labels } = rawArgs as any;

    const client = createTrelloClient(secrets);
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
};

export const updateCard: ToolConfig = {
annotations: { readOnlyHint: false },

    description: 'Update a card (move to different list, change name, description, etc)',
    parameters: {
      type: 'object',
      properties: {
        cardId: {
          type: 'string',
          description: 'The ID of card to update',
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
      required: ['cardId'],
    },
  handler: async (rawArgs, context) => {
    const secrets = (await context.getUserSecrets()) as TrelloSecrets;
    const { cardId, name, desc, idList, due, closed } = rawArgs as any;

    const client = createTrelloClient(secrets);
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
};

export const addComment: ToolConfig = {
annotations: { readOnlyHint: false },

    description: 'Add a comment to a card',
    parameters: {
      type: 'object',
      properties: {
        cardId: {
          type: 'string',
          description: 'The ID of card',
        },
        text: {
          type: 'string',
          description: 'The comment text',
        },
      },
      required: ['cardId', 'text'],
    },
  handler: async (rawArgs, context) => {
    const secrets = (await context.getUserSecrets()) as TrelloSecrets;
    const { cardId, text } = rawArgs as any;

    const client = createTrelloClient(secrets);
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
};

export const getCardActions: ToolConfig = {
annotations: { readOnlyHint: true },

    description: 'Get actions/activity history for a card',
    parameters: {
      type: 'object',
      properties: {
        cardId: {
          type: 'string',
          description: 'The ID of card',
        },
        filter: {
          type: 'string',
          description: 'Filter actions: all, commentCard, updateCard, createCard, etc',
          default: 'all',
        },
      },
      required: ['cardId'],
    },
  handler: async (rawArgs, context) => {
    const secrets = (await context.getUserSecrets()) as TrelloSecrets;
    const { cardId, filter = 'all' } = rawArgs as any;

    const client = createTrelloClient(secrets);
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
};

export const listLabels: ToolConfig = {
annotations: { readOnlyHint: true },

    description: 'List all labels on a board',
    parameters: {
      type: 'object',
      properties: {
        boardId: {
          type: 'string',
          description: 'The ID of board',
        },
      },
      required: ['boardId'],
    },
  handler: async (rawArgs, context) => {
    const secrets = (await context.getUserSecrets()) as TrelloSecrets;
    const { boardId } = rawArgs as any;

    const client = createTrelloClient(secrets);
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
};

export const createLabel: ToolConfig = {
annotations: { readOnlyHint: false },

    description: 'Create a label on a board',
    parameters: {
      type: 'object',
      properties: {
        boardId: {
          type: 'string',
          description: 'The ID of board',
        },
        name: {
          type: 'string',
          description: 'Name of label',
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
        },
      },
      required: ['boardId', 'name', 'color'],
    },
  handler: async (rawArgs, context) => {
    const secrets = (await context.getUserSecrets()) as TrelloSecrets;
    const { boardId, name, color } = rawArgs as any;

    const client = createTrelloClient(secrets);
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
};

export const addLabelToCard: ToolConfig = {
annotations: { readOnlyHint: false },

    description: 'Add a label to a card',
    parameters: {
      type: 'object',
      properties: {
        cardId: {
          type: 'string',
          description: 'The ID of card',
        },
        labelId: {
          type: 'string',
          description: 'The ID of label to add',
        },
      },
      required: ['cardId', 'labelId'],
    },
  handler: async (rawArgs, context) => {
    const secrets = (await context.getUserSecrets()) as TrelloSecrets;
    const { cardId, labelId } = rawArgs as any;

    const client = createTrelloClient(secrets);
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
};

export const removeLabelFromCard: ToolConfig = {
annotations: { readOnlyHint: false },

    description: 'Remove a label from a card',
    parameters: {
      type: 'object',
      properties: {
        cardId: {
          type: 'string',
          description: 'The ID of card',
        },
        labelId: {
          type: 'string',
          description: 'The ID of label to remove',
        },
      },
      required: ['cardId', 'labelId'],
    },
  handler: async (rawArgs, context) => {
    const secrets = (await context.getUserSecrets()) as TrelloSecrets;
    const { cardId, labelId } = rawArgs as any;

    const client = createTrelloClient(secrets);
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
};

export const search: ToolConfig = {
annotations: { readOnlyHint: false },

    description: 'Search for cards across all boards',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query',
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
      required: ['query'],
    },
  handler: async (rawArgs, context) => {
    const secrets = (await context.getUserSecrets()) as TrelloSecrets;
    const { query, modelTypes = 'cards', partial = false } = rawArgs as any;

    const client = createTrelloClient(secrets);
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
};
