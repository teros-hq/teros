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
 * Generated media (images, videos, audio) is persisted to ctx.objects
 * (internal blob store) and served via permanent internal URLs.
 * The agent never sees Replicate's temporary URLs.
 *
 * Uses @teros/mca-sdk McaServer with HTTP transport.
 * Secrets are fetched on-demand from the backend via callbackUrl.
 */

import {
  HealthCheckBuilder,
  McaServer,
  persistExternalMediaOutput,
} from '@teros/mca-sdk';
import { resolveInternalObjectUrls } from './lib/resolve-object-urls';

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
// COLLECTION DISCOVERY HELPERS (WS5)
// =============================================================================

/**
 * Keyword → collection suggestions. Used to enrich query-mode results and 404
 * errors with actionable guidance, because Replicate's free-text search is
 * heavily biased toward image/video generation and misses VLMs, OCR, audio
 * understanding, etc.
 */
const COLLECTION_KEYWORDS: Array<{ keywords: RegExp; collections: string[]; hint: string }> = [
  {
    keywords: /\b(vision|vlm|ocr|caption|image.?to.?text|describe.?image|multimodal|llava|qwen.?vl|internvl)\b/i,
    collections: ['image-to-text'],
    hint: 'For vision-language models (VLM), OCR and image captioning, browse the "image-to-text" collection — free-text query rarely surfaces them.',
  },
  {
    keywords: /\b(image.?to.?video|i2v|animate|animation)\b/i,
    collections: ['image-to-video'],
    hint: 'For image-to-video animation, use collection "image-to-video" (NOT "video-generation" — that slug does not exist as a collection).',
  },
  {
    keywords: /\b(text.?to.?video|t2v|generate.?video|video.?gen)\b/i,
    collections: ['text-to-video'],
    hint: 'For text-to-video generation, try collection "text-to-video". Note: "video-generation" is NOT a valid collection slug.',
  },
  {
    keywords: /\b(image.?gen|text.?to.?image|t2i|txt2img|flux|sdxl|stable.?diffusion)\b/i,
    collections: ['text-to-image'],
    hint: 'For text-to-image generation, browse the "text-to-image" collection.',
  },
  {
    keywords: /\b(image.?edit|image.?to.?image|i2i|img2img|inpaint|outpaint|style.?transfer)\b/i,
    collections: ['image-to-image'],
    hint: 'For image editing / image-to-image, browse the "image-to-image" collection.',
  },
  {
    keywords: /\b(audio|music|sound|tts|text.?to.?speech|speech.?to.?text|transcribe|whisper)\b/i,
    collections: ['audio-generation', 'text-to-speech', 'speech-to-text'],
    hint: 'For audio tasks, try collections "audio-generation", "text-to-speech" or "speech-to-text".',
  },
  {
    keywords: /\b(llm|chat|text.?gen|language.?model|instruct)\b/i,
    collections: ['language-models'],
    hint: 'For chat / text-generation LLMs, browse the "language-models" collection.',
  },
  {
    keywords: /\b(embed|embedding|vector)\b/i,
    collections: ['embeddings'],
    hint: 'For embeddings, browse the "embeddings" collection.',
  },
  {
    keywords: /\b(upscale|super.?res|restore|enhance)\b/i,
    collections: ['image-restoration', 'super-resolution'],
    hint: 'For upscaling / restoration, try "image-restoration" or "super-resolution" collections.',
  },
];

/**
 * Suggest relevant collections for a free-text query. Returns an empty array
 * if no keyword matches — caller decides whether to include the block.
 */
function suggestCollections(text: string): Array<{ collection: string; hint: string }> {
  const out: Array<{ collection: string; hint: string }> = [];
  const seen = new Set<string>();
  for (const rule of COLLECTION_KEYWORDS) {
    if (rule.keywords.test(text)) {
      for (const c of rule.collections) {
        if (!seen.has(c)) {
          seen.add(c);
          out.push({ collection: c, hint: rule.hint });
        }
      }
    }
  }
  return out;
}

