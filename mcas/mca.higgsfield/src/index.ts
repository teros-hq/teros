#!/usr/bin/env npx tsx

/**
 * Higgsfield MCA
 *
 * Generate AI images and videos with Higgsfield - text-to-image,
 * image-to-video, and consistent character generation with Soul.
 *
 * Uses @teros/mca-sdk McaServer with HTTP transport.
 * Secrets are fetched on-demand from the backend via callbackUrl.
 */

import { HealthCheckBuilder, McaServer } from "@teros/mca-sdk"
import { resolveInternalObjectUrls, type ObjectStorageLike } from "./lib/resolve-object-urls"
import { persistHiggsfieldOutput } from "./lib/persist-output"

// =============================================================================
// CONFIGURATION
// =============================================================================

const HIGGSFIELD_API_URL = "https://platform.higgsfield.ai"

// =============================================================================
// TYPES
// =============================================================================

interface HiggsFieldCredentials {
  apiKey: string
  apiSecret: string
}

// =============================================================================
// HIGGSFIELD API HELPERS
// =============================================================================

/**
 * Get API credentials from secrets
 */
function getCredentials(secrets: Record<string, string>): HiggsFieldCredentials | null {
  // Option 1: Combined key (HF_KEY format: "key:secret")
  const hfKey = secrets.HF_KEY || secrets.hf_key
  if (hfKey && hfKey.includes(":")) {
    const [apiKey, apiSecret] = hfKey.split(":")
    return {
      apiKey,
      apiSecret,
    }
  }

  // Option 2: Separate key and secret
  const apiKey = secrets.API_KEY || secrets.api_key || secrets.apiKey
  const apiSecret = secrets.API_SECRET || secrets.api_secret || secrets.apiSecret

  if (apiKey && apiSecret) {
    return {
      apiKey,
      apiSecret,
    }
  }

  return null
}

/**
 * Make authenticated request to Higgsfield API
 */
async function higgsFieldRequest(
  endpoint: string,
  credentials: HiggsFieldCredentials,
  options: RequestInit = {},
): Promise<Response> {
  const authKey = `${credentials.apiKey}:${credentials.apiSecret}`
  return fetch(`${HIGGSFIELD_API_URL}${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Key ${authKey}`,
      ...options.headers,
    },
  })
}

/**
 * Poll for request completion (with progress updates)
 */
async function pollRequestWithProgress(
  requestId: string,
  credentials: HiggsFieldCredentials,
  onProgress?: (status: string) => void,
  maxAttempts: number = 120, // 10 minutes max (5s intervals)
): Promise<any> {
  let attempts = 0
  let lastStatus = ""

  while (attempts < maxAttempts) {
    const response = await higgsFieldRequest(`/requests/${requestId}/status`, credentials)

    if (!response.ok) {
      throw new Error(`Failed to poll request: ${response.statusText}`)
    }

    const result = await response.json()
    const status = result.status || result.data?.status

    // Report progress if status changed
    if (status !== lastStatus && onProgress) {
      onProgress(status)
      lastStatus = status
    }

    if (status === "completed" || status === "Completed") {
      return result
    }

    if (status === "failed" || status === "Failed" || status === "cancelled" || status === "Cancelled") {
      throw new Error(`Request ${status}: ${result.error || result.message || "Unknown error"}`)
    }

    if (status === "nsfw" || status === "NSFW") {
      throw new Error("Request blocked: NSFW content detected")
    }

    await new Promise((resolve) => setTimeout(resolve, 5000))
    attempts++
  }

  throw new Error("Request timed out after 10 minutes")
}

/**
 * Submit a request to Higgsfield (always async, returns immediately)
 */
async function submitRequest(
  model: string,
  args: Record<string, any>,
  credentials: HiggsFieldCredentials,
  objects?: ObjectStorageLike,
): Promise<any> {
  // External Higgsfield API cannot reach internal Teros URLs. Resolve any
  // localhost/127.0.0.1 objects URLs in the payload to data URIs before sending.
  const resolvedArgs = objects
    ? await resolveInternalObjectUrls(args, objects)
    : args

  // Submit directly to the model endpoint
  const response = await higgsFieldRequest(`/${model}`, credentials, {
    method: "POST",
    body: JSON.stringify(resolvedArgs),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`API error: ${response.status} ${errorText}`)
  }

  const result = await response.json()
  return result
}

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: "mca.higgsfield",
  name: "Higgsfield",
  version: "1.0.0",
})

