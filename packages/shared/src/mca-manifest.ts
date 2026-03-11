/**
 * MCA Manifest Schema
 *
 * Defines the structure and validation for MCA manifest.json files.
 * This is the source of truth for what an MCA can declare.
 *
 * IMPORTANT: This schema must be kept in sync with:
 * - mcas/<mca-id>/manifest.json files
 * - packages/backend/src/scripts/sync-mcas.ts
 * - Database mca_catalog collection structure
 */

import { z } from 'zod';

// ============================================================================
// AUTHOR
// ============================================================================

export const MCAAuthorSchema = z.object({
  name: z.string().min(1, 'Author name is required'),
  email: z.string().email('Invalid email format').optional(),
  url: z.string().url('Invalid URL format').optional(),
});
export type MCAAuthor = z.infer<typeof MCAAuthorSchema>;

// ============================================================================
// AVAILABILITY
// ============================================================================

export const MCARoleSchema = z.enum(['user', 'admin', 'super']);
export type MCARole = z.infer<typeof MCARoleSchema>;

export const MCAAvailabilitySchema = z.object({
  /** Whether the MCA is enabled and can be used */
  enabled: z.boolean(),
  /** Whether multiple instances can be created (e.g., multiple Gmail accounts) */
  multi: z.boolean(),
  /** Whether this is a system MCA (auto-installed, cannot be uninstalled) */
  system: z.boolean(),
  /** Whether to hide from the App Store catalog */
  hidden: z.boolean().default(false),
  /** Minimum role required to use this MCA */
  role: MCARoleSchema,
});
export type MCAAvailability = z.infer<typeof MCAAvailabilitySchema>;

// ============================================================================
// AUTH CONFIGURATION
// ============================================================================

export const MCAAuthTypeSchema = z.enum(['oauth2', 'api-key', 'none']);
export type MCAAuthType = z.infer<typeof MCAAuthTypeSchema>;

// Base auth schema
const MCAAuthBaseSchema = z.object({
  type: MCAAuthTypeSchema,
  /** System-level secrets (OAuth client credentials, shared API keys) */
  systemSecrets: z.array(z.string()).optional(),
  /** User-level secrets (OAuth tokens, personal API keys) */
  userSecrets: z.array(z.string()).optional(),
});

// OAuth2 specific fields
const MCAAuthOAuth2Schema = MCAAuthBaseSchema.extend({
  type: z.literal('oauth2'),
  /** OAuth provider identifier (e.g., 'google', 'microsoft') */
  provider: z.string().optional(),
  /** OAuth2 authorization URL */
  authorizeUrl: z.string().url('Invalid authorize URL'),
  /** OAuth2 token exchange URL */
  tokenUrl: z.string().url('Invalid token URL'),
  /** OAuth2 scopes to request */
  scopes: z.array(z.string()).min(1, 'At least one scope is required for OAuth2'),
  /** Whether to use PKCE (for public clients without client_secret) */
  pkce: z.boolean().default(false),
  /** Required system secrets for OAuth2 */
  systemSecrets: z
    .array(z.string())
    .refine(
      (secrets) => secrets.includes('CLIENT_ID') && secrets.includes('CLIENT_SECRET'),
      'OAuth2 requires CLIENT_ID and CLIENT_SECRET in systemSecrets',
    ),
  /** Required user secrets for OAuth2 */
  userSecrets: z
    .array(z.string())
    .refine(
      (secrets) => secrets.includes('ACCESS_TOKEN') && secrets.includes('REFRESH_TOKEN'),
      'OAuth2 requires ACCESS_TOKEN and REFRESH_TOKEN in userSecrets',
    ),
});

// API Key specific fields (validation done in refinement below)
const MCAAuthApiKeySchema = MCAAuthBaseSchema.extend({
  type: z.literal('api-key'),
});

// No auth
const MCAAuthNoneSchema = MCAAuthBaseSchema.extend({
  type: z.literal('none'),
});

// Combined auth schema with discriminated union
const MCAAuthSchemaBase = z.discriminatedUnion('type', [
  MCAAuthOAuth2Schema,
  MCAAuthApiKeySchema,
  MCAAuthNoneSchema,
]);

// Add refinement for api-key validation
export const MCAAuthSchema = MCAAuthSchemaBase.refine((auth) => {
  if (auth.type !== 'api-key') return true;
  return (auth.systemSecrets?.length ?? 0) + (auth.userSecrets?.length ?? 0) > 0;
}, 'api-key auth requires at least one secret (systemSecrets or userSecrets)');
export type MCAAuth = z.infer<typeof MCAAuthSchema>;

// ============================================================================
// LAYERS
// ============================================================================

export const MCALayersSchema = z.object({
  /** Whether this MCA provides tools */
  tools: z.boolean(),
  /** Whether this MCA can receive/emit events */
  events: z.boolean().default(false),
  /** Whether this MCA has UI components */
  ui: z.boolean().default(false),
  /** Whether this MCA has custom permissions */
  permissions: z.boolean().default(false),
  /** Auth configuration (can be boolean false or full config) */
  auth: z.union([z.literal(false), MCAAuthSchema]),
  /** Whether this MCA is an agent (can create conversations) */
  agent: z.boolean().default(false),
});
export type MCALayers = z.infer<typeof MCALayersSchema>;