/**
 * Build an actionable 404 error. Replicate returns 404 both for "model does
 * not exist" and for "model exists but has no served version" (legacy models),
 * and also for wrong collection slugs — the raw message is not actionable.
 */
function buildNotFoundError(kind: 'model' | 'collection' | 'prediction', id: string, rawBody: string): Error {
  if (kind === 'model') {
    const suggestions = suggestCollections(id);
    const suggestionBlock =
      suggestions.length > 0
        ? ` Suggested collections to browse: ${suggestions.map((s) => `"${s.collection}"`).join(', ')}.`
        : '';
    return new Error(
      `Replicate 404: model "${id}" not found or has no served version. ` +
        `Verify the exact owner/name with replicate-list-models (mode collection or query). ` +
        `Note: legacy models without a served version return 404 even though they appear in the catalog — pick a model with a recent run_count.${suggestionBlock} ` +
        `Raw API response: ${rawBody}`,
    );
  }
  if (kind === 'collection') {
    return new Error(
      `Replicate 404: collection "${id}" does not exist. ` +
        `Common collections: "text-to-image", "image-to-image", "image-to-text" (VLMs/OCR), "text-to-video", "image-to-video", "audio-generation", "text-to-speech", "speech-to-text", "language-models", "embeddings". ` +
        `Note: "video-generation" is NOT a valid collection slug — use "image-to-video" or "text-to-video" instead. ` +
        `Raw API response: ${rawBody}`,
    );
  }
  return new Error(
    `Replicate 404: prediction "${id}" not found. It may have expired or the ID is wrong. ` +
      `Use replicate-list-predictions to see recent predictions. Raw API response: ${rawBody}`,
  );
}

/**
 * Throw an enriched error for non-OK responses. 404 gets actionable guidance;
 * other statuses keep the raw message.
 */
async function throwForStatus(response: Response, kind: 'model' | 'collection' | 'prediction', id: string): Promise<never> {
  const body = await response.text();
  if (response.status === 404) {
    throw buildNotFoundError(kind, id, body);
  }
  throw new Error(`API error: ${response.status} ${body}`);
}

// =============================================================================
// OBJECT STORAGE HELPERS (delegated to @teros/mca-sdk — WS1b)
// =============================================================================

/**
 * Result of persisting an output value.
 *
 * Kept as a local alias of the SDK's `PersistedMediaOutput` with the
 * historical `replicateUrls` field name, because the prediction cache
 * (see `PredictionCacheEntry`) is stored in ctx.storage and we don't
 * want to break existing cached documents by renaming the field.
 */
interface PersistedOutput {
  /** The persisted output — same shape as input but with internal URLs. */
  output: unknown;
  /** ObjectIds of persisted objects. */
  objectIds: string[];
  /** Warnings for files that could not be persisted. */
  warnings: string[];
  /** Original Replicate URLs that were persisted (for caching). */
  replicateUrls: string[];
  /** Internal URLs that replaced them (for caching). */
  internalUrls: string[];
}

/**
 * Persist an output value from Replicate into ctx.objects.
 *
 * Thin wrapper over the SDK's `persistExternalMediaOutput` — fixes the
 * `source: 'replicate'` metadata and renames `externalUrls` to the
 * historical `replicateUrls` field used by the prediction cache.
 *
 * Handles three cases:
 * - String URL → download and persist, return internal URL
 * - Array of URLs → download and persist each, return array of internal URLs
 * - Non-URL output (text, data URI, etc.) → return as-is
 */
async function persistOutput(
  output: unknown,
  context: any,
  metadata: Record<string, string>,
): Promise<PersistedOutput> {
  const result = await persistExternalMediaOutput(output, context, {
    source: 'replicate',
    defaultContentType: 'image/png',
    metadata,
  });
  return {
    output: result.output,
    objectIds: result.objectIds,
    warnings: result.warnings,
    replicateUrls: result.externalUrls,
    internalUrls: result.internalUrls,
  };
}

