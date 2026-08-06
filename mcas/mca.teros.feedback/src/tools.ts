import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';

const RAW_BACKEND_URL = process.env.MCA_BACKEND_URL || 'http://localhost:3000';
const FEEDBACK_TOKEN = process.env.SECRET_MCA_FEEDBACK_API_TOKEN;

// When running inside a Docker container, localhost points to the container itself.
// Replace with host.docker.internal to reach the host machine where the backend runs.
const BACKEND_URL = RAW_BACKEND_URL.replace(/localhost|127\.0\.0\.1/, 'host.docker.internal');

interface FeedbackSubmitBody {
  type: 'bug' | 'suggestion';
  title: string;
  description: string;
  severity?: string;
  reportedBy: string;
  reportedByName?: string;
  reportedByAvatarUrl?: string;
  agentId?: string;
}

export async function submitFeedback(body: FeedbackSubmitBody) {
  const res = await fetch(`${BACKEND_URL}/api/feedback/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Feedback-Token': FEEDBACK_TOKEN || '',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({ error: 'Invalid JSON response' }));

  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  return data;
}

// =============================================================================
// TOOLS
// =============================================================================

export const reportBug: ToolConfig = {
  annotations: { readOnlyHint: false },
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

    const result = await submitFeedback({
      type: 'bug',
      title,
      description,
      severity,
      reportedBy: context.execution.userId,
      reportedByName: context.execution.userDisplayName,
      reportedByAvatarUrl: context.execution.userAvatarUrl,
      agentId: context.execution.agentId,
    });

    return {
      success: true,
      feedbackId: result.feedbackId,
      message: `Bug report submitted successfully. You can track its status with ID: ${result.feedbackId}`,
    };
  },
};

export const reportSuggestion: ToolConfig = {
  annotations: { readOnlyHint: false },
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

    const result = await submitFeedback({
      type: 'suggestion',
      title,
      description,
      reportedBy: context.execution.userId,
      reportedByName: context.execution.userDisplayName,
      reportedByAvatarUrl: context.execution.userAvatarUrl,
      agentId: context.execution.agentId,
    });

    return {
      success: true,
      feedbackId: result.feedbackId,
      message: `Suggestion submitted successfully. You can track its status with ID: ${result.feedbackId}`,
    };
  },
};
