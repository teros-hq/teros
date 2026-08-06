import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

export interface MockPlaudServerOptions {
  recordings?: unknown[]
  note?: Record<string, unknown>
  transcript?: Record<string, unknown>
  user?: Record<string, unknown>
}

export async function createMockPlaudServer(options: MockPlaudServerOptions = {}) {
  const server = new Server(
    { name: 'mock-plaud', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'list_files',
        description: 'List user recordings',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_file',
        description: 'Get recording metadata',
        inputSchema: {
          type: 'object',
          properties: { file_id: { type: 'string' } },
          required: ['file_id'],
        },
      },
      {
        name: 'get_note',
        description: 'Get AI note summary',
        inputSchema: {
          type: 'object',
          properties: { file_id: { type: 'string' } },
          required: ['file_id'],
        },
      },
      {
        name: 'get_transcript',
        description: 'Get transcript segments',
        inputSchema: {
          type: 'object',
          properties: { file_id: { type: 'string' } },
          required: ['file_id'],
        },
      },
      {
        name: 'get_current_user',
        description: 'Get current user',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    switch (name) {
      case 'list_files':
        return {
          content: [{ type: 'text', text: JSON.stringify(options.recordings ?? []) }],
        }
      case 'get_file':
        return {
          content: [{ type: 'text', text: JSON.stringify(options.note ?? { file_id: args?.file_id }) }],
        }
      case 'get_note':
        return {
          content: [{ type: 'text', text: JSON.stringify(options.note ?? { file_id: args?.file_id }) }],
        }
      case 'get_transcript':
        return {
          content: [{ type: 'text', text: JSON.stringify(options.transcript ?? { file_id: args?.file_id, segments: [] }) }],
        }
      case 'get_current_user':
        return {
          content: [{ type: 'text', text: JSON.stringify(options.user ?? { user_id: 'mock-user' }) }],
        }
      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        }
    }
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)

  return { server, clientTransport }
}