/**
 * Cache entry mapping a predictionId to its persisted output.
 * Stored in ctx.storage so repeated polls don't re-download.
 */
interface PredictionCacheEntry {
  /** The persisted output (internal URLs replacing Replicate URLs). */
  output: unknown;
  /** ObjectIds in ctx.objects. */
  objectIds: string[];
  /** Original Replicate URLs that were persisted. */
  replicateUrls: string[];
  /** Internal URLs that replaced them. */
  internalUrls: string[];
}

/**
 * Cache a prediction→objectId mapping in ctx.storage.
 * Best-effort — failures are logged but don't break the tool.
 */
async function cachePrediction(
  predictionId: string,
  entry: PredictionCacheEntry,
  context: any,
): Promise<void> {
  try {
    await context.storage.put('predictions', predictionId, entry as unknown as Record<string, unknown>);
  } catch (error) {
    console.error('[mca.replicate] Failed to cache prediction mapping:', error);
  }
}

/**
 * Get cached prediction mapping from ctx.storage.
 * Returns null if not cached or storage is unavailable.
 */
async function getCachedPrediction(
  predictionId: string,
  context: any,
): Promise<PredictionCacheEntry | null> {
  try {
    const result = await context.storage.get('predictions', predictionId);
    if (result.success && result.document) {
      return result.document as unknown as PredictionCacheEntry;
    }
    return null;
  } catch {
    return null;
  }
}

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.replicate',
  name: 'Replicate',
  version: '2.1.0',
});

// -----------------------------------------------------------------------------
// Health Check
// -----------------------------------------------------------------------------