// -----------------------------------------------------------------------------
// Health Check Tool
// -----------------------------------------------------------------------------

server.tool("-health-check", {
  annotations: { readOnlyHint: true },
  description: "Internal health check tool. Verifies Higgsfield API credentials and connectivity.",
  parameters: {
    type: "object",
    properties: {},
  },
  handler: async (args, context) => {
    const builder = new HealthCheckBuilder().setVersion("1.0.0")

    try {
      const secrets = await context.getUserSecrets()
      const credentials = getCredentials(secrets)

      if (!credentials) {
        builder.addIssue("USER_CONFIG_MISSING", "Higgsfield API credentials not configured", {
          type: "user_action",
          description: "Configure API_KEY and API_SECRET in app settings",
        })
      }
    } catch (error) {
      builder.addIssue(
        "USER_CONFIG_MISSING",
        error instanceof Error ? error.message : "Failed to get secrets",
        {
          type: "user_action",
          description: "Configure your Higgsfield API credentials in app settings",
        },
      )
    }

    return builder.build()
  },
})

// -----------------------------------------------------------------------------
// Generic Run Tool (Async)
// -----------------------------------------------------------------------------

server.tool("higgsfield-run", {
  annotations: { readOnlyHint: false },
  description:
    "Run any model on Higgsfield. Supports text-to-image, image-to-video, and other AI generation models. " +
    "Image/video inputs inside `input` must be PUBLIC URLs (https://...) or data: URIs — Higgsfield cannot reach internal/localhost URLs. " +
    "Internal Teros objects URLs (http://localhost:.../objects/obj_... or http://127.0.0.1:.../objects/obj_...) are automatically resolved to data URIs (objects up to 10 MB).",
  parameters: {
    type: "object",
    properties: {
      model: {
        type: "string",
        description: "Model/endpoint identifier (e.g., 'higgsfield-ai/soul/standard'). Run higgsfield-list-models to see what's available.",
      },
      input: {
        type: "object",
        description: "Input parameters for the model",
      },
      wait: {
        type: "boolean",
        description: "Wait for completion (default: false)",
        default: false,
      },
    },
    required: ["model", "input"],
  },
  handler: async (args, context) => {
    const secrets = await context.getUserSecrets()
    const credentials = getCredentials(secrets)
    if (!credentials) throw new Error("Higgsfield API credentials not configured")

    const result = await submitRequest(args.model as string, args.input as Record<string, any>, credentials, context.objects)

    // If wait is true, poll for completion
    if (args.wait) {
      const completed = await pollRequestWithProgress(result.request_id, credentials, (status) => {
        console.log(`Status: ${status}`)
      })
      const persisted = await persistHiggsfieldOutput(completed, context, {
        predictionId: result.request_id,
        model: args.model as string,
      })
      return { ...persisted.output, objectIds: persisted.objectIds, warnings: persisted.warnings.length ? persisted.warnings : undefined }
    }

    // Return immediately with request info
    return {
      request_id: result.request_id,
      status: result.status,
      status_url: result.status_url,
      cancel_url: result.cancel_url,
      message: "Request submitted. Use higgsfield-get-prediction to check status.",
    }
  },
})

// -----------------------------------------------------------------------------
// Text-to-Image Tool (Async)
// -----------------------------------------------------------------------------

