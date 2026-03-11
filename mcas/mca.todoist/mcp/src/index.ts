#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'fs';
import { join } from 'path';

// Load API token from mca-apps/todoist/auth.json
const AUTH_PATH = join(import.meta.dir, '..', '..', '..', 'mca-apps', 'todoist', 'auth.json');
const BASE_URL = 'https://api.todoist.com/rest/v2';

let API_TOKEN: string | null = null;

try {
  const authData = JSON.parse(readFileSync(AUTH_PATH, 'utf-8'));
  API_TOKEN = authData.apiToken;
} catch (error) {
  console.error('⚠️  Error loading Todoist credentials from mca-apps/todoist/auth.json');
  console.error(error);
  process.exit(1);
}

if (!API_TOKEN) {
  console.error('Error: apiToken not found in auth.json');
  process.exit(1);
}

const server = new Server(
  {
    name: 'todoist',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Helper function to make Todoist API requests
async function todoistRequest(
  endpoint: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  body?: any,
): Promise<any> {
  const url = `${BASE_URL}${endpoint}`;

  const options: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };

  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Todoist API error: ${response.status} ${response.statusText}\n${errorText}`);
  }

  // DELETE requests may return 204 No Content
  if (response.status === 204) {
    return { success: true };
  }

  return response.json();
}

const tools: Tool[] = [
  {
    name: 'todoist_list_projects',
    description: 'Get all projects',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'todoist_get_project',
    description: 'Get a single project by ID',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'The project ID',
        },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'todoist_create_project',
    description: 'Create a new project',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the project',
        },
        parentId: {
          type: 'string',
          description: 'Parent project ID to create a sub-project (optional)',
        },
        color: {
          type: 'string',
          description:
            'Color of the project (optional): berry_red, red, orange, yellow, olive_green, lime_green, green, mint_green, teal, sky_blue, light_blue, blue, grape, violet, lavender, magenta, salmon, charcoal, grey, taupe',
        },
        isFavorite: {
          type: 'boolean',
          description: 'Whether the project is a favorite (optional)',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'todoist_update_project',
    description: 'Update a project',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'The project ID',
        },
        name: {
          type: 'string',
          description: 'New name (optional)',
        },
        color: {
          type: 'string',
          description: 'New color (optional)',
        },
        isFavorite: {
          type: 'boolean',
          description: 'Whether the project is a favorite (optional)',
        },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'todoist_delete_project',
    description: 'Delete a project',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'The project ID to delete',
        },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'todoist_list_tasks',
    description: 'Get all active tasks (optionally filtered by project)',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Filter tasks by project ID (optional)',
        },
        filter: {
          type: 'string',
          description: "Filter expression (optional, e.g., 'today', 'overdue', 'p1')",
        },
      },
    },
  },
  {
    name: 'todoist_get_task',
    description: 'Get a single task by ID',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The task ID',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'todoist_create_task',
    description: 'Create a new task',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Task content (title)',
        },
        description: {
          type: 'string',
          description: 'Task description (optional)',
        },
        projectId: {
          type: 'string',
          description: 'Project ID (optional)',
        },
        dueString: {
          type: 'string',
          description:
            "Due date in natural language (optional, e.g., 'tomorrow at 12:00', 'every monday')",
        },
        dueDate: {
          type: 'string',
          description: 'Due date in YYYY-MM-DD format (optional)',
        },
        priority: {
          type: 'number',
          description: 'Priority from 1 (normal) to 4 (urgent) (optional)',
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of label names (optional)',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'todoist_update_task',
    description: 'Update a task',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The task ID',
        },
        content: {
          type: 'string',
          description: 'New task content (optional)',
        },
        description: {
          type: 'string',
          description: 'New task description (optional)',
        },
        dueString: {
          type: 'string',
          description: 'New due date in natural language (optional)',
        },
        dueDate: {
          type: 'string',
          description: 'New due date in YYYY-MM-DD format (optional)',
        },
        priority: {
          type: 'number',
          description: 'New priority from 1-4 (optional)',
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'New array of label names (optional)',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'todoist_close_task',
    description: 'Close (complete) a task',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The task ID to close',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'todoist_reopen_task',
    description: 'Reopen a completed task',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The task ID to reopen',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'todoist_delete_task',
    description: 'Delete a task',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The task ID to delete',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'todoist_list_labels',
    description: 'Get all labels',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'todoist_create_label',
    description: 'Create a new label',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the label',
        },
        color: {
          type: 'string',
          description:
            'Color of the label (optional): berry_red, red, orange, yellow, olive_green, lime_green, green, mint_green, teal, sky_blue, light_blue, blue, grape, violet, lavender, magenta, salmon, charcoal, grey, taupe',
        },
        isFavorite: {
          type: 'boolean',
          description: 'Whether the label is a favorite (optional)',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'todoist_update_label',
    description: 'Update a label',
    inputSchema: {
      type: 'object',
      properties: {
        labelId: {
          type: 'string',
          description: 'The label ID',
        },
        name: {
          type: 'string',
          description: 'New name (optional)',
        },
        color: {
          type: 'string',
          description: 'New color (optional)',
        },
        isFavorite: {
          type: 'boolean',
          description: 'Whether the label is a favorite (optional)',
        },
      },
      required: ['labelId'],
    },
  },
  {
    name: 'todoist_delete_label',
    description: 'Delete a label',
    inputSchema: {
      type: 'object',
      properties: {
        labelId: {
          type: 'string',
          description: 'The label ID to delete',
        },
      },
      required: ['labelId'],
    },
  },
  {
    name: 'todoist_list_comments',
    description: 'Get all comments for a task or project',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Task ID to get comments for (optional)',
        },
        projectId: {
          type: 'string',
          description: 'Project ID to get comments for (optional)',
        },
      },
    },
  },
  {
    name: 'todoist_create_comment',
    description: 'Create a comment on a task or project',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Task ID to comment on (optional)',
        },
        projectId: {
          type: 'string',
          description: 'Project ID to comment on (optional)',
        },
        content: {
          type: 'string',
          description: 'Comment content',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'todoist_list_sections',
    description: 'Get all sections (folders) in a project',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Project ID to get sections for (optional, returns all if not specified)',
        },
      },
    },
  },
  {
    name: 'todoist_get_section',
    description: 'Get a single section by ID',
    inputSchema: {
      type: 'object',
      properties: {
        sectionId: {
          type: 'string',
          description: 'The section ID',
        },
      },
      required: ['sectionId'],
    },
  },
  {
    name: 'todoist_create_section',
    description: 'Create a new section (folder) in a project',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the section',
        },
        projectId: {
          type: 'string',
          description: 'Project ID where the section will be created',
        },
        order: {
          type: 'number',
          description: 'Order of the section (optional)',
        },
      },
      required: ['name', 'projectId'],
    },
  },
  {
    name: 'todoist_update_section',
    description: 'Update a section name',
    inputSchema: {
      type: 'object',
      properties: {
        sectionId: {
          type: 'string',
          description: 'The section ID',
        },
        name: {
          type: 'string',
          description: 'New name for the section',
        },
      },
      required: ['sectionId', 'name'],
    },
  },
  {
    name: 'todoist_delete_section',
    description: 'Delete a section',
    inputSchema: {
      type: 'object',
      properties: {
        sectionId: {
          type: 'string',
          description: 'The section ID to delete',
        },
      },
      required: ['sectionId'],
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
      case 'todoist_list_projects': {
        const projects = await todoistRequest('/projects');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(projects, null, 2),
            },
          ],
        };
      }

      case 'todoist_get_project': {
        const project = await todoistRequest(`/projects/${args.projectId}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(project, null, 2),
            },
          ],
        };
      }

      case 'todoist_create_project': {
        const body: any = {
          name: args.name as string,
        };

        if (args.parentId) body.parent_id = args.parentId;
        if (args.color) body.color = args.color;
        if (args.isFavorite !== undefined) body.is_favorite = args.isFavorite;

        const project = await todoistRequest('/projects', 'POST', body);
        return {
          content: [
            {
              type: 'text',
              text: `Project created successfully!\n\n${JSON.stringify(project, null, 2)}`,
            },
          ],
        };
      }

      case 'todoist_update_project': {
        const body: any = {};

        if (args.name) body.name = args.name;
        if (args.color) body.color = args.color;
        if (args.isFavorite !== undefined) body.is_favorite = args.isFavorite;

        const project = await todoistRequest(`/projects/${args.projectId}`, 'POST', body);
        return {
          content: [
            {
              type: 'text',
              text: `Project updated successfully!\n\n${JSON.stringify(project, null, 2)}`,
            },
          ],
        };
      }

      case 'todoist_delete_project': {
        await todoistRequest(`/projects/${args.projectId}`, 'DELETE');
        return {
          content: [
            {
              type: 'text',
              text: 'Project deleted successfully!',
            },
          ],
        };
      }

      case 'todoist_list_tasks': {
        let endpoint = '/tasks';
        const params = new URLSearchParams();

        if (args.projectId) params.append('project_id', args.projectId as string);
        if (args.filter) params.append('filter', args.filter as string);

        if (params.toString()) {
          endpoint += `?${params.toString()}`;
        }

        const tasks = await todoistRequest(endpoint);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(tasks, null, 2),
            },
          ],
        };
      }

      case 'todoist_get_task': {
        const task = await todoistRequest(`/tasks/${args.taskId}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(task, null, 2),
            },
          ],
        };
      }

      case 'todoist_create_task': {
        const body: any = {
          content: args.content as string,
        };

        if (args.description) body.description = args.description;
        if (args.projectId) body.project_id = args.projectId;
        if (args.dueString) body.due_string = args.dueString;
        if (args.dueDate) body.due_date = args.dueDate;
        if (args.priority) body.priority = args.priority;
        if (args.labels) body.labels = args.labels;

        const task = await todoistRequest('/tasks', 'POST', body);
        return {
          content: [
            {
              type: 'text',
              text: `Task created successfully!\n\n${JSON.stringify(task, null, 2)}`,
            },
          ],
        };
      }

      case 'todoist_update_task': {
        const body: any = {};

        if (args.content) body.content = args.content;
        if (args.description) body.description = args.description;
        if (args.dueString) body.due_string = args.dueString;
        if (args.dueDate) body.due_date = args.dueDate;
        if (args.priority) body.priority = args.priority;
        if (args.labels) body.labels = args.labels;

        const task = await todoistRequest(`/tasks/${args.taskId}`, 'POST', body);
        return {
          content: [
            {
              type: 'text',
              text: `Task updated successfully!\n\n${JSON.stringify(task, null, 2)}`,
            },
          ],
        };
      }

      case 'todoist_close_task': {
        await todoistRequest(`/tasks/${args.taskId}/close`, 'POST');
        return {
          content: [
            {
              type: 'text',
              text: 'Task closed successfully!',
            },
          ],
        };
      }

      case 'todoist_reopen_task': {
        await todoistRequest(`/tasks/${args.taskId}/reopen`, 'POST');
        return {
          content: [
            {
              type: 'text',
              text: 'Task reopened successfully!',
            },
          ],
        };
      }

      case 'todoist_delete_task': {
        await todoistRequest(`/tasks/${args.taskId}`, 'DELETE');
        return {
          content: [
            {
              type: 'text',
              text: 'Task deleted successfully!',
            },
          ],
        };
      }

      case 'todoist_list_labels': {
        const labels = await todoistRequest('/labels');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(labels, null, 2),
            },
          ],
        };
      }

      case 'todoist_create_label': {
        const body: any = {
          name: args.name as string,
        };

        if (args.color) body.color = args.color;
        if (args.isFavorite !== undefined) body.is_favorite = args.isFavorite;

        const label = await todoistRequest('/labels', 'POST', body);
        return {
          content: [
            {
              type: 'text',
              text: `Label created successfully!\n\n${JSON.stringify(label, null, 2)}`,
            },
          ],
        };
      }

      case 'todoist_update_label': {
        const body: any = {};

        if (args.name) body.name = args.name;
        if (args.color) body.color = args.color;
        if (args.isFavorite !== undefined) body.is_favorite = args.isFavorite;

        const label = await todoistRequest(`/labels/${args.labelId}`, 'POST', body);
        return {
          content: [
            {
              type: 'text',
              text: `Label updated successfully!\n\n${JSON.stringify(label, null, 2)}`,
            },
          ],
        };
      }

      case 'todoist_delete_label': {
        await todoistRequest(`/labels/${args.labelId}`, 'DELETE');
        return {
          content: [
            {
              type: 'text',
              text: 'Label deleted successfully!',
            },
          ],
        };
      }

      case 'todoist_list_comments': {
        let endpoint = '/comments';
        const params = new URLSearchParams();

        if (args.taskId) params.append('task_id', args.taskId as string);
        if (args.projectId) params.append('project_id', args.projectId as string);

        if (params.toString()) {
          endpoint += `?${params.toString()}`;
        }

        const comments = await todoistRequest(endpoint);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(comments, null, 2),
            },
          ],
        };
      }

      case 'todoist_create_comment': {
        const body: any = {
          content: args.content as string,
        };

        if (args.taskId) body.task_id = args.taskId;
        if (args.projectId) body.project_id = args.projectId;

        const comment = await todoistRequest('/comments', 'POST', body);
        return {
          content: [
            {
              type: 'text',
              text: `Comment created successfully!\n\n${JSON.stringify(comment, null, 2)}`,
            },
          ],
        };
      }

      case 'todoist_list_sections': {
        let endpoint = '/sections';
        if (args.projectId) {
          endpoint += `?project_id=${args.projectId}`;
        }

        const sections = await todoistRequest(endpoint);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(sections, null, 2),
            },
          ],
        };
      }

      case 'todoist_get_section': {
        const section = await todoistRequest(`/sections/${args.sectionId}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(section, null, 2),
            },
          ],
        };
      }

      case 'todoist_create_section': {
        const body: any = {
          name: args.name as string,
          project_id: args.projectId as string,
        };

        if (args.order) body.order = args.order;

        const section = await todoistRequest('/sections', 'POST', body);
        return {
          content: [
            {
              type: 'text',
              text: `Section created successfully!\n\n${JSON.stringify(section, null, 2)}`,
            },
          ],
        };
      }

      case 'todoist_update_section': {
        const body: any = {
          name: args.name as string,
        };

        const section = await todoistRequest(`/sections/${args.sectionId}`, 'POST', body);
        return {
          content: [
            {
              type: 'text',
              text: `Section updated successfully!\n\n${JSON.stringify(section, null, 2)}`,
            },
          ],
        };
      }

      case 'todoist_delete_section': {
        await todoistRequest(`/sections/${args.sectionId}`, 'DELETE');
        return {
          content: [
            {
              type: 'text',
              text: 'Section deleted successfully!',
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Todoist MCP Server running on stdio');
}

runServer().catch(console.error);
