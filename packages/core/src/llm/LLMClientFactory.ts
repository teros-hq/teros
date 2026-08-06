/**
 * LLM Client Factory
 * Creates LLM client instances based on configuration
 *
 * Supported providers:
 * - 'anthropic': Uses API key (from config, env, or Claude Code CLI)
 * - 'anthropic-oauth': Uses OAuth tokens from Claude Max subscription
 * - 'openai': OpenAI API
 * - 'openrouter': OpenRouter API (multi-provider routing)
 * - 'google': Google AI (Gemini models)
 * - 'zhipu': Z.ai / ZhipuAI (GLM models)
 * - 'zhipu-coding': Z.ai coding API
 * - 'ollama': Local Ollama models
 */

import { log } from "../logger"
import { AnthropicLLMAdapter } from "./AnthropicLLMAdapter"
import { AnthropicOAuthAdapter } from "./AnthropicOAuthAdapter"
import {
  getClaudeCodeAccessToken,
  hasClaudeCodeCredentials,
  loadClaudeCodeCredentials,
} from "./ClaudeCodeCredentials"
import {
  exchangeCodeForTokens,
  generateAuthorizationUrl,
  hasOAuthTokens,
  loadOAuthTokens,
} from './ClaudeOAuth';
import type { ILLMClient } from './ILLMClient';
import { GeminiLLMAdapter } from './GeminiLLMAdapter';
import { OllamaLLMAdapter } from './OllamaLLMAdapter';
import { OpenAICompatibleLLMAdapter } from './OpenAICompatibleLLMAdapter';
import { OpenAILLMAdapter } from './OpenAILLMAdapter';
import { OpenAICodexOAuthAdapter } from './OpenAICodexOAuthAdapter';
import type { CodexOAuthTokens } from './CodexOAuth';
import { OpenRouterLLMAdapter } from './OpenRouterLLMAdapter';
import { ZhipuLLMAdapter } from './ZhipuLLMAdapter';
import { MockLLMAdapter, RecordingLLMAdapter } from '../testing/LLMRecorder';

const MODULE = "LLMClientFactory"