server.tool('-health-check', {
  annotations: { readOnlyHint: true },
  description: 'Internal health check tool. Verifies Replicate API token and connectivity.',
  parameters: { type: 'object', properties: {} },
  handler: async (args, context) => {
    const builder = new HealthCheckBuilder().setVersion('2.1.0');
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
  annotations: { readOnlyHint: true },
  description:
    'Discover models available on Replicate and their exact input parameters. ' +
    'Three modes: ' +
    '(1) collection: list models in a category. Examples: "text-to-image", "image-to-image", "image-to-text" (vision-language models / OCR / image captioning), "text-to-video", "image-to-video", "audio-generation", "text-to-speech", "speech-to-text", "language-models", "embeddings". ' +
    'NOTE: "video-generation" is NOT a valid collection slug — use "image-to-video" or "text-to-video" instead. ' +
    '(2) query: free-text search by name or description. Replicate query search is biased toward image/video generation — for vision-language models (VLM), OCR, image captioning or other non-generative tasks, prefer browsing the "image-to-text" collection directly. ' +
    '(3) model: get the full input/output schema for a specific model in "owner/name" format (e.g. "google/veo-3.1") — use this before replicate-run to know exactly what parameters to pass.',
  parameters: {
    type: 'object',
    properties: {
      collection: {
        type: 'string',
        description:
          'Collection slug to browse. Examples: "text-to-image", "image-to-image", "image-to-text" (VLMs / OCR / image captioning), "text-to-video", "image-to-video", "audio-generation", "text-to-speech", "speech-to-text", "language-models", "embeddings". NOTE: "video-generation" is not a valid collection slug.',
      },
      query: {
        type: 'string',
        description:
          'Free-text search query to find models by name or description. Biased toward image/video generation — for vision (VLM/OCR/captioning) prefer collection="image-to-text" instead.',
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
      if (!response.ok) await throwForStatus(response, 'model', args.model as string);
      const data: any = await response.json();

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
      if (!response.ok) await throwForStatus(response, 'collection', args.collection as string);
      const data: any = await response.json();

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
      if (!response.ok) await throwForStatus(response, 'model', args.query as string);
      const data: any = await response.json();

      const results = (data.results || []).map((m: any) => ({
        id: `${m.owner}/${m.name}`,
        description: m.description,
        run_count: m.run_count,
        url: m.url,
      }));

      // WS5: Replicate's query search is heavily biased toward image/video
      // generation. Attach collection suggestions whenever the query matches
      // a known keyword, and especially when results are scarce — this
      // prevents the agent from guessing model IDs and hitting 404s.
      const suggestions = suggestCollections(args.query as string);
      if (suggestions.length > 0 || results.length < 5) {
        return {
          results,
          _suggestedCollections: suggestions,
          _hint:
            'Replicate query search is biased toward image/video generation. ' +
            'For vision-language models (VLM), OCR or image captioning, browse collection "image-to-text". ' +
            'For other categories, prefer replicate-list-models with the collection field over query.',
        };
      }

      return results;
    }

    throw new Error('Provide at least one of: collection, query, or model');
  },
});

// -----------------------------------------------------------------------------
// replicate-run (always async)
// -----------------------------------------------------------------------------

server.tool('replicate-run', {
  annotations: { readOnlyHint: false },
  description:
    'Run any model on Replicate. ALWAYS asynchronous — returns immediately with a prediction ID and status "starting". ' +
    'Then use replicate-get-prediction to poll until done. ' +
    'Use replicate-list-models first to discover the model ID and its exact input parameters. ' +
    'When the prediction succeeds, generated media (images, videos, audio) is persisted to internal object storage and served via permanent internal URLs — the agent never sees Replicate\'s temporary URLs.' +
    'Image/video/audio inputs inside `input` must be PUBLIC URLs (https://...) or data: URIs — Replicate cannot reach internal/localhost URLs. ' +
    'If you pass an internal Teros objects URL (http://localhost:.../objects/obj_... or http://127.0.0.1:.../objects/obj_...), it is automatically resolved to a data URI (objects up to 10 MB).',
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

    // External Replicate API cannot reach internal Teros URLs. Resolve any
    // localhost/127.0.0.1 objects URLs in the input to data URIs before sending.
    const resolvedInput = await resolveInternalObjectUrls(args.input, context.objects);

    let response: Response;
    if (hasVersion) {
      const [, version] = model.split(':');
      response = await replicateRequest('/predictions', apiToken, {
        method: 'POST',
        body: JSON.stringify({ version, input: resolvedInput }),
      });
    } else {
      response = await replicateRequest(`/models/${model}/predictions`, apiToken, {
        method: 'POST',
        body: JSON.stringify({ input: resolvedInput }),
      });
    }

    if (!response.ok) await throwForStatus(response, 'model', model);
    const prediction: any = await response.json();

    // Edge case: if the prediction completed synchronously (status=succeeded),
    // persist the output immediately. This is rare but some fast models do it.
    if (prediction.status === 'succeeded' && prediction.output) {
      const metadata = {
        model: prediction.model || model,
        predictionId: prediction.id,
      };
      const result = await persistOutput(prediction.output, context, metadata);
      prediction.output = result.output;
      prediction._objectIds = result.objectIds;
      if (result.warnings.length > 0) {
        prediction._warnings = result.warnings;
      }

      // Cache so get-prediction doesn't re-download
      await cachePrediction(prediction.id, {
        output: result.output,
        objectIds: result.objectIds,
        replicateUrls: result.replicateUrls,
        internalUrls: result.internalUrls,
      }, context);
    }

    return prediction;
  },
});

// -----------------------------------------------------------------------------
// replicate-get-prediction
// -----------------------------------------------------------------------------

server.tool('replicate-get-prediction', {
  annotations: { readOnlyHint: true },
  description:
    'Get the status and result of a prediction by ID. ' +
    'Poll this after replicate-run until status is "succeeded" or "failed". ' +
    'When succeeded, the output field contains the result served via permanent internal URLs (images, videos, audio are persisted to internal object storage — the agent never sees Replicate\'s temporary URLs). ' +
    'IMPORTANT: Replicate output URLs (including stream.replicate.com signed URLs) expire ~1h after the prediction completes. Poll promptly after replicate-run — the first poll that sees "succeeded" persists the media immediately. If the first poll happens after expiry, the download will fail and the media is unrecoverable. ' +
    'Repeated polls return cached internal URLs without re-downloading.',
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
    if (!response.ok) await throwForStatus(response, 'prediction', args.predictionId as string);
    const prediction: any = await response.json();

    // When the prediction has succeeded, persist output to ctx.objects
    // and return internal permanent URLs instead of Replicate's temporary ones.
    if (prediction.status === 'succeeded' && prediction.output) {
      // Check cache first — repeated polls should not re-download
      const cached = await getCachedPrediction(prediction.id, context);
      if (cached) {
        prediction.output = cached.output;
        prediction._objectIds = cached.objectIds;
      } else {
        // First time seeing this completed prediction — download and persist
        const metadata = {
          model: prediction.model || 'unknown',
          predictionId: prediction.id,
        };
        const result = await persistOutput(prediction.output, context, metadata);
        prediction.output = result.output;
        prediction._objectIds = result.objectIds;
        if (result.warnings.length > 0) {
          prediction._warnings = result.warnings;
        }

        // Cache so subsequent polls don't re-download
        await cachePrediction(prediction.id, {
          output: result.output,
          objectIds: result.objectIds,
          replicateUrls: result.replicateUrls,
          internalUrls: result.internalUrls,
        }, context);
      }
    }

    return prediction;
  },
});

