#!/usr/bin/env npx tsx

/**
 * Perplexity AI MCA
 *
 * AI-powered web search with real-time information using Perplexity API.
 * Provides comprehensive answers with sources.
 *
 * Uses @teros/mca-sdk McaServer with HTTP transport.
 * Secrets are fetched on-demand from the backend via callbackUrl.
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';

// =============================================================================
// CONFIGURATION
// =============================================================================

const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';

// =============================================================================
// PERPLEXITY API
// =============================================================================

interface PerplexityMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface PerplexityResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  citations?: string[];
}

async function callPerplexityAPI(
  apiKey: string,
  messages: PerplexityMessage[],
  model: string = 'sonar',
): Promise<{ answer: string; citations: string[] }> {
  const response = await fetch(PERPLEXITY_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Perplexity API error: ${response.status} - ${error}`);
  }

  const data: PerplexityResponse = await response.json();
  const answer = data.choices[0].message.content;
  const citations = data.citations || [];

  return { answer, citations };
}

function formatResultWithSources(answer: string, citations: string[]): string {
  let result = answer;
  if (citations.length > 0) {
    result += '\n\n**Sources:**\n' + citations.map((url, i) => `${i + 1}. ${url}`).join('\n');
  }
  return result;
}

/**
 * Get API key from secrets (tries multiple key names)
 */
function getApiKey(secrets: Record<string, string>): string | null {
  return secrets.apiKey || null;
}

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.perplexity',
  name: 'Perplexity AI',
  version: '1.1.0',
});

// -----------------------------------------------------------------------------
// Health Check Tool
// -----------------------------------------------------------------------------

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies Perplexity API key and connectivity.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.1.0');

    // Try to get secrets - will fail if no callbackUrl
    try {
      const secrets = await context.getSystemSecrets();
      const apiKey = getApiKey(secrets);

      if (!apiKey) {
        builder.addIssue('SYSTEM_CONFIG_MISSING', 'Perplexity API key not configured', {
          type: 'admin_action',
          description: 'Configure the APIKEY in system secrets',
        });
      }
    } catch (error) {
      builder.addIssue(
        'SYSTEM_CONFIG_MISSING',
        error instanceof Error ? error.message : 'Failed to get secrets',
        {
          type: 'admin_action',
          description: 'Ensure callbackUrl is provided and backend is reachable',
        },
      );
    }

    return builder.build();
  },
});

// -----------------------------------------------------------------------------
// Search Tool
// -----------------------------------------------------------------------------

server.tool('perplexity-search', {
  description:
    'Search the web using Perplexity AI with real-time information. Returns comprehensive answers with sources.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query or question to ask Perplexity AI',
      },
      model: {
        type: 'string',
        description: 'Model to use (default: sonar)',
        enum: ['sonar', 'sonar-pro', 'sonar-reasoning'],
        default: 'sonar',
      },
    },
    required: ['query'],
  },
  handler: async (args, context) => {
    const query = args.query as string;
    const model = (args.model as string) || 'sonar';

    if (!query) {
      throw new Error('query is required');
    }

    // Get API key from backend
    const secrets = await context.getSystemSecrets();
    const apiKey = getApiKey(secrets);

    if (!apiKey) {
      throw new Error(
        'Perplexity API key not configured. Please configure APIKEY in system secrets.',
      );
    }

    const { answer, citations } = await callPerplexityAPI(
      apiKey,
      [{ role: 'user', content: query }],
      model,
    );

    return formatResultWithSources(answer, citations);
  },
});

// -----------------------------------------------------------------------------
// Chat Tool
// -----------------------------------------------------------------------------

server.tool('perplexity-chat', {
  description:
    'Have a multi-turn conversation with Perplexity AI. Can maintain context across messages.',
  parameters: {
    type: 'object',
    properties: {
      messages: {
        type: 'array',
        description: 'Array of message objects with role (system/user/assistant) and content',
        items: {
          type: 'object',
          properties: {
            role: {
              type: 'string',
              enum: ['system', 'user', 'assistant'],
            },
            content: {
              type: 'string',
            },
          },
          required: ['role', 'content'],
        },
      },
      model: {
        type: 'string',
        description: 'Model to use (default: sonar)',
        enum: ['sonar', 'sonar-pro', 'sonar-reasoning'],
        default: 'sonar',
      },
    },
    required: ['messages'],
  },
  handler: async (args, context) => {
    const messages = args.messages as PerplexityMessage[];
    const model = (args.model as string) || 'sonar';

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      throw new Error('messages array is required and must not be empty');
    }

    // Get API key from backend
    const secrets = await context.getSystemSecrets();
    const apiKey = getApiKey(secrets);

    if (!apiKey) {
      throw new Error(
        'Perplexity API key not configured. Please configure APIKEY in system secrets.',
      );
    }

    const { answer, citations } = await callPerplexityAPI(apiKey, messages, model);
    return formatResultWithSources(answer, citations);
  },
});

// =============================================================================
// START SERVER
// =============================================================================

server
  .start()
  .then(() => {
    console.error('🔍 Perplexity MCA server running');
  })
  .catch((error) => {
    console.error('Failed to start Perplexity MCA:', error);
    process.exit(1);
  });