export interface LLMConfig {
  provider: 'anthropic' | 'anthropic-oauth' | 'openai' | 'openai-codex-oauth' | 'openrouter' | 'google' | 'zhipu' | 'zhipu-coding' | 'ollama' | 'ollama-cloud' | 'openai-compatible' | 'minimax' | 'teros' | 'cloudflare' | 'fireworks' | 'together';
  anthropic?: {
    apiKey?: string // Optional for 'anthropic' - can use env or Claude Code CLI
    model: string // Model is required
    maxTokens?: number
  }
  openai?: {
    apiKey: string;
    model?: string;
    maxTokens?: number;
  };
  'openai-codex-oauth'?: {
    tokens: CodexOAuthTokens;
    model: string;
    maxTokens?: number;
    onTokenRefresh?: (newTokens: CodexOAuthTokens) => Promise<void>;
  };
  openrouter?: {
    apiKey?: string // Optional - can use env OPENROUTER_API_KEY
    model: string // Model is required (e.g., 'deepseek/deepseek-chat', 'openrouter/auto')
    maxTokens?: number
    routingStrategy?: "cheapest" | "fastest" | "best" // For auto-routing
    allowFallbacks?: boolean
    providerOrder?: string[]
    ignoreProviders?: string[]
    siteUrl?: string
    appName?: string
  }
  google?: {
    apiKey: string // Required - Google AI Studio API key
    model: string // Model is required (e.g., 'gemini-2.0-flash', 'gemini-2.5-pro-preview-06-05')
    maxTokens?: number
  }
  zhipu?: {
    apiKey?: string // Optional - can use env ZHIPU_API_KEY
    model: string // Model is required (e.g., 'glm-4.6', 'glm-4', 'glm-4v')
    maxTokens?: number
    baseUrl?: string // Custom base URL
    useChina?: boolean // Use China endpoint instead of overseas
  }
  ollama?: {
    baseUrl: string // Ollama server URL (e.g., 'http://midgar:11434' or 'http://localhost:11434')
    model: string // Model name (e.g., 'qwen2.5:7b-instruct', 'deepseek-r1:latest')
    maxTokens?: number
  }
  'ollama-cloud'?: {
    apiKey: string // API key from https://ollama.com/settings/api-keys
    model: string // Cloud model name (e.g., 'qwen3-coder:480b-cloud', 'deepseek-v3.1:671b-cloud')
    maxTokens?: number
  }
  'openai-compatible'?: {
    baseUrl: string // Custom OpenAI-compatible endpoint URL
    model: string // Model name
    apiKey?: string // Optional Bearer token
    customHeaders?: Record<string, string> // Optional custom headers (e.g., CF Access)
    maxTokens?: number
  }
  minimax?: {
    apiKey: string // MiniMax Token Plan API key
    model: string // Model name (e.g., 'MiniMax-M2.7')
    maxTokens?: number
  }
  teros?: {
    apiKey: string // upstream API key (system secret: fireworks or together)
    model: string // upstream model string (e.g., 'accounts/fireworks/models/kimi-k2p6')
    maxTokens?: number
    /** Upstream base URL — set by resolveTerosUpstream (TER-617/F3). Defaults to Fireworks. */
    baseUrl?: string
    /** Real upstream label (`fireworks` | `together`) for telemetry. Defaults to `fireworks`. */
    actualProvider?: string
  }
  cloudflare?: {
    apiKey: string // Cloudflare API token (user secret)
    accountId: string // Cloudflare account ID (user config)
    model: string // Model name (e.g., '@cf/moonshotai/kimi-k2.5')
    maxTokens?: number
  }
  fireworks?: {
    apiKey: string // Fireworks AI API key (user secret)
    model: string // Model name (e.g., 'accounts/fireworks/models/kimi-k2p6')
    maxTokens?: number
  }
  together?: {
    apiKey: string // Together AI API key (user secret)
    model: string // Model name (e.g., 'meta-llama/Llama-3.3-70B-Instruct-Turbo')
    maxTokens?: number
  }
}

/**
 * Resolve OpenAI API key
 *
 * Only accepts explicit apiKey in config (from user provider or system secret).
 * No environment variable fallback.
 */
async function resolveOpenAIApiKey(config: LLMConfig["openai"]): Promise<string> {
  if (config?.apiKey) {
    log.debug(MODULE, "Using explicit OpenAI API key")
    return config.apiKey
  }

  throw new Error(
    "No OpenAI API key available.\n" +
      "Configure a provider in the UI with your API key, or add key to .secrets/system/openai.json",
  )
}

/**
 * Resolve OpenRouter API key
 *
 * Only accepts explicit apiKey in config (from user provider).
 * No environment variable fallback.
 */
async function resolveOpenRouterApiKey(config: LLMConfig["openrouter"]): Promise<string> {
  if (config?.apiKey) {
    log.debug(MODULE, "Using explicit OpenRouter API key")
    return config.apiKey
  }

  throw new Error(
    "No OpenRouter API key available.\n" + "Configure a provider in the UI with your API key.",
  )
}

/**
 * Resolve Google AI API key
 *
 * Only accepts explicit apiKey in config (from user provider).
 * No environment variable fallback.
 */
async function resolveGeminiApiKey(config: LLMConfig["google"]): Promise<string> {
  if (config?.apiKey) {
    log.debug(MODULE, "Using explicit Google AI API key")
    return config.apiKey
  }

  throw new Error(
    "No Google AI API key available.\n" + "Configure a provider in the UI with your API key.",
  )
}

/**
 * Resolve Zhipu API key
 *
 * Only accepts explicit apiKey in config (from user provider).
 * No environment variable fallback.
 */
async function resolveZhipuApiKey(config: LLMConfig["zhipu"]): Promise<string> {
  if (config?.apiKey) {
    log.debug(MODULE, "Using explicit Zhipu API key")
    return config.apiKey
  }

  throw new Error(
    "No Zhipu API key available.\n" + "Configure a provider in the UI with your API key.",
  )
}

