import { McaServer, type HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { type Db, MongoClient } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const MONGODB_DATABASE = process.env.MONGODB_DATABASE || 'teros';

interface FeedbackUpdate {
  updateId: string;
  message: string;
  newStatus?: string;
  createdAt: string;
  createdBy: string;
}

interface Feedback {
  feedbackId: string;
  type: 'bug' | 'suggestion';
  title: string;
  description: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  reportedBy: string;
  reportedByName?: string;
  reportedByAvatarUrl?: string;
  agentId?: string;
  status: 'open' | 'in_review' | 'in_progress' | 'resolved' | 'dismissed';
  priority?: 'low' | 'medium' | 'high' | 'critical';
  updates: FeedbackUpdate[];
  hasUnreadUpdates: boolean;
  lastReadAt?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

function generateId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).substring(2, 15)}`;
}

let db: Db;

async function getDb(): Promise<Db> {
  if (!db) {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(MONGODB_DATABASE);
  }
  return db;
}

// =============================================================================
// TOOLS
// =============================================================================

const listFeedback: ToolConfig = {
  description:
    'List all feedback reports from users. Supports filtering by type, status, priority, and user.',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['bug', 'suggestion'],
        description: 'Filter by type (optional)',
      },
      status: {
        type: 'string',
        enum: ['open', 'in_review', 'in_progress', 'resolved', 'dismissed'],
        description: 'Filter by status (optional)',
      },
      priority: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'critical'],
        description: 'Filter by priority (optional)',
      },
      userId: {
        type: 'string',
        description: 'Filter by user ID (optional)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results (default: 50)',
      },
    },
  },
  handler: async (args) => {
    const {
      type,
      status,
      priority,
      userId,
      limit = 50,
    } = args as {
      type?: string;
      status?: string;
      priority?: string;
      userId?: string;
      limit?: number;
    };

    const database = await getDb();
    const collection = database.collection<Feedback>('feedback');

    const query: any = {};
    if (type) query.type = type;
    if (status) query.status = status;
    if (priority) query.priority = priority;
    if (userId) query.reportedBy = userId;

    const feedbacks = await collection.find(query).sort({ createdAt: -1 }).limit(limit).toArray();

    const stats = {
      total: feedbacks.length,
      byStatus: {
        open: feedbacks.filter((f) => f.status === 'open').length,
        in_review: feedbacks.filter((f) => f.status === 'in_review').length,
        in_progress: feedbacks.filter((f) => f.status === 'in_progress').length,
        resolved: feedbacks.filter((f) => f.status === 'resolved').length,
        dismissed: feedbacks.filter((f) => f.status === 'dismissed').length,
      },
      byType: {
        bug: feedbacks.filter((f) => f.type === 'bug').length,
        suggestion: feedbacks.filter((f) => f.type === 'suggestion').length,
      },
    };

    return {
      stats,
      feedbacks: feedbacks.map((f) => ({
        feedbackId: f.feedbackId,
        type: f.type,
        title: f.title,
        status: f.status,
        priority: f.priority,
        severity: f.severity,
        reportedBy: f.reportedBy,
        reportedByName: f.reportedByName,
        reportedByAvatarUrl: f.reportedByAvatarUrl,
        updatesCount: f.updates.length,
        createdAt: f.createdAt,
      })),
    };
  },
};

const getFeedback: ToolConfig = {
  description: 'Get full details of a specific feedback report',
  parameters: {
    type: 'object',
    properties: {
      feedbackId: {
        type: 'string',
        description: 'The feedback ID (e.g., fb_xxx)',
      },
    },
    required: ['feedbackId'],
  },
  handler: async (args) => {
    const { feedbackId } = args as { feedbackId: string };

    const database = await getDb();
    const collection = database.collection<Feedback>('feedback');

    const feedback = await collection.findOne({ feedbackId });

    if (!feedback) {
      return { error: 'Feedback not found' };
    }

    return feedback;
  },
};

const updateStatus: ToolConfig = {
  description: 'Update the status of a feedback report',
  parameters: {
    type: 'object',
    properties: {
      feedbackId: {
        type: 'string',
        description: 'The feedback ID',
      },
      status: {
        type: 'string',
        enum: ['open', 'in_review', 'in_progress', 'resolved', 'dismissed'],
        description: 'New status',
      },
      message: {
        type: 'string',
        description: 'Optional message to include with the status change (will be visible to user)',
      },
    },
    required: ['feedbackId', 'status'],
  },
  handler: async (args, context) => {
    const { feedbackId, status, message } = args as {
      feedbackId: string;
      status: string;
      message?: string;
    };

    const database = await getDb();
    const collection = database.collection<Feedback>('feedback');

    const feedback = await collection.findOne({ feedbackId });
    if (!feedback) {
      return { error: 'Feedback not found' };
    }

    const updateData: any = {
      status,
      updatedAt: new Date().toISOString(),
      hasUnreadUpdates: true,
    };

    if (status === 'resolved' || status === 'dismissed') {
      updateData.resolvedAt = new Date().toISOString();
    }

    const update: FeedbackUpdate = {
      updateId: generateId('upd'),
      message: message || `Status changed to ${status}`,
      newStatus: status,
      createdAt: new Date().toISOString(),
      createdBy: context.userId!,
    };

    await collection.updateOne(
      { feedbackId },
      {
        $set: updateData,
        $push: { updates: update },
      },
    );

    return {
      success: true,
      feedbackId,
      newStatus: status,
      message: `Status updated to ${status}`,
    };
  },
};

const setPriority: ToolConfig = {
  description: 'Set or update the priority of a feedback report',
  parameters: {
    type: 'object',
    properties: {
      feedbackId: {
        type: 'string',
        description: 'The feedback ID',
      },
      priority: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'critical'],
        description: 'Priority level',
      },
    },
    required: ['feedbackId', 'priority'],
  },
  handler: async (args) => {
    const { feedbackId, priority } = args as {
      feedbackId: string;
      priority: string;
    };

    const database = await getDb();
    const collection = database.collection<Feedback>('feedback');

    const result = await collection.updateOne(
      { feedbackId },
      {
        $set: {
          priority,
          updatedAt: new Date().toISOString(),
        },
      },
    );

    if (result.matchedCount === 0) {
      return { error: 'Feedback not found' };
    }

    return {
      success: true,
      feedbackId,
      priority,
    };
  },
};

const addUpdate: ToolConfig = {
  description:
    'Add an update or comment to a feedback report. This will be visible to the user who submitted it.',
  parameters: {
    type: 'object',
    properties: {
      feedbackId: {
        type: 'string',
        description: 'The feedback ID',
      },
      message: {
        type: 'string',
        description: 'The update message for the user',
      },
    },
    required: ['feedbackId', 'message'],
  },
  handler: async (args, context) => {
    const { feedbackId, message } = args as {
      feedbackId: string;
      message: string;
    };

    const database = await getDb();
    const collection = database.collection<Feedback>('feedback');

    const feedback = await collection.findOne({ feedbackId });
    if (!feedback) {
      return { error: 'Feedback not found' };
    }

    const update: FeedbackUpdate = {
      updateId: generateId('upd'),
      message,
      createdAt: new Date().toISOString(),
      createdBy: context.userId!,
    };

    await collection.updateOne(
      { feedbackId },
      {
        $set: {
          updatedAt: new Date().toISOString(),
          hasUnreadUpdates: true,
        },
        $push: { updates: update },
      },
    );

    return {
      success: true,
      feedbackId,
      updateId: update.updateId,
      message: 'Update added successfully. The user will see this when they check their feedback.',
    };
  },
};

const getStats: ToolConfig = {
  description: 'Get overall feedback statistics',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    const database = await getDb();
    const collection = database.collection<Feedback>('feedback');

    const all = await collection.find({}).toArray();

    const now = new Date();
    const last7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const last30Days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const recentWeek = all.filter((f) => new Date(f.createdAt) >= last7Days);
    const recentMonth = all.filter((f) => new Date(f.createdAt) >= last30Days);

    return {
      total: all.length,
      byStatus: {
        open: all.filter((f) => f.status === 'open').length,
        in_review: all.filter((f) => f.status === 'in_review').length,
        in_progress: all.filter((f) => f.status === 'in_progress').length,
        resolved: all.filter((f) => f.status === 'resolved').length,
        dismissed: all.filter((f) => f.status === 'dismissed').length,
      },
      byType: {
        bug: all.filter((f) => f.type === 'bug').length,
        suggestion: all.filter((f) => f.type === 'suggestion').length,
      },
      byPriority: {
        critical: all.filter((f) => f.priority === 'critical').length,
        high: all.filter((f) => f.priority === 'high').length,
        medium: all.filter((f) => f.priority === 'medium').length,
        low: all.filter((f) => f.priority === 'low').length,
        unset: all.filter((f) => !f.priority).length,
      },
      last7Days: recentWeek.length,
      last30Days: recentMonth.length,
    };
  },
};

// =============================================================================
// SERVER
// =============================================================================

const server = new McaServer({
  name: 'feedback-admin',
  version: '1.0.0',
});

server.tool('list-feedback', listFeedback);
server.tool('get-feedback', getFeedback);
server.tool('update-status', updateStatus);
server.tool('set-priority', setPriority);
server.tool('add-update', addUpdate);
server.tool('get-stats', getStats);

server.start().catch(console.error);
