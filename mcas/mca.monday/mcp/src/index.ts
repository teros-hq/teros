#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const API_TOKEN = process.env.MONDAY_API_TOKEN;
const API_URL = 'https://api.monday.com/v2';

if (!API_TOKEN) {
  console.error('Error: MONDAY_API_TOKEN must be set');
  process.exit(1);
}

const server = new Server(
  {
    name: 'monday',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Helper function to make Monday.com GraphQL requests
async function mondayRequest(query: string, variables?: Record<string, any>): Promise<any> {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: API_TOKEN!,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Monday API error: ${response.status} ${response.statusText}\n${errorText}`);
  }

  const data = await response.json();

  if (data.errors) {
    throw new Error(`Monday GraphQL error: ${JSON.stringify(data.errors)}`);
  }

  return data.data;
}

const tools: Tool[] = [
  {
    name: 'monday_get_me',
    description: 'Get information about the authenticated user',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'monday_list_boards',
    description: 'List all boards accessible to the user',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of boards to return (default: 25)',
          default: 25,
        },
        workspace_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Filter by workspace IDs (optional)',
        },
      },
    },
  },
  {
    name: 'monday_get_board',
    description: 'Get details of a specific board including its groups and columns',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: {
          type: 'number',
          description: 'The ID of the board',
        },
      },
      required: ['board_id'],
    },
  },
  {
    name: 'monday_create_board',
    description: 'Create a new board',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the board',
        },
        kind: {
          type: 'string',
          description: 'Board kind: public, private, or share',
          enum: ['public', 'private', 'share'],
          default: 'public',
        },
        workspace_id: {
          type: 'number',
          description: 'Workspace ID to create the board in (optional)',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'monday_list_items',
    description: 'List items (rows) in a board',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: {
          type: 'number',
          description: 'The ID of the board',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of items to return (default: 50)',
          default: 50,
        },
        group_id: {
          type: 'string',
          description: 'Filter by group ID (optional)',
        },
      },
      required: ['board_id'],
    },
  },
  {
    name: 'monday_get_item',
    description: 'Get details of a specific item including all column values',
    inputSchema: {
      type: 'object',
      properties: {
        item_id: {
          type: 'number',
          description: 'The ID of the item',
        },
      },
      required: ['item_id'],
    },
  },
  {
    name: 'monday_create_item',
    description: 'Create a new item (row) in a board',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: {
          type: 'number',
          description: 'The ID of the board',
        },
        item_name: {
          type: 'string',
          description: 'Name of the item',
        },
        group_id: {
          type: 'string',
          description:
            'Group ID to create the item in (optional, uses first group if not specified)',
        },
        column_values: {
          type: 'object',
          description:
            'Column values as JSON object (optional). Keys are column IDs, values are the data.',
        },
      },
      required: ['board_id', 'item_name'],
    },
  },
  {
    name: 'monday_update_item',
    description: 'Update column values of an item',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: {
          type: 'number',
          description: 'The ID of the board',
        },
        item_id: {
          type: 'number',
          description: 'The ID of the item',
        },
        column_values: {
          type: 'object',
          description: 'Column values to update as JSON object. Keys are column IDs.',
        },
      },
      required: ['board_id', 'item_id', 'column_values'],
    },
  },
  {
    name: 'monday_delete_item',
    description: 'Delete an item',
    inputSchema: {
      type: 'object',
      properties: {
        item_id: {
          type: 'number',
          description: 'The ID of the item to delete',
        },
      },
      required: ['item_id'],
    },
  },
  {
    name: 'monday_list_groups',
    description: 'List all groups in a board',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: {
          type: 'number',
          description: 'The ID of the board',
        },
      },
      required: ['board_id'],
    },
  },
  {
    name: 'monday_create_group',
    description: 'Create a new group in a board',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: {
          type: 'number',
          description: 'The ID of the board',
        },
        group_name: {
          type: 'string',
          description: 'Name of the group',
        },
      },
      required: ['board_id', 'group_name'],
    },
  },
  {
    name: 'monday_list_columns',
    description: 'List all columns in a board',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: {
          type: 'number',
          description: 'The ID of the board',
        },
      },
      required: ['board_id'],
    },
  },
  {
    name: 'monday_add_update',
    description: 'Add an update (comment) to an item',
    inputSchema: {
      type: 'object',
      properties: {
        item_id: {
          type: 'number',
          description: 'The ID of the item',
        },
        body: {
          type: 'string',
          description: 'The update/comment text (supports HTML)',
        },
      },
      required: ['item_id', 'body'],
    },
  },
  {
    name: 'monday_list_updates',
    description: 'List updates (comments) for an item',
    inputSchema: {
      type: 'object',
      properties: {
        item_id: {
          type: 'number',
          description: 'The ID of the item',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of updates to return (default: 25)',
          default: 25,
        },
      },
      required: ['item_id'],
    },
  },
  {
    name: 'monday_search_items',
    description: 'Search for items across boards',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of items to return (default: 25)',
          default: 25,
        },
      },
      required: ['query'],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  const { name, arguments: args } = request.params;

  if (!args) {
    throw new Error('Missing arguments');
  }

  try {
    switch (name) {
      case 'monday_get_me': {
        const query = `query { me { id name email } }`;
        const result = await mondayRequest(query);
        return {
          content: [{ type: 'text', text: JSON.stringify(result.me, null, 2) }],
        };
      }

      case 'monday_list_boards': {
        const limit = (args.limit as number) || 25;
        const workspaceFilter = args.workspace_ids
          ? `, workspace_ids: [${(args.workspace_ids as number[]).join(',')}]`
          : '';
        const query = `query { boards(limit: ${limit}${workspaceFilter}) { id name state workspace_id } }`;
        const result = await mondayRequest(query);
        return {
          content: [{ type: 'text', text: JSON.stringify(result.boards, null, 2) }],
        };
      }

      case 'monday_get_board': {
        const query = `query { boards(ids: [${args.board_id}]) { id name state workspace_id groups { id title color } columns { id title type settings_str } } }`;
        const result = await mondayRequest(query);
        return {
          content: [{ type: 'text', text: JSON.stringify(result.boards[0], null, 2) }],
        };
      }

      case 'monday_create_board': {
        const kind = (args.kind as string) || 'public';
        const workspaceArg = args.workspace_id ? `, workspace_id: ${args.workspace_id}` : '';
        const query = `mutation { create_board(board_name: "${args.name}", board_kind: ${kind}${workspaceArg}) { id name } }`;
        const result = await mondayRequest(query);
        return {
          content: [
            {
              type: 'text',
              text: `Board created!\n\n${JSON.stringify(result.create_board, null, 2)}`,
            },
          ],
        };
      }

      case 'monday_list_items': {
        const limit = (args.limit as number) || 50;
        const groupFilter = args.group_id ? `(ids: ["${args.group_id}"])` : '';
        const query = `query { boards(ids: [${args.board_id}]) { items_page(limit: ${limit}) { items { id name group { id title } column_values { id text value } } } groups${groupFilter} { id title } } }`;
        const result = await mondayRequest(query);
        return {
          content: [{ type: 'text', text: JSON.stringify(result.boards[0], null, 2) }],
        };
      }

      case 'monday_get_item': {
        const query = `query { items(ids: [${args.item_id}]) { id name board { id name } group { id title } column_values { id title text value type } updates { id body created_at creator { name } } } }`;
        const result = await mondayRequest(query);
        return {
          content: [{ type: 'text', text: JSON.stringify(result.items[0], null, 2) }],
        };
      }

      case 'monday_create_item': {
        const groupArg = args.group_id ? `, group_id: "${args.group_id}"` : '';
        const columnValues = args.column_values
          ? `, column_values: ${JSON.stringify(JSON.stringify(args.column_values))}`
          : '';
        const query = `mutation { create_item(board_id: ${args.board_id}, item_name: "${args.item_name}"${groupArg}${columnValues}) { id name } }`;
        const result = await mondayRequest(query);
        return {
          content: [
            {
              type: 'text',
              text: `Item created!\n\n${JSON.stringify(result.create_item, null, 2)}`,
            },
          ],
        };
      }

      case 'monday_update_item': {
        const columnValues = JSON.stringify(JSON.stringify(args.column_values));
        const query = `mutation { change_multiple_column_values(board_id: ${args.board_id}, item_id: ${args.item_id}, column_values: ${columnValues}) { id name } }`;
        const result = await mondayRequest(query);
        return {
          content: [
            {
              type: 'text',
              text: `Item updated!\n\n${JSON.stringify(result.change_multiple_column_values, null, 2)}`,
            },
          ],
        };
      }

      case 'monday_delete_item': {
        const query = `mutation { delete_item(item_id: ${args.item_id}) { id } }`;
        const result = await mondayRequest(query);
        return {
          content: [{ type: 'text', text: `Item deleted! ID: ${result.delete_item.id}` }],
        };
      }

      case 'monday_list_groups': {
        const query = `query { boards(ids: [${args.board_id}]) { groups { id title color position } } }`;
        const result = await mondayRequest(query);
        return {
          content: [{ type: 'text', text: JSON.stringify(result.boards[0].groups, null, 2) }],
        };
      }

      case 'monday_create_group': {
        const query = `mutation { create_group(board_id: ${args.board_id}, group_name: "${args.group_name}") { id title } }`;
        const result = await mondayRequest(query);
        return {
          content: [
            {
              type: 'text',
              text: `Group created!\n\n${JSON.stringify(result.create_group, null, 2)}`,
            },
          ],
        };
      }

      case 'monday_list_columns': {
        const query = `query { boards(ids: [${args.board_id}]) { columns { id title type description settings_str } } }`;
        const result = await mondayRequest(query);
        return {
          content: [{ type: 'text', text: JSON.stringify(result.boards[0].columns, null, 2) }],
        };
      }

      case 'monday_add_update': {
        const body = (args.body as string).replace(/"/g, '\\"');
        const query = `mutation { create_update(item_id: ${args.item_id}, body: "${body}") { id body created_at } }`;
        const result = await mondayRequest(query);
        return {
          content: [
            {
              type: 'text',
              text: `Update added!\n\n${JSON.stringify(result.create_update, null, 2)}`,
            },
          ],
        };
      }

      case 'monday_list_updates': {
        const limit = (args.limit as number) || 25;
        const query = `query { items(ids: [${args.item_id}]) { updates(limit: ${limit}) { id body created_at creator { name email } } } }`;
        const result = await mondayRequest(query);
        return {
          content: [{ type: 'text', text: JSON.stringify(result.items[0].updates, null, 2) }],
        };
      }

      case 'monday_search_items': {
        const limit = (args.limit as number) || 25;
        // Simple text search in item names across all boards
        const fallbackQuery = `query { boards(limit: 50) { id name items_page(limit: 100) { items { id name } } } }`;
        const result = await mondayRequest(fallbackQuery);
        const searchTerm = (args.query as string).toLowerCase();
        const matchingItems = result.boards.flatMap((b: any) =>
          (b.items_page?.items || [])
            .filter((i: any) => i.name.toLowerCase().includes(searchTerm))
            .map((i: any) => ({ ...i, board: { id: b.id, name: b.name } })),
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(matchingItems.slice(0, limit), null, 2) }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Monday.com MCP Server running on stdio');
}

runServer().catch(console.error);