// ============================================================================
// RUNTIME
// ============================================================================

export const MCATransportSchema = z.enum(['http', 'stdio']);
export type MCATransport = z.infer<typeof MCATransportSchema>;

export const MCAContainerModeSchema = z.enum(['shared', 'per-app']);
export type MCAContainerMode = z.infer<typeof MCAContainerModeSchema>;

export const MCARuntimeSchema = z.object({
  /** Transport type: 'http' for containers, 'stdio' for local processes */
  transport: MCATransportSchema,
  /** Container port (default: 3000) */
  port: z.number().int().min(1).max(65535).default(3000),
  /** Health check endpoint (default: '/health') */
  healthCheck: z.string().default('/health'),
  /**
   * Container mode for HTTP transport:
   * - 'shared': One container per MCA, shared across all users (default)
   * - 'per-app': One container per installed app instance (REQUIRED for user-specific credentials)
   */
  containerMode: MCAContainerModeSchema.default('shared'),
  /**
   * Custom Docker image for this MCA.
   * If not specified, uses the default 'teros/mca-runtime' image.
   * Example: 'teros/mca-runtime-playwright' for MCAs requiring browser support.
   */
  dockerImage: z.string().optional(),
  /**
   * System-level volume mounts added to the container at launch.
   * Use sparingly — only for trusted MCAs that need host access (e.g., Docker socket).
   */
  systemVolumes: z
    .array(
      z.object({
        hostPath: z.string(),
        containerPath: z.string(),
        readOnly: z.boolean().optional(),
      }),
    )
    .optional(),
  /**
   * Additional environment variables injected at container launch time.
   * Merged with the standard MCA environment variables.
   */
  systemEnvironment: z.record(z.string()).optional(),
});
export type MCARuntime = z.infer<typeof MCARuntimeSchema>;

// ============================================================================
// MCA TYPE & CATEGORY
// ============================================================================

export const MCATypeSchema = z.enum([
  'integration', // External service integration (Gmail, Slack, etc.)
  'utility', // Utility tools (bash, filesystem, etc.)
  'system', // System/internal MCAs
  'ai', // AI-powered tools (Perplexity, etc.)
]);
export type MCAType = z.infer<typeof MCATypeSchema>;

export const MCACategorySchema = z.enum([
  'productivity',
  'communication',
  'development',
  'system',
  'ai',
  'data',
  'media',
  'design',
  'storage',
  'utility',
  'other',
]);
export type MCACategory = z.infer<typeof MCACategorySchema>;

// ============================================================================
// MCA ID FORMAT
// ============================================================================

/**
 * MCA ID format: mca.<name> or mca.<vendor>.<name> or deeper nesting
 * Examples:
 * - mca.canva (single level)
 * - mca.teros.bash (vendor + name)
 * - mca.google.gmail (vendor + name)
 * - mca.teros.admin.filesystem (nested)
 */