/**
 * Resolve MiniMax API key
 *
 * Only accepts explicit apiKey in config (from user provider).
 * No environment variable fallback.
 */
async function resolveMiniMaxApiKey(config: LLMConfig["minimax"]): Promise<string> {
  if (config?.apiKey) {
    log.debug(MODULE, "Using explicit MiniMax API key")
    return config.apiKey
  }

  throw new Error(
    "No MiniMax API key available.\n" + "Configure a provider in the UI with your Token Plan API key.",
  )
}

/**
 * Resolve Teros API key
 *
 * Only accepts explicit apiKey in config (from user provider or system secret).
 * No environment variable fallback.
 */
async function resolveTerosApiKey(config: LLMConfig["teros"]): Promise<string> {
  if (config?.apiKey) {
    log.debug(MODULE, "Using explicit Teros API key")
    return config.apiKey
  }

  throw new Error(
    "No Teros API key available.\n" + "Teros system provider is not configured (missing fireworks secret).",
  )
}

/**
 * Resolve Cloudflare API key
 *
 * Only accepts explicit apiKey in config (from user provider).
 * No environment variable fallback.
 */
async function resolveCloudflareApiKey(config: LLMConfig["cloudflare"]): Promise<string> {
  if (config?.apiKey) {
    log.debug(MODULE, "Using explicit Cloudflare API key")
    return config.apiKey
  }

  throw new Error(
    "No Cloudflare API key available.\n" + "Configure a provider in the UI with your Cloudflare API token.",
  )
}

/**
 * Resolve Fireworks AI API key
 *
 * Only accepts explicit apiKey in config (from user provider).
 * No environment variable fallback.
 */
async function resolveFireworksApiKey(config: LLMConfig["fireworks"]): Promise<string> {
  if (config?.apiKey) {
    log.debug(MODULE, "Using explicit Fireworks AI API key")
    return config.apiKey
  }

  throw new Error(
    "No Fireworks AI API key available.\n" + "Configure a provider in the UI with your Fireworks API key.",
  )
}

/**
 * Resolve Together AI API key
 *
 * Only accepts explicit apiKey in config (from user provider).
 * No environment variable fallback.
 */
async function resolveTogetherApiKey(config: LLMConfig["together"]): Promise<string> {
  if (config?.apiKey) {
    log.debug(MODULE, "Using explicit Together AI API key")
    return config.apiKey
  }

  throw new Error(
    "No Together AI API key available.\n" + "Configure a provider in the UI with your Together API key.",
  )
}

/**
 * Resolve Anthropic API key
 *
 * Priority:
 * 1. Explicit apiKey in config (from user provider or system secret)
 * 2. Claude Code CLI credentials (~/.claude/.credentials.json)
 *
 * Note: No environment variable fallback — API keys are managed via
 * user providers (DB) or .secrets/system/anthropic.json (SecretsManager).
 */
async function resolveAnthropicApiKey(config: LLMConfig["anthropic"]): Promise<string> {
  // 1. Explicit API key (from user provider or system secret)
  if (config?.apiKey) {
    log.debug(MODULE, "Using explicit Anthropic API key")
    return config.apiKey
  }

  // 2. Claude Code CLI credentials (local dev convenience)
  log.debug(MODULE, "Checking for Claude Code CLI credentials...")
  const claudeCodeToken = await getClaudeCodeAccessToken()
  if (claudeCodeToken) {
    log.info(MODULE, "✅ Using Claude Code CLI credentials")
    return claudeCodeToken
  }

  throw new Error(
    "No Anthropic API key available. Please provide one of:\n" +
      "  1. Configure a provider in the UI with your API key\n" +
      "  2. Add key to .secrets/system/anthropic.json\n" +
      "  3. Claude Code CLI credentials (run: claude auth login)\n" +
      '  4. Or use provider: "anthropic-oauth" with Claude Max subscription',
  )
}

