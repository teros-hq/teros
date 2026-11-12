/**
 * mca.teros.feedback-admin — admin feedback console.
 *
 * Thin client. This MCA no longer holds a MongoDB connection: every tool
 * forwards to a named backend action (`feedback-admin/<action>`) through the
 * authenticated callback, and the backend executes it against the shared
 * `feedback` collection (datastore-isolation P1b). The tool definitions —
 * names, parameters, result shapes — are unchanged, so the agent-facing
 * contract is identical to the former direct-Mongo implementation.
 */
import { McaServer, type HttpToolConfig as ToolConfig } from '@teros/mca-sdk';

/** Minimal structural view of the tool context we rely on. */
interface ActionContext {
  backend: { invokeAction<T = unknown>(actionPath: string, body?: Record<string, unknown>): Promise<T> } | null;
}

function actions(context: ActionContext) {
  const backend = context.backend;
  if (!backend) {
    throw new Error('feedback-admin requires the backend callback (no callbackUrl in execution context)');
  }
  return <T = unknown>(action: string, body: Record<string, unknown> = {}) =>
    backend.invokeAction<T>(`feedback-admin/${action}`, body);
}

// =============================================================================
// TOOLS
// =============================================================================

const listFeedback: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List all feedback reports from users. Filter by lifecycle view (tracking/future/dismissed/completed/all) or by exact type, status, priority, and user.',
  parameters: {
    type: 'object',
    properties: {
      view: {
        type: 'string',
        enum: ['all', 'tracking', 'future', 'dismissed', 'completed'],
        description:
          'Lifecycle view (optional): tracking = open/in_review/in_progress, future = postponed, dismissed, completed = resolved. Wins over status.',
      },
      type: { type: 'string', enum: ['bug', 'suggestion'], description: 'Filter by type (optional)' },
      status: {
        type: 'string',
        enum: ['open', 'in_review', 'in_progress', 'postponed', 'resolved', 'dismissed'],
        description: 'Filter by exact status (optional)',
      },
      priority: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'critical'],
        description: 'Filter by priority (optional)',
      },
      userId: { type: 'string', description: 'Filter by user ID (optional)' },
      limit: { type: 'number', description: 'Maximum number of results (default: 50)' },
    },
  },
  handler: async (args, context) => actions(context as ActionContext)('list', args as Record<string, unknown>),
};

const getFeedback: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get full details of a specific feedback report',
  parameters: {
    type: 'object',
    properties: { feedbackId: { type: 'string', description: 'The feedback ID (e.g., fb_xxx)' } },
    required: ['feedbackId'],
  },
  handler: async (args, context) => actions(context as ActionContext)('get', args as Record<string, unknown>),
};

const createFeedback: ToolConfig = {
  annotations: { readOnlyHint: false, safeWriteHint: true },
  description:
    'Register a bug report or suggestion that arrived OUTSIDE the feedback tool — e.g. mentioned in a conversation, an email, or word of mouth — so that triage has ONE inbox. Use source to record where it came from.',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['bug', 'suggestion'], description: 'Report type' },
      title: { type: 'string', description: 'Short summary' },
      description: { type: 'string', description: 'Detailed description, steps to reproduce, context' },
      severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Severity (optional)' },
      reportedBy: { type: 'string', description: 'User ID of the person who reported it (or a placeholder like user_external)' },
      reportedByName: { type: 'string', description: 'Display name of the reporter (e.g. "Álvaro")' },
      source: {
        type: 'string',
        enum: ['conversation', 'email', 'manual'],
        description: 'Where the report came from (default: manual)',
      },
    },
    required: ['type', 'title', 'description', 'reportedBy'],
  },
  handler: async (args, context) => actions(context as ActionContext)('create', args as Record<string, unknown>),
};

const updateStatus: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    "Update the status of a feedback report. Dismissing REQUIRES a dismissReason ('wont_fix' = valid but we won't do it, 'invalid' = not a real bug). Resolving emails the reporter unless notifyReporter is false.",
  parameters: {
    type: 'object',
    properties: {
      feedbackId: { type: 'string', description: 'The feedback ID' },
      status: {
        type: 'string',
        enum: ['open', 'in_review', 'in_progress', 'postponed', 'resolved', 'dismissed'],
        description:
          'New status. postponed parks it on the Future list; resolved marks it Completed and emails the reporter.',
      },
      dismissReason: {
        type: 'string',
        enum: ['wont_fix', 'invalid'],
        description: "Required when status is 'dismissed': wont_fix (product decision) or invalid (not a real bug)",
      },
      notifyReporter: {
        type: 'boolean',
        description: 'When resolving: email the reporter that their item is done (default true)',
      },
      message: {
        type: 'string',
        description: 'Optional message to include with the status change (will be visible to user)',
      },
    },
    required: ['feedbackId', 'status'],
  },
  handler: async (args, context) =>
    actions(context as ActionContext)('update-status', args as Record<string, unknown>),
};

const setPriority: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Set or update the priority of a feedback report',
  parameters: {
    type: 'object',
    properties: {
      feedbackId: { type: 'string', description: 'The feedback ID' },
      priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Priority level' },
    },
    required: ['feedbackId', 'priority'],
  },
  handler: async (args, context) =>
    actions(context as ActionContext)('set-priority', args as Record<string, unknown>),
};

const addUpdate: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Add an update or comment to a feedback report. This will be visible to the user who submitted it.',
  parameters: {
    type: 'object',
    properties: {
      feedbackId: { type: 'string', description: 'The feedback ID' },
      message: { type: 'string', description: 'The update message for the user' },
    },
    required: ['feedbackId', 'message'],
  },
  handler: async (args, context) => actions(context as ActionContext)('add-update', args as Record<string, unknown>),
};

const getStats: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get overall feedback statistics',
  parameters: { type: 'object', properties: {} },
  handler: async (_args, context) => actions(context as ActionContext)('stats'),
};

// =============================================================================
// SERVER
// =============================================================================

const server = new McaServer({ name: 'feedback-admin', version: '1.1.0' });

server.tool('list-feedback', listFeedback);
server.tool('get-feedback', getFeedback);
server.tool('create-feedback', createFeedback);
server.tool('update-status', updateStatus);
server.tool('set-priority', setPriority);
server.tool('add-update', addUpdate);
server.tool('get-stats', getStats);

server.start().catch(console.error);
