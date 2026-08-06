/**
 * MCA Authentication Types
 *
 * Types for MCA credential management and authentication status.
 */

/**
 * Estado de configuracion de credenciales de una app
 */
export type AppCredentialStatus =
  | 'ready' // Todas las credenciales configuradas y validas
  | 'needs_system_setup' // Falta configurar systemSecrets (requiere admin)
  | 'needs_user_auth' // Falta autenticacion del usuario
  | 'expired' // Token OAuth expirado
  | 'error' // Error al validar credenciales
  | 'not_required'; // MCA no requiere credenciales

/**
 * Tipo de autenticacion que requiere la MCA
 */
export type McaAuthType = 'oauth2' | 'apikey' | 'none' | 'github-app' | 'agent';

/**
 * Información para auth `github-app` (server-to-server). El user instala
 * la Teros App en sus repos y GitHub redirige al Setup URL con
 * `installation_id`. Identidad: `Teros[bot]`.
 */
export interface GitHubAppInfo {
  /** Si hay una installation activa para este user+app. */
  installed: boolean;
  /** Slug público de la App (`https://github.com/apps/<slug>`). */
  appSlug: string;
  /** ID de la installation (cuando connected). */
  installationId?: string;
  /** Cuenta donde está instalada (user/org login). */
  account?: string;
  /** Número de repos accesibles via la installation. */
  repositoryCount?: number;
  /** URL de gestión en github.com (revoke / change repos / change permissions). */
  manageUrl?: string;
}

/**
 * Campo de configuracion para API key
 */
export interface ApiKeyField {
  /** Nombre interno del campo (e.g., "APIKEY") */
  name: string;
  /** Label para mostrar en UI (e.g., "API Key") */
  label: string;
  /** Tipo de input */
  type: 'text' | 'password';
  /** Si es requerido */
  required: boolean;
  /** Placeholder opcional */
  placeholder?: string;
  /** Hint/ayuda opcional */
  hint?: string;
  /** Valor actual del campo (solo en extraFields de OAuth, poblado desde credenciales) */
  value?: string;
}

/**
 * Informacion de autenticacion OAuth
 */
export interface OAuthInfo {
  /** Proveedor OAuth (e.g., 'google', 'github') */
  provider: string;
  /** Si hay una cuenta conectada */
  connected: boolean;
  /** Email/cuenta conectada (si connected) */
  email?: string;
  /**
   * Login/handle del proveedor cuando aplica (e.g. GitHub `login`,
   * Notion `name`). Para `github-app` con userOAuth, se prefiere mostrar
   * `@${userLogin}` en la UI sobre el email.
   */
  userLogin?: string;
  /** Fecha de expiracion del token (ISO string) */
  expiresAt?: string;
  /** Scopes autorizados */
  scopes?: string[];
  /**
   * Campos extra configurables por el usuario en apps OAuth.
   * Permiten añadir configuracion adicional (e.g., TEAM_ID en Figma)
   * sin romper el flujo OAuth.
   */
  extraFields?: ApiKeyField[];
}

/**
 * Informacion de autenticacion por API key
 */
export interface ApiKeyInfo {
  /** Si hay credenciales configuradas */
  configured: boolean;
  /** Campos requeridos para configurar */
  fields: ApiKeyField[];
}

/**
 * Informacion completa de autenticacion de una app instalada
 */
export interface AppAuthInfo {
  /** Estado actual de las credenciales */
  status: AppCredentialStatus;
  /** Tipo de autenticacion requerida */
  authType: McaAuthType;
  /** Info especifica para OAuth */
  oauth?: OAuthInfo;
  /** Info especifica para API key */
  apikey?: ApiKeyInfo;
  /** Info especifica para GitHub App (server-to-server install). */
  githubApp?: GitHubAppInfo;
  /** Mensaje legible para UI */
  message?: string;
  /** Detalles del error (si status es 'error') */
  error?: string;
}

/**
 * Configuracion OAuth en el manifest de una MCA
 */
export interface McaOAuthConfig {
  /** Tipo de auth (siempre 'oauth2' para OAuth) */
  type: 'oauth2';
  /** Proveedor conocido (simplifica config) */
  provider?: string;
  /** URL de autorizacion */
  authorizeUrl: string;
  /** URL para intercambiar code por tokens */
  tokenUrl: string;
  /** Scopes requeridos */
  scopes: string[];
  /** Si usa PKCE */
  pkce: boolean;
}

/**
 * Estado OAuth almacenado durante el flujo
 */
export interface McaOAuthState {
  /** ID de la app */
  appId: string;
  /** ID del usuario */
  userId: string;
  /** ID de la MCA */
  mcaId: string;
  /** Proveedor OAuth */
  provider: string;
  /** Token CSRF */
  state: string;
  /** Fecha de expiracion */
  expiresAt: Date;
  /** Fecha de creacion */
  createdAt: Date;
}

/**
 * Respuesta de intercambio de tokens OAuth
 */
export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/**
 * Credenciales de usuario almacenadas (post-OAuth o API key)
 */
export interface UserCredentials {
  /** Token de acceso (OAuth) */
  ACCESS_TOKEN?: string;
  /** Token de refresh (OAuth) */
  REFRESH_TOKEN?: string;
  /** Email de la cuenta (OAuth) */
  EMAIL?: string;
  /** Fecha de expiracion (ISO string) */
  EXPIRY_DATE?: string;
  /** API key (para auth tipo apikey) */
  APIKEY?: string;
  /** Campos adicionales dinamicos */
  [key: string]: string | undefined;
}