server.tool("higgsfield-text-to-image", {
  annotations: { readOnlyHint: false },
  description: "Generate images from text prompts using Higgsfield Soul Standard (ultra-realistic fashion/portrait).",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Text description of the image to generate",
      },
      resolution: {
        type: "string",
        enum: ["720p", "1080p"],
        default: "1080p",
        description: "Output resolution",
      },
      aspect_ratio: {
        type: "string",
        enum: ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9", "9:21"],
        default: "16:9",
        description: "Aspect ratio of the generated image",
      },
      style: {
        type: "string",
        description: "Optional style preset",
      },
      wait: {
        type: "boolean",
        description: "Wait for completion (default: false)",
        default: false,
      },
    },
    required: ["prompt"],
  },
  handler: async (args, context) => {
    const secrets = await context.getUserSecrets()
    const credentials = getCredentials(secrets)
    if (!credentials) throw new Error("Higgsfield API credentials not configured")

    const input: Record<string, any> = {
      prompt: args.prompt,
      resolution: args.resolution || "1080p",
      aspect_ratio: args.aspect_ratio || "16:9",
    }
    if (args.style) input.style = args.style

    const result = await submitRequest("higgsfield-ai/soul/standard", input, credentials, context.objects)

    // If wait is true, poll for completion
    if (args.wait) {
      const completed = await pollRequestWithProgress(result.request_id, credentials)
      const persisted = await persistHiggsfieldOutput(completed, context, {
        predictionId: result.request_id,
        model: "higgsfield-ai/soul/standard",
      })
      return {
        status: persisted.output.status,
        images: persisted.output.images,
        request_id: persisted.output.request_id,
        objectIds: persisted.objectIds,
        warnings: persisted.warnings.length ? persisted.warnings : undefined,
      }
    }

    // Return immediately
    return {
      request_id: result.request_id,
      status: result.status,
      status_url: result.status_url,
      cancel_url: result.cancel_url,
      message: "Request submitted. Use higgsfield-get-prediction to check status.",
    }
  },
})

// -----------------------------------------------------------------------------
// Text-to-Video Tool (Async)
// -----------------------------------------------------------------------------

server.tool("higgsfield-text-to-video", {
  annotations: { readOnlyHint: false },
  description: "Generate video from text prompt using WAN v2.6.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Text description of the video to generate",
      },
      duration: {
        type: "number",
        default: 5,
        description: "Video duration in seconds (default: 5)",
      },
      resolution: {
        type: "string",
        enum: ["720p", "1080p"],
        default: "1080p",
        description: "Output resolution",
      },
      aspect_ratio: {
        type: "string",
        enum: ["16:9", "9:16", "1:1"],
        default: "16:9",
        description: "Aspect ratio",
      },
      wait: {
        type: "boolean",
        description: "Wait for completion (default: false)",
        default: false,
      },
    },
    required: ["prompt"],
  },
  handler: async (args, context) => {
    const secrets = await context.getUserSecrets()
    const credentials = getCredentials(secrets)
    if (!credentials) throw new Error("Higgsfield API credentials not configured")

    const input: Record<string, any> = {
      prompt: args.prompt,
      duration: args.duration || 5,
      resolution: args.resolution || "1080p",
      aspect_ratio: args.aspect_ratio || "16:9",
    }

    const result = await submitRequest("wan/v2.6/text-to-video", input, credentials, context.objects)

    if (args.wait) {
      const completed = await pollRequestWithProgress(result.request_id, credentials)
      const persisted = await persistHiggsfieldOutput(completed, context, {
        predictionId: result.request_id,
        model: "wan/v2.6/text-to-video",
      })
      return {
        status: persisted.output.status,
        video: persisted.output.video,
        request_id: persisted.output.request_id,
        objectIds: persisted.objectIds,
        warnings: persisted.warnings.length ? persisted.warnings : undefined,
      }
    }

    return {
      request_id: result.request_id,
      status: result.status,
      status_url: result.status_url,
      cancel_url: result.cancel_url,
      message: "Request submitted. Use higgsfield-get-prediction to check status.",
    }
  },
})

// -----------------------------------------------------------------------------
// Soul Image Generation Tool (Async)
// -----------------------------------------------------------------------------

