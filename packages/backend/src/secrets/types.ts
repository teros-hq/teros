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

export interface EmailSecret {
  resendApiKey: string
}

export interface TranscriptionSecret {
  /** Provider to use: 'whisper' (OpenAI) or 'elevenlabs' */
  provider: "whisper" | "elevenlabs"
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
}

// Registry of MCA secrets (for type-safety)
export interface MCASecretsRegistry {
  "mca.teros.perplexity": PerplexitySecret
  "mca.teros.gmail": GmailSecret
}
