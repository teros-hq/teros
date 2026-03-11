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

const reportBug: ToolConfig = {
  description: 'Report a bug or technical issue with the platform',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Short summary of the bug',
      },
      description: {
        type: 'string',
        description: 'Detailed description, steps to reproduce, expected vs actual behavior',
      },
      severity: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'critical'],
        description: 'How severe is this bug? (optional)',
      },
    },
    required: ['title', 'description'],
  },
  handler: async (args, context) => {
    const { title, description, severity } = args as {
      title: string;
      description: string;
      severity?: 'low' | 'medium' | 'high' | 'critical';
    };

    const database = await getDb();
    const collection = database.collection<Feedback>('feedback');

    const feedback: Feedback = {
      feedbackId: generateId('fb'),
      type: 'bug',
      title,
      description,
      severity,
      reportedBy: context.userId!,
      reportedByName: context.userDisplayName,
      reportedByAvatarUrl: context.userAvatarUrl,
      agentId: context.agentId,
      status: 'open',
      updates: [],
      hasUnreadUpdates: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await collection.insertOne(feedback);

    return {
      success: true,
      feedbackId: feedback.feedbackId,
      message: `Bug report submitted successfully. You can track its status with ID: ${feedback.feedbackId}`,
    };
  },
};

const reportSuggestion: ToolConfig = {
  description: 'Submit a suggestion or feature request to improve the platform',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Your idea in one sentence',
      },
      description: {
        type: 'string',
        description: 'Detailed description of your suggestion',
      },
    },
    required: ['title', 'description'],
  },
  handler: async (args, context) => {
    const { title, description } = args as {
      title: string;
      description: string;
    };

    const database = await getDb();
    const collection = database.collection<Feedback>('feedback');

    const feedback: Feedback = {
      feedbackId: generateId('fb'),
      type: 'suggestion',
      title,
      description,
      reportedBy: context.userId!,
      reportedByName: context.userDisplayName,
      reportedByAvatarUrl: context.userAvatarUrl,
      agentId: context.agentId,
      status: 'open',
      updates: [],
      hasUnreadUpdates: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await collection.insertOne(feedback);

    return {
      success: true,
      feedbackId: feedback.feedbackId,
      message: `Suggestion submitted successfully. You can track its status with ID: ${feedback.feedbackId}`,
    };
  },
};

const listMyFeedback: ToolConfig = {
  description: 'List all bug reports and suggestions you have submitted',
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
    },
  },
  handler: async (args, context) => {
    const { type, status } = args as {
      type?: 'bug' | 'suggestion';
      status?: string;
    };

    const database = await getDb();
    const collection = database.collection<Feedback>('feedback');

    const query: any = { reportedBy: context.userId };
    if (type) query.type = type;
    if (status) query.status = status;

    const feedbacks = await collection.find(query).sort({ createdAt: -1 }).limit(50).toArray();

    const unreadCount = feedbacks.filter((f) => f.hasUnreadUpdates).length;

    return {
      count: feedbacks.length,
      unreadUpdates: unreadCount,
      feedbacks: feedbacks.map((f) => ({
        feedbackId: f.feedbackId,
        type: f.type,
        title: f.title,
        status: f.status,
        hasUnreadUpdates: f.hasUnreadUpdates,
        updatesCount: f.updates.length,
        createdAt: f.createdAt,
      })),
    };
  },
};

const getFeedback: ToolConfig = {
  description: 'Get details of a specific feedback report including updates from the team',
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
  handler: async (args, context) => {
    const { feedbackId } = args as { feedbackId: string };

    const database = await getDb();
    const collection = database.collection<Feedback>('feedback');

    const feedback = await collection.findOne({
      feedbackId,
      reportedBy: context.userId,
    });

    if (!feedback) {
      return { error: "Feedback not found or you don't have access to it" };
    }

    // Mark as read
    if (feedback.hasUnreadUpdates) {
      await collection.updateOne(
        { feedbackId },
        {
          $set: {
            hasUnreadUpdates: false,
            lastReadAt: new Date().toISOString(),
          },
        },
      );
    }

    return {
      feedbackId: feedback.feedbackId,
      type: feedback.type,
      title: feedback.title,
      description: feedback.description,
      severity: feedback.severity,
      status: feedback.status,
      priority: feedback.priority,
      updates: feedback.updates,
      createdAt: feedback.createdAt,
      updatedAt: feedback.updatedAt,
      resolvedAt: feedback.resolvedAt,
    };
  },
};

// =============================================================================
// SERVER
// =============================================================================

const server = new McaServer({
  name: 'feedback',
  version: '1.0.0',
});

server.tool('report-bug', reportBug);
server.tool('report-suggestion', reportSuggestion);
server.tool('list-my-feedback', listMyFeedback);
server.tool('get-feedback', getFeedback);

server.start().catch(console.error);