server.tool("higgsfield-soul-generate", {
  annotations: { readOnlyHint: false },
  description:
    "Generate images with consistent character appearance using Soul. Great for creating multiple images of the same character.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Text description of the scene/pose for the character",
      },
      reference_image: {
        type: "string",
        description: "URL of the reference image for character consistency. Must be a PUBLIC URL (https://...) or data: URI — internal/localhost URLs are auto-resolved to data URIs (up to 10 MB).",
      },
      style: {
        type: "string",
        description: "Optional style preset",
      },
      resolution: {
        type: "string",
        enum: ["720p", "1080p"],
        default: "1080p",
      },
      wait: {
        type: "boolean",
        description: "Wait for completion (default: false)",
        default: false,
      },
    },
    required: ["prompt", "reference_image"],
  },
  handler: async (args, context) => {
    const secrets = await context.getUserSecrets()
    const credentials = getCredentials(secrets)
    if (!credentials) throw new Error("Higgsfield API credentials not configured")

    const input: Record<string, any> = {
      prompt: args.prompt,
      image: args.reference_image,
      resolution: args.resolution || "1080p",
    }
    if (args.style) input.style = args.style

    const result = await submitRequest("higgsfield-ai/soul/reference", input, credentials, context.objects)

    if (args.wait) {
      const completed = await pollRequestWithProgress(result.request_id, credentials)
      const persisted = await persistHiggsfieldOutput(completed, context, {
        predictionId: result.request_id,
        model: "higgsfield-ai/soul/standard",
      })
      return {
        status: persisted.output.status,
        images: persisted.output.images,
        request_id: persisted.output.request_id,
        objectIds: persisted.objectIds,
        warnings: persisted.warnings.length ? persisted.warnings : undefined,
      }
    }

    return {
      request_id: result.request_id,
      status: result.status,
      status_url: result.status_url,
      cancel_url: result.cancel_url,
      message: "Request submitted. Use higgsfield-get-prediction to check status.",
    }
  },
})

// -----------------------------------------------------------------------------
// Get Prediction Status Tool (renamed from get-request)
// -----------------------------------------------------------------------------

server.tool("higgsfield-get-prediction", {
  annotations: { readOnlyHint: true },
  description: "Get the status and result of a prediction by ID.",
  parameters: {
    type: "object",
    properties: {
      prediction_id: {
        type: "string",
        description: "The prediction ID to check",
      },
      wait: {
        type: "boolean",
        default: false,
        description: "Wait for completion if still processing (default: false)",
      },
    },
    required: ["prediction_id"],
  },
  handler: async (args, context) => {
    const secrets = await context.getUserSecrets()
    const credentials = getCredentials(secrets)
    if (!credentials) throw new Error("Higgsfield API credentials not configured")

    if (args.wait) {
      const completed = await pollRequestWithProgress(args.prediction_id as string, credentials)
      const persisted = await persistHiggsfieldOutput(completed, context, {
        predictionId: args.prediction_id as string,
      })
      return { ...persisted.output, objectIds: persisted.objectIds, warnings: persisted.warnings.length ? persisted.warnings : undefined }
    }

    const response = await higgsFieldRequest(`/requests/${args.prediction_id}/status`, credentials)
    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${await response.text()}`)
    }

    const result = await response.json()
    const status = result.status || result.data?.status
    if (status === "completed" || status === "Completed") {
      const persisted = await persistHiggsfieldOutput(result, context, {
        predictionId: args.prediction_id as string,
      })
      return { ...persisted.output, objectIds: persisted.objectIds, warnings: persisted.warnings.length ? persisted.warnings : undefined }
    }
    return result
  },
})

// -----------------------------------------------------------------------------
// Cancel Prediction Tool (renamed from cancel-request)
// -----------------------------------------------------------------------------

server.tool("higgsfield-cancel-prediction", {
  annotations: { readOnlyHint: false, irreversible: true },
  description: "Cancel a queued or processing prediction.",
  parameters: {
    type: "object",
    properties: {
      prediction_id: {
        type: "string",
        description: "The prediction ID to cancel",
      },
    },
    required: ["prediction_id"],
  },
  handler: async (args, context) => {
    const secrets = await context.getUserSecrets()
    const credentials = getCredentials(secrets)
    if (!credentials) throw new Error("Higgsfield API credentials not configured")

    const response = await higgsFieldRequest(`/requests/${args.prediction_id}/cancel`, credentials, {
      method: "POST",
    })

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${await response.text()}`)
    }

    return {
      success: true,
      message: "Prediction cancelled successfully",
    }
  },
})

// -----------------------------------------------------------------------------
// List Available Models Tool
// -----------------------------------------------------------------------------

