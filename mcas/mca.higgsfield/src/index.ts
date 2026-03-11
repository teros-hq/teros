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
): Promise<any> {
  // Submit directly to the model endpoint
  const response = await higgsFieldRequest(`/${model}`, credentials, {
    method: "POST",
    body: JSON.stringify(args),
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
  description:
    "Run any model on Higgsfield. Supports text-to-image, image-to-video, and other AI generation models.",
  parameters: {
    type: "object",
    properties: {
      model: {
        type: "string",
        description: "Model/endpoint identifier (e.g., 'bytedance/seedream/v4/text-to-image')",
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

    const result = await submitRequest(args.model as string, args.input as Record<string, any>, credentials)

    // If wait is true, poll for completion
    if (args.wait) {
      const completed = await pollRequestWithProgress(result.request_id, credentials, (status) => {
        console.log(`Status: ${status}`)
      })
      return completed
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
  description: "Generate images from text prompts using Seedream v4.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Text description of the image to generate",
      },
      resolution: {
        type: "string",
        enum: ["1K", "2K", "4K"],
        default: "2K",
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
      resolution: args.resolution || "2K",
      aspect_ratio: args.aspect_ratio || "16:9",
    }
    if (args.style) input.style = args.style

    const result = await submitRequest("bytedance/seedream/v4/text-to-image", input, credentials)

    // If wait is true, poll for completion
    if (args.wait) {
      const completed = await pollRequestWithProgress(result.request_id, credentials)
      return {
        status: completed.status,
        images: completed.images,
        request_id: completed.request_id,
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
// Image-to-Video Tool (Async)
// -----------------------------------------------------------------------------

server.tool("higgsfield-image-to-video", {
  description: "Convert an image to video with motion. Supports various motion styles and camera movements.",
  parameters: {
    type: "object",
    properties: {
      image_url: {
        type: "string",
        description: "URL of the input image",
      },
      prompt: {
        type: "string",
        description: "Description of the desired motion/video",
      },
      duration: {
        type: "number",
        default: 5,
        description: "Video duration in seconds (default: 5)",
      },
      motion_strength: {
        type: "number",
        minimum: 0,
        maximum: 1,
        default: 0.5,
        description: "Motion intensity (0.0-1.0)",
      },
      camera_motion: {
        type: "string",
        enum: ["none", "zoom_in", "zoom_out", "pan_left", "pan_right", "tilt_up", "tilt_down"],
        default: "none",
        description: "Camera movement type",
      },
      wait: {
        type: "boolean",
        description: "Wait for completion (default: false)",
        default: false,
      },
    },
    required: ["image_url", "prompt"],
  },
  handler: async (args, context) => {
    const secrets = await context.getUserSecrets()
    const credentials = getCredentials(secrets)
    if (!credentials) throw new Error("Higgsfield API credentials not configured")

    const input: Record<string, any> = {
      input_images: [args.image_url],
      prompt: args.prompt,
      duration: args.duration || 5,
      motions_strength: args.motion_strength || 0.5,
    }
    if (args.camera_motion && args.camera_motion !== "none") {
      input.camera_motion = args.camera_motion
    }

    const result = await submitRequest("higgsfield/dop/image-to-video", input, credentials)

    if (args.wait) {
      const completed = await pollRequestWithProgress(result.request_id, credentials)
      return {
        status: completed.status,
        video: completed.video,
        request_id: completed.request_id,
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
// Text-to-Video Tool (Async)
// -----------------------------------------------------------------------------

server.tool("higgsfield-text-to-video", {
  description: "Generate video from text prompt.",
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

    const result = await submitRequest("kling/v2.6/text-to-video", input, credentials)

    if (args.wait) {
      const completed = await pollRequestWithProgress(result.request_id, credentials)
      return {
        status: completed.status,
        video: completed.video,
        request_id: completed.request_id,
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
        description: "URL of the reference image for character consistency",
      },
      style: {
        type: "string",
        description: "Optional style preset",
      },
      resolution: {
        type: "string",
        enum: ["1K", "2K", "4K"],
        default: "2K",
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
      resolution: args.resolution || "2K",
    }
    if (args.style) input.style = args.style

    const result = await submitRequest("higgsfield/soul/image-to-image", input, credentials)

    if (args.wait) {
      const completed = await pollRequestWithProgress(result.request_id, credentials)
      return {
        status: completed.status,
        images: completed.images,
        request_id: completed.request_id,
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
      return await pollRequestWithProgress(args.prediction_id as string, credentials)
    }

    const response = await higgsFieldRequest(`/requests/${args.prediction_id}/status`, credentials)
    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${await response.text()}`)
    }

    return await response.json()
  },
})

// -----------------------------------------------------------------------------
// Cancel Prediction Tool (renamed from cancel-request)
// -----------------------------------------------------------------------------

server.tool("higgsfield-cancel-prediction", {
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
    // Curated list of known models from Higgsfield documentation
    const allModels = [
      // =====================================================================
      // TEXT-TO-IMAGE MODELS
      // =====================================================================
      {
        id: "nano-banana-pro",
        name: "Nano Banana Pro",
        type: "text-to-image",
        description: "Fast, high-quality text-to-image generation. Supports 1k, 2k, 4k resolution.",
        parameters: ["prompt", "resolution", "aspect_ratio"],
      },
      {
        id: "higgsfield-ai/soul/standard",
        name: "Soul Standard",
        type: "text-to-image",
        description: "Flagship text-to-image model with ultra-realistic fashion and portrait generation.",
        parameters: ["prompt", "aspect_ratio", "resolution"],
      },
      {
        id: "bytedance/seedream/v4/text-to-image",
        name: "Seedream v4",
        type: "text-to-image",
        description: "High-quality text-to-image generation by ByteDance.",
        parameters: ["prompt", "resolution", "aspect_ratio"],
      },
      {
        id: "reve/text-to-image",
        name: "Reve",
        type: "text-to-image",
        description: "Versatile text-to-image generation with creative styles.",
        parameters: ["prompt", "resolution", "aspect_ratio"],
      },
      {
        id: "flux-pro",
        name: "FLUX Pro",
        type: "text-to-image",
        description: "State-of-the-art photorealistic image generation.",
        parameters: ["prompt", "aspect_ratio"],
      },
      {
        id: "flux-dev",
        name: "FLUX Dev",
        type: "text-to-image",
        description: "Fast development version of FLUX.",
        parameters: ["prompt", "aspect_ratio"],
      },
      // =====================================================================
      // IMAGE EDITING MODELS
      // =====================================================================
      {
        id: "bytedance/seedream/v4/edit",
        name: "Seedream v4 Edit",
        type: "image-to-image",
        description: "Advanced image editing capabilities.",
        parameters: ["prompt", "image", "resolution"],
      },
      {
        id: "higgsfield-ai/soul/image-to-image",
        name: "Soul Image-to-Image",
        type: "image-to-image",
        description: "Character-consistent image generation from reference images.",
        parameters: ["prompt", "image", "resolution"],
      },
      {
        id: "nano-banana-pro-inpaint",
        name: "Nano Banana Pro Inpaint",
        type: "image-to-image",
        description: "Inpainting and image editing with Nano Banana.",
        parameters: ["prompt", "image", "mask"],
      },
      // =====================================================================
      // IMAGE-TO-VIDEO MODELS
      // =====================================================================
      {
        id: "higgsfield-ai/dop/standard",
        name: "DoP Standard",
        type: "image-to-video",
        description: "Standard image-to-video animation with motion control.",
        parameters: ["image_url", "prompt", "duration"],
      },
      {
        id: "higgsfield-ai/dop/preview",
        name: "DoP Preview",
        type: "image-to-video",
        description: "Fast preview version of DoP for quick iterations.",
        parameters: ["image_url", "prompt", "duration"],
      },
      {
        id: "bytedance/seedance/v1/pro/image-to-video",
        name: "Seedance v1 Pro",
        type: "image-to-video",
        description: "Professional-grade video generation from images.",
        parameters: ["image_url", "prompt", "duration"],
      },
      {
        id: "kling-video/v2.1/pro/image-to-video",
        name: "Kling v2.1 Pro I2V",
        type: "image-to-video",
        description: "Advanced cinematic animations from images.",
        parameters: ["image_url", "prompt", "duration"],
      },
      {
        id: "minimax/image-to-video",
        name: "Minimax I2V",
        type: "image-to-video",
        description: "High-quality image-to-video generation.",
        parameters: ["image_url", "prompt"],
      },
      // =====================================================================
      // TEXT-TO-VIDEO MODELS
      // =====================================================================
      {
        id: "kling/v2.6/text-to-video",
        name: "Kling v2.6",
        type: "text-to-video",
        description: "Generate videos from text prompts with audio support.",
        parameters: ["prompt", "duration", "resolution", "aspect_ratio"],
      },
      {
        id: "kling/v3.0/text-to-video",
        name: "Kling v3.0",
        type: "text-to-video",
        description: "Latest Kling model with improved quality and motion.",
        parameters: ["prompt", "duration", "resolution", "aspect_ratio"],
      },
      {
        id: "minimax/video-01",
        name: "Minimax Video",
        type: "text-to-video",
        description: "High-quality video generation from text.",
        parameters: ["prompt", "duration"],
      },
      {
        id: "wan/v2.6/text-to-video",
        name: "WAN v2.6",
        type: "text-to-video",
        description: "Text-to-video with camera control.",
        parameters: ["prompt", "duration", "camera_motion"],
      },
      {
        id: "veo/v3.1/text-to-video",
        name: "Google Veo 3.1",
        type: "text-to-video",
        description: "Google's Veo model for high-quality video generation.",
        parameters: ["prompt", "duration", "aspect_ratio"],
      },
      {
        id: "sora/v2/text-to-video",
        name: "Sora 2",
        type: "text-to-video",
        description: "OpenAI's Sora model for cinematic video generation.",
        parameters: ["prompt", "duration", "aspect_ratio"],
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
      note: "This is a curated list. Visit https://cloud.higgsfield.ai/explore for the complete gallery of 100+ models.",
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
