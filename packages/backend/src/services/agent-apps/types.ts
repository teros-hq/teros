/**
 * Agent Apps Adapter — Types
 *
 * Self-contained type definitions. ZERO external dependencies.
 * This module can be extracted to its own package without changes.
 */

// ---------------------------------------------------------------------------
// Station configuration
// ---------------------------------------------------------------------------

/** Configuration for a single Agent Apps station endpoint. */
export interface StationEndpoint {
  /** Unique identifier for this station (e.g., 'eu-west-github', 'us-east-slack') */
  id: string;
  /** HTTP URL of the station (e.g., 'http://station-a:3000') */
  url: string;
  /** Bearer token for this station (overrides global token) */
  token?: string;
  /** Which app IDs this station serves (empty = accepts any) */
  appIds?: string[];
  /** Which workspace IDs this station serves (empty = accepts any) */
  workspaceIds?: string[];
  /** Region/location tag for routing affinity (e.g., 'eu-west-1') */
  region?: string;
  /** Weight for load balancing (default: 1). Higher = more traffic. */
  weight?: number;
  /** Maximum concurrent sessions on this station */
  maxSessions?: number;
}

/** Top-level adapter configuration. */
export interface AgentAppsConfig {
  /** All known station endpoints */
  stations: StationEndpoint[];
  /** Global bearer token (used when station.token is not set) */
  globalToken?: string;
  /** Host identity sent during protocol handshake */
  host: { name: string; version: string };
  /** Platform capabilities advertised during handshake */
  capabilities?: { directConnection?: boolean; platformActions?: string[] };
  /** Timeouts */
  timeouts?: {
    /** Handshake timeout (ms, default: 30_000) */
    initializeMs?: number;
    /** Session open timeout (ms, default: 30_000) */
    sessionOpenMs?: number;
    /** Tool call timeout (ms, default: 60_000) */
    toolCallMs?: number;
    /** list_tools timeout (ms, default: 10_000) */
    listToolsMs?: number;
    /** Health check timeout (ms, default: 10_000) */
    healthCheckMs?: number;
  };
  /** Session pool settings */
  sessions?: {
    /** Idle timeout before closing a session (ms, default: 30 min) */
    idleTimeoutMs?: number;
    /** How often to sweep idle sessions (ms, default: 5 min) */
    cleanupIntervalMs?: number;
  };
  /** Station health settings */
  health?: {
    /** How often to ping stations (ms, default: 60_000) */
    pingIntervalMs?: number;
    /** Mark station unhealthy after N consecutive failures (default: 3) */
    failureThreshold?: number;
    /** Mark station healthy after N consecutive successes (default: 1) */
    recoveryThreshold?: number;
  };
  /** Optional logging adapter (default: console) */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Protocol messages
// ---------------------------------------------------------------------------

export interface ProtocolMessage {
  id: string;
  type: string;
  timestamp: string;
  version: string;
  sessionId?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export interface ToolAnnotations {
  version?: string;
  stability?: 'experimental' | 'stable' | 'deprecated';
  deprecationMessage?: string;
  irreversible?: boolean;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  /** UI-specific: always prompt user before executing */
  alwaysAsk?: boolean;
}

export interface RawToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

export interface ToolCallContext {
  userId?: string;
  workspaceId?: string;
  installationId: string;
  channelId?: string;
  agentId?: string;
  requestId?: string;
  userDisplayName?: string;
  userAvatarUrl?: string;
}

export interface ToolCallResult {
  success: boolean;
  output: string;
  attachments?: Array<{ url: string; mime: string; filename?: string }>;
  duration?: number;
  error?: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface HealthIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  action?: { type: 'link' | 'oauth'; url: string; label: string };
}

export type HealthStatus = 'ready' | 'not_ready' | 'degraded';

export interface InstanceHealth {
  status: HealthStatus;
  message?: string;
  issues?: HealthIssue[];
  version?: string;
  uptime?: number;
  checkedAt: Date;
}

// ---------------------------------------------------------------------------
// Station state
// ---------------------------------------------------------------------------

export type StationState = 'unknown' | 'healthy' | 'degraded' | 'unhealthy';

export interface StationStatus {
  id: string;
  url: string;
  state: StationState;
  region?: string;
  /** App info from last successful handshake */
  negotiatedVersion?: string;
  appId?: string;
  appVersion?: string;
  /** Number of active sessions on this station */
  activeSessions: number;
  maxSessions?: number;
  /** Consecutive health failures */
  consecutiveFailures: number;
  lastSuccessAt?: Date;
  lastFailureAt?: Date;
  lastError?: string;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface SessionInfo {
  sessionId: string;
  appId: string;
  workspaceId?: string;
  stationId: string;
  stationUrl: string;
  tools: RawToolDefinition[];
  status: 'active' | 'idle' | 'error' | 'closed';
  lastUsedAt: Date;
  createdAt: Date;
  lastError?: string;
}

// ---------------------------------------------------------------------------
// Discovered app (catalog sync)
// ---------------------------------------------------------------------------

export interface DiscoveredApp {
  appId: string;
  name: string;
  version: string;
  tools: RawToolDefinition[];
  stationId: string;
  stationUrl: string;
}

// ---------------------------------------------------------------------------
// Station → Host push announcements
// ---------------------------------------------------------------------------

/** Payload a station sends when it has new/updated apps. */
export interface AnnouncePayload {
  /** Station's self-identified ID (must match a registered station or be auto-registered) */
  stationId: string;
  /** Station's URL (for auto-registration when station is new) */
  stationUrl: string;
  /** Region tag (optional, for auto-registration) */
  region?: string;
  /** Apps available on this station */
  apps: AnnounceApp[];
}

export interface AnnounceApp {
  appId: string;
  name: string;
  version: string;
  description?: string;
  category?: string;
  icon?: string;
  tagline?: string;
  author?: { name: string; email?: string; url?: string };
  keywords?: string[];
  tools: RawToolDefinition[];
}

/** Result returned after processing an announcement. */
export interface AnnounceResult {
  accepted: number;
  rejected: Array<{ appId: string; reason: string }>;
  /** Whether a new station was auto-registered */
  stationRegistered: boolean;
}

// ---------------------------------------------------------------------------
// UI Resources
// ---------------------------------------------------------------------------

/**
 * A UI resource definition as declared by an app.
 * Static metadata — the handler lives in the SDK, not here.
 */
export interface RawUiResourceDefinition {
  /** Unique name within the app (e.g. 'repo-tree', 'issue-detail') */
  name: string;
  /** Resource type — determines how the host renders the result */
  resourceType: 'tree' | 'detail' | 'form';
  /** Human-readable description */
  description: string;
  /** JSON Schema for parameters the handler accepts */
  parameters?: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Tools this resource is associated with */
  boundTools?: string[];
  /** Events that trigger a refresh of this resource */
  refreshOnEvents?: string[];
}

/** The renderable data returned by a UI resource handler */
export type UiResourceData =
  | { type: 'tree'; nodes: TreeNode[]; title?: string; multiSelect?: boolean }
  | {
      type: 'detail';
      title?: string;
      subtitle?: string;
      sections: DetailSection[];
      imageUrl?: string;
      badge?: string;
    }
  | {
      type: 'form';
      title?: string;
      description?: string;
      fields: UiFormField[];
      submitLabel?: string;
      cancelLabel?: string;
      submitTool?: string;
    };

/** A single node in a tree view */
export interface TreeNode {
  id: string;
  label: string;
  icon?: string;
  badge?: string;
  expanded?: boolean;
  children?: TreeNode[];
  meta?: Record<string, unknown>;
}

/** A field in a detail panel */
export interface DetailField {
  label: string;
  value: string | number | boolean;
  type?: 'text' | 'code' | 'date' | 'url' | 'markdown' | 'image';
  linkText?: string;
  alt?: string;
}

/** A section within a detail panel */
export interface DetailSection {
  title?: string;
  fields: DetailField[];
  icon?: string;
}

/** A field in a form */
export interface UiFormField {
  name: string;
  label: string;
  fieldType:
    | 'text'
    | 'textarea'
    | 'number'
    | 'select'
    | 'checkbox'
    | 'radio'
    | 'date'
    | 'time'
    | 'datetime';
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  defaultValue?: string | number | boolean;
  helpText?: string;
  required?: boolean;
  min?: number;
  max?: number;
  pattern?: string;
}

/** Result of a form submission */
export interface UiResourceSubmitResult {
  success: boolean;
  message?: string;
}

// ---------------------------------------------------------------------------
// Host Callbacks — station → host requests (storage, files, lifecycle)
// ---------------------------------------------------------------------------

/** A callback request sent from a station to the host. */
export type CallbackRequest =
  | StorageCallbackRequest
  | FileCallbackRequest
  | LifecycleCallbackRequest;

export type CallbackResponse =
  | StorageCallbackResponse
  | FileCallbackResponse
  | LifecycleCallbackResponse;

// --- Document Store (storage_put/get/query/update/delete) ---

export interface StoragePutRequest {
  type: 'storage_put';
  installationId: string;
  collection: string;
  documentId: string;
  document: Record<string, unknown>;
}
export interface StoragePutResponse {
  success: boolean;
  documentId: string;
  error?: string;
}

export interface StorageGetRequest {
  type: 'storage_get';
  installationId: string;
  collection: string;
  documentId: string;
}
export interface StorageGetResponse {
  success: boolean;
  document: Record<string, unknown> | null;
  error?: string;
}

export interface StorageQueryRequest {
  type: 'storage_query';
  installationId: string;
  collection: string;
  filter?: Record<string, unknown>;
  limit?: number;
  cursor?: string;
}
export interface StorageQueryResponse {
  success: boolean;
  documents: Record<string, unknown>[];
  nextCursor?: string;
  error?: string;
}

export interface StorageUpdateRequest {
  type: 'storage_update';
  installationId: string;
  collection: string;
  documentId: string;
  patch: Record<string, unknown>;
}
export interface StorageUpdateResponse {
  success: boolean;
  document: Record<string, unknown> | null;
  error?: string;
}

export interface StorageDeleteRequest {
  type: 'storage_delete';
  installationId: string;
  collection: string;
  documentId: string;
}
export interface StorageDeleteResponse {
  success: boolean;
  error?: string;
}

export type StorageCallbackRequest =
  | StoragePutRequest
  | StorageGetRequest
  | StorageQueryRequest
  | StorageUpdateRequest
  | StorageDeleteRequest;

export type StorageCallbackResponse =
  | StoragePutResponse
  | StorageGetResponse
  | StorageQueryResponse
  | StorageUpdateResponse
  | StorageDeleteResponse;

// --- Object Storage (file_object_put/get/delete/list) ---
// Blob store: system generates objectId, URLs are public and permanent.

export interface FileObjectPutRequest {
  type: 'file_object_put';
  installationId: string;
  data: string; // base64-encoded
  contentType?: string;
  metadata?: Record<string, string>;
}
export interface FileObjectPutResponse {
  success: boolean;
  objectId: string;
  url: string;
  error?: string;
}

export interface FileObjectGetRequest {
  type: 'file_object_get';
  installationId: string;
  objectId: string;
}
export interface FileObjectGetResponse {
  success: boolean;
  data: string | null; // base64-encoded
  contentType?: string;
  metadata?: Record<string, string>;
  error?: string;
}

export interface FileObjectDeleteRequest {
  type: 'file_object_delete';
  installationId: string;
  objectId: string;
}
export interface FileObjectDeleteResponse {
  success: boolean;
  error?: string;
}

export interface FileObjectListRequest {
  type: 'file_object_list';
  installationId: string;
}
export interface FileObjectListResponse {
  success: boolean;
  objects: Array<{ objectId: string; size: number; contentType?: string; createdAt?: string }>;
  error?: string;
}

// --- Volume Storage (file_volume_readDir/readFile/writeFile/delete/stat) ---

export interface FileVolumeReadDirRequest {
  type: 'file_volume_read_dir';
  installationId: string;
  workspaceId: string;
  path: string;
}
export interface FileVolumeReadDirResponse {
  success: boolean;
  entries: Array<{ name: string; type: 'file' | 'directory'; size?: number }>;
  error?: string;
}

export interface FileVolumeReadFileRequest {
  type: 'file_volume_read_file';
  installationId: string;
  workspaceId: string;
  path: string;
}
export interface FileVolumeReadFileResponse {
  success: boolean;
  data: string | null; // base64-encoded
  error?: string;
}

export interface FileVolumeWriteFileRequest {
  type: 'file_volume_write_file';
  installationId: string;
  workspaceId: string;
  path: string;
  data: string; // base64-encoded
}
export interface FileVolumeWriteFileResponse {
  success: boolean;
  error?: string;
}

export interface FileVolumeDeleteRequest {
  type: 'file_volume_delete';
  installationId: string;
  workspaceId: string;
  path: string;
  recursive?: boolean;
}
export interface FileVolumeDeleteResponse {
  success: boolean;
  error?: string;
}

export interface FileVolumeStatRequest {
  type: 'file_volume_stat';
  installationId: string;
  workspaceId: string;
  path: string;
}
export interface FileVolumeStatResponse {
  success: boolean;
  stat: { size: number; isDirectory: boolean; modifiedAt: string } | null;
  error?: string;
}

export interface FileVolumeMkdirRequest {
  type: 'file_volume_mkdir';
  installationId: string;
  workspaceId: string;
  path: string;
}
export interface FileVolumeMkdirResponse {
  success: boolean;
  error?: string;
}

export type FileCallbackRequest =
  | FileObjectPutRequest
  | FileObjectGetRequest
  | FileObjectDeleteRequest
  | FileObjectListRequest
  | FileVolumeReadDirRequest
  | FileVolumeReadFileRequest
  | FileVolumeWriteFileRequest
  | FileVolumeDeleteRequest
  | FileVolumeStatRequest
  | FileVolumeMkdirRequest;

export type FileCallbackResponse =
  | FileObjectPutResponse
  | FileObjectGetResponse
  | FileObjectDeleteResponse
  | FileObjectListResponse
  | FileVolumeReadDirResponse
  | FileVolumeReadFileResponse
  | FileVolumeWriteFileResponse
  | FileVolumeDeleteResponse
  | FileVolumeStatResponse
  | FileVolumeMkdirResponse;

// --- Lifecycle (install/uninstall/session_opened/session_closed) ---

export interface LifecycleInstallRequest {
  type: 'lifecycle_install';
  installationId: string;
  workspaceId?: string;
  userId?: string;
}
export interface LifecycleInstallResponse {
  success: boolean;
  error?: string;
}

export interface LifecycleUninstallRequest {
  type: 'lifecycle_uninstall';
  installationId: string;
  workspaceId?: string;
}
export interface LifecycleUninstallResponse {
  success: boolean;
  error?: string;
}

export type LifecycleCallbackRequest =
  | LifecycleInstallRequest
  | LifecycleUninstallRequest;

export type LifecycleCallbackResponse =
  | LifecycleInstallResponse
  | LifecycleUninstallResponse;

// --- Type guards ---

export function isCallbackRequest(msg: unknown): msg is CallbackRequest {
  if (typeof msg !== 'object' || msg === null) return false;
  const t = (msg as any).type;
  return typeof t === 'string' && (
    t.startsWith('storage_') ||
    t.startsWith('file_object_') ||
    t.startsWith('file_volume_') ||
    t === 'lifecycle_install' ||
    t === 'lifecycle_uninstall'
  );
}

export function isStorageCallbackRequest(msg: unknown): msg is StorageCallbackRequest {
  if (typeof msg !== 'object' || msg === null) return false;
  const t = (msg as any).type;
  return t === 'storage_put' || t === 'storage_get' || t === 'storage_query' || t === 'storage_update' || t === 'storage_delete';
}

export function isFileCallbackRequest(msg: unknown): msg is FileCallbackRequest {
  if (typeof msg !== 'object' || msg === null) return false;
  const t = (msg as any).type;
  return typeof t === 'string' && (t.startsWith('file_object_') || t.startsWith('file_volume_'));
}

export function isLifecycleCallbackRequest(msg: unknown): msg is LifecycleCallbackRequest {
  if (typeof msg !== 'object' || msg === null) return false;
  const t = (msg as any).type;
  return t === 'lifecycle_install' || t === 'lifecycle_uninstall';
}

// ---------------------------------------------------------------------------
// Events emitted by the adapter
// ---------------------------------------------------------------------------

export type AdapterEvent =
  | { type: 'station:healthy'; stationId: string }
  | { type: 'station:unhealthy'; stationId: string; error: string }
  | { type: 'station:recovered'; stationId: string }
  | { type: 'station:registered'; stationId: string; url: string }
  | { type: 'session:opened'; sessionId: string; appId: string; stationId: string }
  | { type: 'session:closed'; sessionId: string; appId: string; reason: string }
  | { type: 'session:error'; sessionId: string; appId: string; error: string }
  | { type: 'tool:executed'; sessionId: string; toolName: string; durationMs: number; success: boolean }
  | { type: 'catalog:synced'; discovered: number; stationId: string }
  | { type: 'catalog:announced'; stationId: string; apps: string[] };

export type AdapterEventHandler = (event: AdapterEvent) => void;

// ---------------------------------------------------------------------------
// Logger (pluggable, no dependency on any logging framework)
// ---------------------------------------------------------------------------

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
  debug: (msg, data) => console.debug(`[AgentApps] ${msg}`, data ?? ''),
  info: (msg, data) => console.info(`[AgentApps] ${msg}`, data ?? ''),
  warn: (msg, data) => console.warn(`[AgentApps] ${msg}`, data ?? ''),
  error: (msg, data) => console.error(`[AgentApps] ${msg}`, data ?? ''),
};