/**
 * Factory for creating LLM clients
 *
 * @example
 * ```typescript
 * // With API key
 * const client = await LLMClientFactory.create({
 *   provider: 'anthropic',
 *   anthropic: {
 *     apiKey: 'sk-ant-...',
 *     model: 'claude-sonnet-4-5',
 *   }
 * })
 *
 * // Auto-detect API key (env or Claude Code CLI)
 * const client = await LLMClientFactory.create({
 *   provider: 'anthropic',
 *   anthropic: {
 *     model: 'claude-sonnet-4-5',
 *   }
 * })
 *
 * // With OAuth (Claude Max subscription)
 * const client = await LLMClientFactory.create({
 *   provider: 'anthropic-oauth',
 *   anthropic: {
 *     model: 'claude-sonnet-4-5',
 *   }
 * })
 * ```
 */
export class LLMClientFactory {
  /**
   * Create an LLM client based on configuration.
   *
   * Determinismo en tests E2E (sin tocar a los callers ni al provider real):
   * - TEROS_LLM_REPLAY=<recording.json> → MockLLMAdapter que reproduce respuestas grabadas
   *   (no llama a NINGÚN provider → sin API key, sin coste, determinista). TER-553.
   * - TEROS_LLM_RECORD=<recording.json> → envuelve el adapter real para grabar las llamadas
   *   (one-time, en local con la key real) y generar el recording que CI reproduce.
   */
  static async create(config: LLMConfig): Promise<ILLMClient> {
    // Record tiene prioridad sobre replay: al RE-grabar en local el override añade
    // TEROS_LLM_RECORD sobre un compose que ya trae TEROS_LLM_REPLAY → debe grabar, no reproducir
    // (e intentar reproducir un recording recién borrado petaría).
    const recordPath = process.env.TEROS_LLM_RECORD
    if (recordPath) {
      log.info(MODULE, "LLM record mode", { recording: recordPath, provider: config.provider })
      return new RecordingLLMAdapter(await LLMClientFactory.createReal(config), recordPath)
    }

    const replayPath = process.env.TEROS_LLM_REPLAY
    if (replayPath) {
      log.info(MODULE, "LLM replay mode (deterministic)", { recording: replayPath })
      return new MockLLMAdapter(replayPath)
    }

    return await LLMClientFactory.createReal(config)
  }