// -----------------------------------------------------------------------------
// replicate-cancel-prediction
// -----------------------------------------------------------------------------

server.tool('replicate-cancel-prediction', {
  annotations: { readOnlyHint: false, irreversible: true },
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
  annotations: { readOnlyHint: true },
  description:
    'List recent predictions with their status. Useful to track ongoing or past generations. ' +
    'For completed predictions, the output field contains internal permanent URLs if the media was previously persisted; ' +
    'otherwise output is null (Replicate\'s temporary URLs may have expired and cannot be retrieved).',
  parameters: { type: 'object', properties: {} },
  handler: async (args, context) => {
    const secrets = await context.getSystemSecrets();
    const apiToken = getApiToken(secrets);
    if (!apiToken) throw new Error('Replicate API token not configured');

    const response = await replicateRequest('/predictions', apiToken);
    if (!response.ok) throw new Error(`API error: ${response.status} ${await response.text()}`);
    const data: any = await response.json();

    // For each prediction, replace output with cached internal URLs if available.
    // Do NOT attempt to download from Replicate — past prediction URLs are likely expired.
    const predictions = await Promise.all(
      (data.results || []).map(async (p: any) => {
        let output = p.output || null;
        let objectIds: string[] | undefined;

        if (p.status === 'succeeded' && p.output) {
          const cached = await getCachedPrediction(p.id, context);
          if (cached) {
            output = cached.output;
            objectIds = cached.objectIds;
          } else {
            // Not cached — Replicate URL has likely expired (1h TTL).
            // Return null instead of a dead link.
            output = null;
          }
        }

        return {
          id: p.id,
          model: p.model,
          status: p.status,
          created_at: p.created_at,
          completed_at: p.completed_at || null,
          error: p.error || null,
          output,
          ...(objectIds && { _objectIds: objectIds }),
        };
      }),
    );

    return predictions;
  },
});

// =============================================================================
// START SERVER
// =============================================================================

server
  .start()
  .then(() => {
    console.error('🎨 Replicate MCA server running (v2.1.0 — async, model-agnostic, internal object storage)');
  })
  .catch((error) => {
    console.error('Failed to start Replicate MCA:', error);
    process.exit(1);
  });