export const MCA_ID_REGEX = /^mca\.[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

// ============================================================================
// FULL MANIFEST SCHEMA
// ============================================================================

export const MCAManifestSchema = z.object({
  /** JSON Schema reference (optional, for editor support) */
  $schema: z.string().optional(),

  // --- Required fields ---

  /** Unique identifier (e.g., 'mca.canva', 'mca.google.gmail', 'mca.teros.bash') */
  id: z.string().regex(MCA_ID_REGEX, {
    message:
      'ID must start with mca. followed by lowercase segments (e.g., mca.canva, mca.google.gmail)',
  }),

  /** Display name */
  name: z.string().min(1, 'Name is required').max(50, 'Name too long (max 50 chars)'),

  /** Semantic version */
  version: z.string().regex(/^\d+\.\d+\.\d+$/, {
    message: 'Version must be semantic (e.g., 1.0.0)',
  }),

  /** Description of what the MCA does */
  description: z
    .string()
    .min(10, 'Description too short (min 10 chars)')
    .max(500, 'Description too long (max 500 chars)'),

  /** MCA type */
  type: MCATypeSchema,

  /** Icon filename (relative to MCA directory) or full URL */
  icon: z.string().min(1, 'Icon is required'),

  /** Category for grouping */
  category: MCACategorySchema,

  /** Entry point file relative to manifest */
  entrypoint: z.string().min(1, 'Entrypoint is required'),

  /** Author information */
  author: MCAAuthorSchema,

  /** Availability configuration */
  availability: MCAAvailabilitySchema,

  /** Layers configuration - what capabilities this MCA provides */
  layers: MCALayersSchema,

  // --- Optional fields ---

  /** Runtime configuration (required for HTTP transport MCAs) */
  runtime: MCARuntimeSchema.optional(),

  /** Search keywords */
  keywords: z.array(z.string()).optional(),

  /** Theme color (hex) */
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Color must be hex format (e.g., #FF5733)')
    .optional(),

  /** Logo/avatar image URL */
  image: z.string().url().optional(),

  /** Background/hero image URL */
  backgroundImage: z.string().url().optional(),
});

// ============================================================================
// REFINED MANIFEST WITH CROSS-FIELD VALIDATION
// ============================================================================

export const MCAManifestRefinedSchema = MCAManifestSchema.superRefine((manifest, ctx) => {
  // Rule 1: HTTP transport MCAs must have runtime config
  if (!manifest.runtime) {
    // Default to HTTP if not specified, but require runtime config
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'runtime configuration is required',
      path: ['runtime'],
    });
    return; // Can't validate further without runtime
  }

  // Rule 2: MCAs with OAuth2 or API key auth MUST use per-app container mode
  const auth = manifest.layers.auth;
  if (auth !== false && auth.type !== 'none') {
    if (manifest.runtime.transport === 'http' && manifest.runtime.containerMode !== 'per-app') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `MCAs with ${auth.type} authentication MUST use containerMode: "per-app" to prevent credential leakage between users`,
        path: ['runtime', 'containerMode'],
      });
    }
  }

  // Rule 3: Multi-instance MCAs should use per-app mode
  if (
    manifest.availability.multi &&
    manifest.runtime.transport === 'http' &&
    manifest.runtime.containerMode !== 'per-app'
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'MCAs with multi: true should use containerMode: "per-app" to isolate instances',
      path: ['runtime', 'containerMode'],
    });
  }

  // Rule 4: System MCAs should be hidden or have explicit reason
  if (
    manifest.availability.system &&
    !manifest.availability.hidden &&
    manifest.availability.role === 'user'
  ) {
    // This is a warning, not an error - system MCAs visible to users might be intentional
    // But we could add a soft warning here
  }

  // Rule 5: Entrypoint must have valid extension
  const validExtensions = ['.ts', '.js', '.mjs'];
  const hasValidExtension = validExtensions.some((ext) => manifest.entrypoint.endsWith(ext));
  if (!hasValidExtension) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Entrypoint must end with ${validExtensions.join(', ')}`,
      path: ['entrypoint'],
    });
  }
});

export type MCAManifest = z.infer<typeof MCAManifestSchema>;

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

export interface MCAValidationResult {
  valid: boolean;
  errors: MCAValidationError[];
  warnings: MCAValidationWarning[];
  manifest?: MCAManifest;
}

export interface MCAValidationError {
  path: string;
  message: string;
  code: string;
}

export interface MCAValidationWarning {
  path: string;
  message: string;
}

/**
 * Parse and validate an MCA manifest with full cross-field validation
 * @throws ZodError if validation fails
 */
export function parseMCAManifest(data: unknown): MCAManifest {
  return MCAManifestRefinedSchema.parse(data);
}

/**
 * Safely parse an MCA manifest, returning result object
 */
export function safeParseMCAManifest(data: unknown): z.SafeParseReturnType<unknown, MCAManifest> {
  return MCAManifestRefinedSchema.safeParse(data);
}

/**
 * Type guard for MCA manifest
 */
export function isMCAManifest(data: unknown): data is MCAManifest {
  return MCAManifestRefinedSchema.safeParse(data).success;
}

/**
 * Validate manifest and return detailed results with errors and warnings
 */
export function validateMCAManifest(data: unknown): MCAValidationResult {
  const result = MCAManifestRefinedSchema.safeParse(data);
  const warnings: MCAValidationWarning[] = [];

  if (result.success) {
    // Check for warnings (non-blocking issues)
    const manifest = result.data;

    // Warning: System MCA visible to regular users
    if (
      manifest.availability.system &&
      !manifest.availability.hidden &&
      manifest.availability.role === 'user'
    ) {
      warnings.push({
        path: 'availability',
        message:
          'System MCA is visible to regular users. Consider setting hidden: true or role: admin',
      });
    }

    // Warning: No keywords
    if (!manifest.keywords || manifest.keywords.length === 0) {
      warnings.push({
        path: 'keywords',
        message: 'No keywords defined. Adding keywords improves discoverability',
      });
    }

    return {
      valid: true,
      errors: [],
      warnings,
      manifest: result.data,
    };
  }

  const errors: MCAValidationError[] = result.error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
    code: issue.code,
  }));

  return { valid: false, errors, warnings };
}

/**
 * Format validation result for CLI output
 */
export function formatValidationResult(mcaId: string, result: MCAValidationResult): string {
  const lines: string[] = [];

  if (result.valid) {
    lines.push(`✅ ${mcaId}: Valid`);
    if (result.warnings.length > 0) {
      lines.push(`   ⚠️  ${result.warnings.length} warning(s):`);
      result.warnings.forEach((w) => {
        lines.push(`      - ${w.path}: ${w.message}`);
      });
    }
  } else {
    lines.push(`❌ ${mcaId}: Invalid`);
    lines.push(`   ${result.errors.length} error(s):`);
    result.errors.forEach((e) => {
      lines.push(`      - ${e.path}: ${e.message}`);
    });
  }

  return lines.join('\n');
}
