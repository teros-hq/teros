/**
 * Type definitions for secrets
 */

// System secrets
export interface AnthropicSecret {
  apiKey: string
}

export interface OpenAISecret {
  apiKey: string
}

export interface DatabaseSecret {
  uri: string
  database: string
}

export interface AuthSecret {
  sessionTokenSecret: string
}

export interface MCASecret {
  /** Shared secret for internal service-to-service authentication (e.g., scheduler to /api/event) */
  internalToken: string
}

export interface EncryptionSecret {
  masterKey: string // System encryption key for user keys
}

export interface GoogleOAuthSecret {
  clientId: string
  clientSecret: string
  redirectUri?: string // Optional, can use default
}

export interface OAuthConfigSecret {
  google?: GoogleOAuthSecret
  github?: {
    clientId: string
    clientSecret: string
  }
  microsoft?: {
    clientId: string
    clientSecret: string
    tenantId?: string
  }
  /** URL of the frontend app (for OAuth redirects) */
  appUrl?: string
  /** URL of the backend API (for OAuth callbacks) */
  backendUrl?: string
}

export interface AnthropicOAuthSecret {
  access_token: string
  refresh_token: string
  expires_at: number
  token_type: string
  created_at?: number
}

export interface ElevenLabsSecret {
  apiKey: string
}

export interface AdminSecret {
  apiKey: string
}

export interface LatitudeSecret {
  apiKey: string
  projectSlug: string
}

export interface EmailSecret {
  resendApiKey: string
}

export interface TranscriptionSecret {
  /** Provider to use: 'whisper' (OpenAI) or 'elevenlabs' */
  provider: "whisper" | "elevenlabs"
}

export interface FireworksSecret {
  apiKey: string
}

/**
 * Together AI system secret — the failover upstream for the `teros` provider
 * (TER-617/F3). Same shape as Fireworks (Together is OpenAI-compatible).
 * Provisioned in prod via `.secrets/system/together.json` (auto-discovered at
 * boot). The fallback only routes here when ZDR is asserted (see the resolver's
 * `resolveRetention` guard).
 */
export interface TogetherSecret {
  apiKey: string
}

export interface StripeSecret {
  /** Stripe secret API key (sk_live_… / sk_test_…). */
  secretKey: string
  /** Signing secret for the /webhooks/stripe endpoint (whsec_…). */
  webhookSecret: string
  /**
   * Publishable key (pk_live_… / pk_test_…). NOT secret — returned to the
   * frontend so it can initialize Stripe.js / Elements for vaulting.
   */
  publishableKey?: string
  /**
   * Optional pinned Stripe API version. Omit to use the SDK's bundled default
   * (the version its TypeScript types were generated for). Only set this to a
   * value the installed SDK supports.
   */
  apiVersion?: string
}

// MCA secrets
export interface PerplexitySecret {
  apiKey: string
}

export interface GmailSecret {
  clientId: string
  clientSecret: string
  redirectUri: string
}

// Registry of system secrets (for type-safety)
export interface SystemSecretsRegistry {
  admin: AdminSecret
  latitude: LatitudeSecret
  anthropic: AnthropicSecret
  "anthropic-oauth": AnthropicOAuthSecret
  openai: OpenAISecret
  elevenlabs: ElevenLabsSecret
  email: EmailSecret
  transcription: TranscriptionSecret
  database: DatabaseSecret
  auth: AuthSecret
  encryption: EncryptionSecret
  oauth: OAuthConfigSecret
  mca: MCASecret
  fireworks: FireworksSecret
  together: TogetherSecret
  stripe: StripeSecret
}

// Registry of MCA secrets (for type-safety)
export interface MCASecretsRegistry {
  "mca.teros.perplexity": PerplexitySecret
  "mca.teros.gmail": GmailSecret
}
