#!/usr/bin/env npx tsx

/**
 * Replicate MCA
 *
 * Run any AI model on Replicate.
 *
 * All predictions are ALWAYS asynchronous. Use replicate-get-prediction
 * to poll for results, and replicate-cancel-prediction to cancel.
 *
 * Workflow:
 *   1. replicate-list-models  → discover models and their input schemas
 *   2. replicate-run          → start a prediction (always async)
 *   3. replicate-get-prediction → poll until status is "succeeded" or "failed"
 *   4. replicate-cancel-prediction → cancel if needed
 *   5. replicate-list-predictions → see all recent predictions
 *
 * Uses @teros/mca-sdk McaServer with HTTP transport.
 * Secrets are fetched on-demand from the backend via callbackUrl.
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';

// =============================================================================
// CONFIGURATION
// =============================================================================

const REPLICATE_API_URL = 'https://api.replicate.com/v1';

// =============================================================================
// REPLICATE API HELPERS
// =============================================================================

async function replicateRequest(
  endpoint: string,
  apiToken: string,
  options: RequestInit = {},
): Promise<Response> {
  return fetch(`${REPLICATE_API_URL}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Token ${apiToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
}

function getApiToken(secrets: Record<string, string>): string | null {
  return secrets.apiToken || secrets.API_TOKEN || secrets.api_token || null;
}

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.replicate',
  name: 'Replicate',
  version: '2.0.0',
});

// -----------------------------------------------------------------------------
// Health Check
// -----------------------------------------------------------------------------

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies Replicate API token and connectivity.',
  parameters: { type: 'object', properties: {} },
  handler: async (args, context) => {
    const builder = new HealthCheckBuilder().setVersion('2.0.0');
    try {
      const secrets = await context.getSystemSecrets();
      const apiToken = getApiToken(secrets);
      if (!apiToken) {
        builder.addIssue('SYSTEM_CONFIG_MISSING', 'Replicate API token not configured', {
          type: 'admin_action',
          description: 'Configure the API_TOKEN in system secrets',
        });
      }
    } catch (error) {
      builder.addIssue(
        'SYSTEM_CONFIG_MISSING',
        error instanceof Error ? error.message : 'Failed to get secrets',
        { type: 'admin_action', description: 'Ensure callbackUrl is provided and backend is reachable' },
      );
    }
    return builder.build();
  },
});

// -----------------------------------------------------------------------------
// replicate-list-models
// -----------------------------------------------------------------------------

server.tool('replicate-list-models', {
  description:
    'Discover models available on Replicate and their exact input parameters. ' +
    'Three modes: ' +
    '(1) collection: list models in a category (e.g. "video-generation", "image-to-video", "text-to-image", "image-to-image", "audio-generation"). ' +
    '(2) query: search models by name or description. ' +
    '(3) model: get the full input/output schema for a specific model in "owner/name" format (e.g. "google/veo-3.1") — use this before replicate-run to know exactly what parameters to pass.',
  parameters: {
    type: 'object',
    properties: {
      collection: {
        type: 'string',
        description:
          'Collection slug to browse. Examples: "video-generation", "image-to-video", "text-to-image", "image-to-image", "audio-generation".',
      },
      query: {
        type: 'string',
        description: 'Free-text search query to find models by name or description.',
      },
      model: {
        type: 'string',
        description:
          'Get the full schema for a specific model in "owner/name" format (e.g. "google/veo-3.1", "runwayml/gen-4.5", "kwaivgi/kling-v2.6"). Returns all input parameters with types, defaults and descriptions.',
      },
    },
  },
  handler: async (args, context) => {
    const secrets = await context.getSystemSecrets();
    const apiToken = getApiToken(secrets);
    if (!apiToken) throw new Error('Replicate API token not configured');

    // Mode 1: full schema for a specific model
    if (args.model) {
      const [owner, name] = (args.model as string).split('/');
      if (!owner || !name) throw new Error('model must be in "owner/name" format');

      const response = await replicateRequest(`/models/${owner}/${name}`, apiToken);
      if (!response.ok) throw new Error(`API error: ${response.status} ${await response.text()}`);
      const data = await response.json();

      const schema =
        data.latest_version?.openapi_schema?.components?.schemas?.Input || null;

      return {
        id: `${data.owner}/${data.name}`,
        description: data.description,
        url: data.url,
        run_count: data.run_count,
        latest_version: data.latest_version?.id || null,
        input_schema: schema,
      };
    }

    // Mode 2: browse a collection
    if (args.collection) {
      const response = await replicateRequest(`/collections/${args.collection}`, apiToken);
      if (!response.ok) throw new Error(`API error: ${response.status} ${await response.text()}`);
      const data = await response.json();

      return {
        collection: args.collection,
        description: data.description,
        models: (data.models || []).map((m: any) => ({
          id: `${m.owner}/${m.name}`,
          description: m.description,
          run_count: m.run_count,
          url: m.url,
        })),
      };
    }

    // Mode 3: search by query
    if (args.query) {
      const params = new URLSearchParams({ q: args.query as string });
      const response = await replicateRequest(`/models?${params}`, apiToken);
      if (!response.ok) throw new Error(`API error: ${response.status} ${await response.text()}`);
      const data = await response.json();

      return (data.results || []).map((m: any) => ({
        id: `${m.owner}/${m.name}`,
        description: m.description,
        run_count: m.run_count,
        url: m.url,
      }));
    }

    throw new Error('Provide at least one of: collection, query, or model');
  },
});

// -----------------------------------------------------------------------------
// replicate-run (always async)
// -----------------------------------------------------------------------------

server.tool('replicate-run', {
  description:
    'Run any model on Replicate. ALWAYS asynchronous — returns immediately with a prediction ID and status "starting". ' +
    'Then use replicate-get-prediction to poll until done. ' +
    'Use replicate-list-models first to discover the model ID and its exact input parameters.',
  parameters: {
    type: 'object',
    properties: {
      model: {
        type: 'string',
        description:
          'Model in "owner/name" format (e.g. "google/veo-3.1", "runwayml/gen-4.5", "kwaivgi/kling-v2.6", "black-forest-labs/flux-kontext-pro"). Use replicate-list-models to find available models.',
      },
      input: {
        type: 'object',
        description:
          'Input parameters for the model. Use replicate-list-models with the model field to get the exact schema.',
      },
    },
    required: ['model', 'input'],
  },
  handler: async (args, context) => {
    const secrets = await context.getSystemSecrets();
    const apiToken = getApiToken(secrets);
    if (!apiToken) throw new Error('Replicate API token not configured');

    const model = args.model as string;
    const hasVersion = model.includes(':');
    let response: Response;

    if (hasVersion) {
      const [, version] = model.split(':');
      response = await replicateRequest('/predictions', apiToken, {
        method: 'POST',
        body: JSON.stringify({ version, input: args.input }),
      });
    } else {
      response = await replicateRequest(`/models/${model}/predictions`, apiToken, {
        method: 'POST',
        body: JSON.stringify({ input: args.input }),
      });
    }

    if (!response.ok) throw new Error(`API error: ${response.status} ${await response.text()}`);
    return await response.json();
  },
});

// -----------------------------------------------------------------------------
// replicate-get-prediction
// -----------------------------------------------------------------------------

server.tool('replicate-get-prediction', {
  description:
    'Get the status and result of a prediction by ID. ' +
    'Poll this after replicate-run until status is "succeeded" or "failed". ' +
    'When succeeded, the output field contains the result (image URL, video URL, etc.).',
  parameters: {
    type: 'object',
    properties: {
      predictionId: { type: 'string', description: 'The prediction ID returned by replicate-run' },
    },
    required: ['predictionId'],
  },
  handler: async (args, context) => {
    const secrets = await context.getSystemSecrets();
    const apiToken = getApiToken(secrets);
    if (!apiToken) throw new Error('Replicate API token not configured');

    const response = await replicateRequest(`/predictions/${args.predictionId}`, apiToken);
    if (!response.ok) throw new Error(`API error: ${response.status} ${await response.text()}`);
    return await response.json();
  },
});

// -----------------------------------------------------------------------------
// replicate-cancel-prediction
// -----------------------------------------------------------------------------

server.tool('replicate-cancel-prediction', {
  description: 'Cancel a running or queued prediction by ID.',
  parameters: {
    type: 'object',
    properties: {
      predictionId: { type: 'string', description: 'The prediction ID to cancel' },
    },
    required: ['predictionId'],
  },
  handler: async (args, context) => {
    const secrets = await context.getSystemSecrets();
    const apiToken = getApiToken(secrets);
    if (!apiToken) throw new Error('Replicate API token not configured');

    const response = await replicateRequest(
      `/predictions/${args.predictionId}/cancel`,
      apiToken,
      { method: 'POST' },
    );
    if (!response.ok) throw new Error(`API error: ${response.status} ${await response.text()}`);
    return await response.json();
  },
});

// -----------------------------------------------------------------------------
// replicate-list-predictions
// -----------------------------------------------------------------------------

server.tool('replicate-list-predictions', {
  description:
    'List recent predictions with their status. Useful to track ongoing or past generations.',
  parameters: { type: 'object', properties: {} },
  handler: async (args, context) => {
    const secrets = await context.getSystemSecrets();
    const apiToken = getApiToken(secrets);
    if (!apiToken) throw new Error('Replicate API token not configured');

    const response = await replicateRequest('/predictions', apiToken);
    if (!response.ok) throw new Error(`API error: ${response.status} ${await response.text()}`);
    const data = await response.json();

    return (data.results || []).map((p: any) => ({
      id: p.id,
      model: p.model,
      status: p.status,
      created_at: p.created_at,
      completed_at: p.completed_at || null,
      error: p.error || null,
      output: p.output || null,
    }));
  },
});

// =============================================================================
// START SERVER
// =============================================================================

server
  .start()
  .then(() => {
    console.error('🎨 Replicate MCA server running (v2.0.0 - fully async, model-agnostic)');
  })
  .catch((error) => {
    console.error('Failed to start Replicate MCA:', error);
    process.exit(1);
  });