  /**
   * Create the real provider-backed LLM client based on configuration
   */
  private static async createReal(config: LLMConfig): Promise<ILLMClient> {
    log.info(MODULE, "Creating LLM client", { provider: config.provider })

    switch (config.provider) {
      case "anthropic": {
        if (!config.anthropic?.model) {
          throw new Error("Anthropic model is required")
        }

        const apiKey = await resolveAnthropicApiKey(config.anthropic)

        return new AnthropicLLMAdapter({
          apiKey,
          model: config.anthropic.model,
          defaultMaxTokens: config.anthropic.maxTokens,
        })
      }

      case "anthropic-oauth": {
        if (!config.anthropic?.model) {
          throw new Error("Anthropic model is required")
        }

        // Check if OAuth tokens exist
        if (!hasOAuthTokens()) {
          throw new Error(
            "No OAuth tokens found. Run oauth:login first to authenticate with Claude Max.",
          )
        }

        log.info(MODULE, "✅ Using Anthropic OAuth provider")

        return new AnthropicOAuthAdapter({
          model: config.anthropic.model,
          defaultMaxTokens: config.anthropic.maxTokens,
        })
      }

      case "openai": {
        if (!config.openai?.model) {
          throw new Error("OpenAI model is required")
        }

        const openaiApiKey = await resolveOpenAIApiKey(config.openai)

        log.info(MODULE, "✅ Using OpenAI provider")

        return new OpenAILLMAdapter({
          apiKey: openaiApiKey,
          model: config.openai.model,
          defaultMaxTokens: config.openai.maxTokens,
        })
      }

      case 'openai-codex-oauth': {
        const codexConfig = config['openai-codex-oauth'];
        if (!codexConfig?.model) {
          throw new Error('OpenAI Codex model is required');
        }
        if (!codexConfig.tokens?.accessToken) {
          throw new Error(
            'No OAuth tokens found for OpenAI Codex. Please connect your ChatGPT Pro/Plus account.',
          );
        }

        log.info(MODULE, '✅ Using OpenAI Codex OAuth provider');

        return new OpenAICodexOAuthAdapter({
          model: codexConfig.model,
          defaultMaxTokens: codexConfig.maxTokens,
          tokens: codexConfig.tokens,
          onTokenRefresh: codexConfig.onTokenRefresh,
        });
      }

      case 'openrouter': {
        if (!config.openrouter?.model) {
          throw new Error("OpenRouter model is required")
        }

        const openrouterApiKey = await resolveOpenRouterApiKey(config.openrouter)

        log.info(MODULE, "✅ Using OpenRouter provider", {
          model: config.openrouter.model,
          isAutoRouting: config.openrouter.model === "openrouter/auto",
          routingStrategy: config.openrouter.routingStrategy,
        })

        return new OpenRouterLLMAdapter({
          apiKey: openrouterApiKey,
          model: config.openrouter.model,
          defaultMaxTokens: config.openrouter.maxTokens,
          routingStrategy: config.openrouter.routingStrategy,
          allowFallbacks: config.openrouter.allowFallbacks,
          providerOrder: config.openrouter.providerOrder,
          ignoreProviders: config.openrouter.ignoreProviders,
          siteUrl: config.openrouter.siteUrl,
          appName: config.openrouter.appName,
        })
      }

      case "google": {
        if (!config.google?.model) {
          throw new Error("Google AI model is required")
        }

        const geminiApiKey = await resolveGeminiApiKey(config.google)

        log.info(MODULE, "✅ Using Google Gemini provider", {
          model: config.google.model,
        })

        return new GeminiLLMAdapter({
          apiKey: geminiApiKey,
          model: config.google.model,
          defaultMaxTokens: config.google.maxTokens,
        })
      }

      case "zhipu": {
        if (!config.zhipu?.model) {
          throw new Error("Zhipu model is required")
        }

        const apiKey = await resolveZhipuApiKey(config.zhipu)

        return new ZhipuLLMAdapter({
          apiKey,
          model: config.zhipu.model,
          defaultMaxTokens: config.zhipu.maxTokens,
          baseUrl: config.zhipu.baseUrl,
          useChina: config.zhipu.useChina,
        })
      }

      case "zhipu-coding": {
        if (!config.zhipu?.model) {
          throw new Error("Zhipu model is required")
        }

        const apiKey = await resolveZhipuApiKey(config.zhipu)

        // Use the coding API endpoint
        return new ZhipuLLMAdapter({
          apiKey,
          model: config.zhipu.model,
          defaultMaxTokens: config.zhipu.maxTokens,
          baseUrl: "https://api.z.ai/api/coding/paas/v4/",
        })
      }

      case "ollama": {
        if (!config.ollama?.model) {
          throw new Error("Ollama model is required")
        }

        if (!config.ollama?.baseUrl) {
          throw new Error("Ollama baseUrl is required")
        }

        log.info(MODULE, "✅ Using Ollama provider", {
          baseUrl: config.ollama.baseUrl,
          model: config.ollama.model,
        })

        return new OllamaLLMAdapter({
          baseUrl: config.ollama.baseUrl,
          model: config.ollama.model,
          defaultMaxTokens: config.ollama.maxTokens,
        })
      }

      case "ollama-cloud": {
        const cloudConfig = config['ollama-cloud']
        if (!cloudConfig?.model) {
          throw new Error("Ollama Cloud model is required")
        }
        if (!cloudConfig?.apiKey) {
          throw new Error(
            "Ollama Cloud API key is required.\n" +
              "Get your API key at: https://ollama.com/settings/api-keys",
          )
        }

        log.info(MODULE, "✅ Using Ollama Cloud provider", {
          model: cloudConfig.model,
        })

        // Ollama Cloud uses the same OpenAI-compatible adapter as local Ollama,
        // but with the cloud base URL and a real API key.
        return new OllamaLLMAdapter({
          baseUrl: 'https://ollama.com',
          model: cloudConfig.model,
          apiKey: cloudConfig.apiKey,
          defaultMaxTokens: cloudConfig.maxTokens,
        })
      }

      case 'openai-compatible': {
        if (!config['openai-compatible']?.baseUrl) {
          throw new Error('openai-compatible: baseUrl is required')
        }
        if (!config['openai-compatible']?.model) {
          throw new Error('openai-compatible: model is required')
        }

        log.info(MODULE, `Creating OpenAI-compatible client`, { baseUrl: config['openai-compatible'].baseUrl })

        return new OpenAICompatibleLLMAdapter({
          baseUrl: config['openai-compatible'].baseUrl,
          model: config['openai-compatible'].model,
          apiKey: config['openai-compatible'].apiKey,
          customHeaders: config['openai-compatible'].customHeaders,
          defaultMaxTokens: config['openai-compatible'].maxTokens,
        })
      }

      case 'minimax': {
        if (!config.minimax?.model) {
          throw new Error("MiniMax model is required")
        }

        const minimaxApiKey = await resolveMiniMaxApiKey(config.minimax)

        log.info(MODULE, "✅ Using MiniMax provider (Anthropic-compatible)", {
          model: config.minimax.model,
        })

        return new AnthropicLLMAdapter({
          apiKey: minimaxApiKey,
          model: config.minimax.model,
          defaultMaxTokens: config.minimax.maxTokens,
          baseURL: 'https://api.minimax.io/anthropic',
          providerName: 'MiniMax',
        })
      }

      case 'teros': {
        if (!config.teros?.model) {
          throw new Error("Teros model is required")
        }

        const terosApiKey = await resolveTerosApiKey(config.teros)
        // baseUrl + actualProvider come from resolveTerosUpstream (TER-617/F3);
        // default to Fireworks for callers that don't set them (back-compat).
        const baseUrl = config.teros.baseUrl ?? 'https://api.fireworks.ai/inference/v1'
        const actualProvider = config.teros.actualProvider ?? 'fireworks'

        log.info(MODULE, "✅ Using Teros provider", {
          model: config.teros.model,
          actualProvider,
        })

        return new OpenAICompatibleLLMAdapter({
          baseUrl,
          apiKey: terosApiKey,
          model: config.teros.model,
          defaultMaxTokens: config.teros.maxTokens,
          actualProvider,
        })
      }

      case 'cloudflare': {
        if (!config.cloudflare?.model) {
          throw new Error("Cloudflare model is required")
        }
        if (!config.cloudflare?.accountId) {
          throw new Error("Cloudflare accountId is required")
        }

        const cfApiKey = await resolveCloudflareApiKey(config.cloudflare)
        const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${config.cloudflare.accountId}/ai/v1`

        log.info(MODULE, "✅ Using Cloudflare provider (user-owned Workers AI)", {
          model: config.cloudflare.model,
        })

        return new OpenAICompatibleLLMAdapter({
          baseUrl,
          apiKey: cfApiKey,
          model: config.cloudflare.model,
          defaultMaxTokens: config.cloudflare.maxTokens,
          actualProvider: 'cloudflare',
        })
      }

      case 'fireworks': {
        if (!config.fireworks?.model) {
          throw new Error("Fireworks model is required")
        }

        const fireworksApiKey = await resolveFireworksApiKey(config.fireworks)
        const baseUrl = 'https://api.fireworks.ai/inference/v1'

        log.info(MODULE, "✅ Using Fireworks AI provider (Zero Data Retention)", {
          model: config.fireworks.model,
        })

        return new OpenAICompatibleLLMAdapter({
          baseUrl,
          apiKey: fireworksApiKey,
          model: config.fireworks.model,
          defaultMaxTokens: config.fireworks.maxTokens,
          actualProvider: 'fireworks',
        })
      }

      case 'together': {
        if (!config.together?.model) {
          throw new Error("Together model is required")
        }

        const togetherApiKey = await resolveTogetherApiKey(config.together)
        const baseUrl = 'https://api.together.ai/v1'

        log.info(MODULE, "✅ Using Together AI provider", {
          model: config.together.model,
        })

        return new OpenAICompatibleLLMAdapter({
          baseUrl,
          apiKey: togetherApiKey,
          model: config.together.model,
          defaultMaxTokens: config.together.maxTokens,
          actualProvider: 'together',
        })
      }

      default:
        throw new Error(`Unknown LLM provider: ${config.provider}`)
    }
  }

  /**
   * Check what credentials are available
   * Note: API key availability is determined by user providers (DB) or SecretsManager,
   * not by environment variables. This only checks OAuth and Claude Code CLI.
   */
  static hasCredentials(): {
    oauth: boolean
    claudeCode: boolean
  } {
    return {
      oauth: hasOAuthTokens(),
      claudeCode: hasClaudeCodeCredentials(),
    }
  }

  /**
   * Get detailed information about available credentials
   */
  static async getCredentialsInfo(): Promise<{
    available: ("oauth" | "claude-code")[]
    recommended: "anthropic" | "anthropic-oauth" | null
    oauth?: {
      hasTokens: boolean
      isExpired: boolean
      expiresAt?: Date
    }
    claudeCode?: {
      hasCredentials: boolean
      isExpired: boolean
      expiresAt?: Date
    }
  }> {
    const available: ("oauth" | "claude-code")[] = []

    // Check OAuth
    let oauthInfo: { hasTokens: boolean; isExpired: boolean; expiresAt?: Date } | undefined
    const oauthTokens = await loadOAuthTokens()
    if (oauthTokens) {
      available.push("oauth")
      const isExpired = oauthTokens.expiresAt < Date.now()
      oauthInfo = {
        hasTokens: true,
        isExpired,
        expiresAt: new Date(oauthTokens.expiresAt),
      }
    }

    // Check Claude Code
    let claudeCodeInfo:
      | { hasCredentials: boolean; isExpired: boolean; expiresAt?: Date }
      | undefined
    const claudeCodeCreds = await loadClaudeCodeCredentials()
    if (claudeCodeCreds) {
      available.push("claude-code")
      const now = Math.floor(Date.now() / 1000)
      const isExpired = claudeCodeCreds.expiresAt ? claudeCodeCreds.expiresAt < now : false
      claudeCodeInfo = {
        hasCredentials: true,
        isExpired,
        expiresAt: claudeCodeCreds.expiresAt
          ? new Date(claudeCodeCreds.expiresAt * 1000)
          : undefined,
      }
    }

    // Determine recommended provider
    let recommended: "anthropic" | "anthropic-oauth" | null = null
    if (available.includes("claude-code")) {
      recommended = "anthropic"
    } else if (available.includes("oauth")) {
      recommended = "anthropic-oauth"
    }

    return {
      available,
      recommended,
      oauth: oauthInfo,
      claudeCode: claudeCodeInfo,
    }
  }

  /**
   * Start OAuth authentication flow
   *
   * @example
   * ```typescript
   * // Step 1: Get auth URL
   * const { url, verifier } = LLMClientFactory.startOAuthFlow()
   * console.log('Open this URL:', url)
   *
   * // Step 2: User logs in and gets callback URL
   *
   * // Step 3: Complete the flow
   * const success = await LLMClientFactory.completeOAuthFlow(callbackUrl, verifier)
   * ```
   */
  static startOAuthFlow(): { url: string; verifier: string } {
    return generateAuthorizationUrl()
  }

  /**
   * Complete OAuth authentication flow
   */
  static async completeOAuthFlow(callbackUrl: string, verifier: string): Promise<boolean> {
    const tokens = await exchangeCodeForTokens(callbackUrl, verifier)
    return tokens !== null
  }
}