server.tool("higgsfield-list-models", {
  annotations: { readOnlyHint: true },
  description: "List available models and their capabilities.",
  parameters: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["all", "text-to-image", "image-to-video", "text-to-video", "image-to-image"],
        default: "all",
        description: "Filter models by type",
      },
    },
  },
  handler: async (args) => {
    // Curated list of models empirically verified against the Higgsfield API
    // (submit + immediate cancel, 2026-10-20). Every entry here returned 200 OK.
    // Models that returned 404/423/503 were removed — see git history for details.
    const allModels = [
      // =====================================================================
      // TEXT-TO-IMAGE MODELS
      // =====================================================================
      {
        id: "higgsfield-ai/soul/standard",
        name: "Soul Standard",
        type: "text-to-image",
        status: "available",
        description:
          "Higgsfield's flagship text-to-image model. Ultra-realistic fashion and portrait generation. Reliable first-party engine.",
        parameters: ["prompt", "aspect_ratio", "resolution"],
        notes: "resolution must be '720p' or '1080p' (not 1K/2K/4K)",
      },
      // =====================================================================
      // IMAGE-TO-IMAGE MODELS (character consistency)
      // =====================================================================
      {
        id: "higgsfield-ai/soul/reference",
        name: "Soul Reference",
        type: "image-to-image",
        status: "available",
        description:
          "Character-consistent image generation from a reference image. Use this to keep the same character across multiple scenes.",
        parameters: ["prompt", "image", "resolution"],
        notes: "resolution must be '720p' or '1080p'",
      },
      {
        id: "higgsfield-ai/soul/character",
        name: "Soul Character",
        type: "image-to-image",
        status: "available",
        description: "Soul character mode — variant of Soul tuned for character work.",
        parameters: ["prompt", "image", "resolution"],
        notes: "resolution must be '720p' or '1080p'",
      },
      // =====================================================================
      // IMAGE-TO-VIDEO MODELS
      // =====================================================================
      {
        id: "higgsfield-ai/dop/standard",
        name: "DoP Standard",
        type: "image-to-video",
        status: "available",
        description:
          "Higgsfield's own image-to-video engine. Standard quality, reliable motion control. This is the recommended default for image-to-video on Higgsfield.",
        parameters: ["image_url", "prompt", "duration"],
        notes: "uses 'image_url' (string), not 'input_images'",
      },
      {
        id: "higgsfield-ai/dop/lite",
        name: "DoP Lite",
        type: "image-to-video",
        status: "available",
        description: "Lightweight, faster DoP variant. Good for quick iterations and drafts.",
        parameters: ["image_url", "prompt", "duration"],
      },
      {
        id: "higgsfield-ai/dop/turbo",
        name: "DoP Turbo",
        type: "image-to-video",
        status: "available",
        description: "Highest-quality DoP variant. Slower but best motion fidelity.",
        parameters: ["image_url", "prompt", "duration"],
      },
      // =====================================================================
      // TEXT-TO-VIDEO MODELS
      // =====================================================================
      {
        id: "wan/v2.6/text-to-video",
        name: "WAN v2.6",
        type: "text-to-video",
        status: "available",
        description: "Text-to-video generation with camera control. Verified working on the current plan.",
        parameters: ["prompt", "duration", "resolution", "aspect_ratio", "camera_motion"],
      },
    ]
    const filterType = args.type as string || "all"
    
    const filteredModels = filterType === "all" 
      ? allModels 
      : allModels.filter(m => m.type === filterType)

    return {
      total: filteredModels.length,
      filter: filterType,
      models: filteredModels,
      note:
        "Empirically verified catalog (2026-10-20): every model listed here returned 200 OK on a real submit+cancel probe. " +
        "For image-to-video, prefer Higgsfield's own DoP engine (higgsfield-ai/dop/standard|lite|turbo) — it is the reliable first-party option on this platform. " +
        "Seedance is NOT served by the Higgsfield API (all variants return 404); if you need Seedance, use the Replicate MCA with model 'bytedance/seedance-2.0'. " +
        "Kling and Reve are blocked on the current plan (423 model_blocked). " +
        "Full gallery: https://cloud.higgsfield.ai/explore",
    }
  },
})

// =============================================================================
// START SERVER
// =============================================================================

server
  .start()
  .then(() => {
    console.error("🎬 Higgsfield MCA server running")
  })
  .catch((error) => {
    console.error("Failed to start Higgsfield MCA:", error)
    process.exit(1)
  })
