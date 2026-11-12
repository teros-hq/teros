/**
 * Agent Apps Adapter — Public API
 *
 * This module is fully self-contained. It can be extracted to its own
 * npm package without any changes. ZERO external dependencies.
 *
 * Usage:
 *
 *   import { AgentAppsManager } from './agent-apps';
 *
 *   const manager = new AgentAppsManager({
 *     stations: [
 *       { id: 'eu-west', url: 'http://station-eu:3000', region: 'eu-west-1' },
 *       { id: 'us-east', url: 'http://station-us:3000', region: 'us-east-1' },
 *     ],
 *     globalToken: 'secret',
 *     host: { name: 'my-platform', version: '1.0.0' },
 *   });
 *
 *   await manager.initialize();
 *
 *   const result = await manager.callTool('app_github', 'list-repos', {}, {
 *     installationId: 'inst_123',
 *     userId: 'user_1',
 *   });
 */

// Core manager (facade)
export { AgentAppsManager } from './agent-apps-manager';

// Callback handlers (host-side)
export { CallbackHandlers, type CallbackHandlersConfig } from './callback-handlers';

// Storage indexes (bootstrap + dynamic collection indexing)
export { ensureStorageIndexes, ensureDynamicCollectionIndexes } from './storage-indexes';

// Sub-modules (for advanced use / testing)
export { StationRegistry, type StationRegistryConfig } from './station-registry';
export { SessionPool, type SessionPoolConfig } from './session-pool';
export { discoverAll, type CatalogSyncConfig, type SyncResult } from './catalog-sync';

// Protocol client (for direct protocol-level access)
export {
  send,
  initialize,
  sessionOpen,
  sessionClose,
  listTools,
  callTool,
  healthCheck,
  stationHealth,
  createEnvelope,
  generateMessageId,
  ProtocolError,
  // UI Resources
  listUiResources,
  getUiResource,
  submitUiResource,
} from './protocol-client';

// Types (everything needed to configure and consume the adapter)
export type {
  AgentAppsConfig,
  StationEndpoint,
  StationState,
  StationStatus,
  ProtocolMessage,
  RawToolDefinition,
  ToolAnnotations,
  ToolCallContext,
  ToolCallResult,
  SessionInfo,
  InstanceHealth,
  HealthIssue,
  HealthStatus,
  DiscoveredApp,
  AnnouncePayload,
  AnnounceApp,
  AnnounceResult,
  AdapterEvent,
  AdapterEventHandler,
  Logger,
  // UI Resources
  RawUiResourceDefinition,
  UiResourceData,
  TreeNode,
  DetailField,
  DetailSection,
  UiFormField,
  UiResourceSubmitResult,
  // Callback types (host-side)
  CallbackRequest,
  CallbackResponse,
  StorageCallbackRequest,
  StorageCallbackResponse,
  StoragePutRequest,
  StorageGetRequest,
  StorageQueryRequest,
  StorageUpdateRequest,
  StorageDeleteRequest,
  StoragePutResponse,
  StorageGetResponse,
  StorageQueryResponse,
  StorageUpdateResponse,
  StorageDeleteResponse,
  FileCallbackRequest,
  FileCallbackResponse,
  FileObjectPutRequest,
  FileObjectGetRequest,
  FileObjectDeleteRequest,
  FileObjectListRequest,
  FileObjectPutResponse,
  FileObjectGetResponse,
  FileObjectDeleteResponse,
  FileObjectListResponse,
  FileVolumeReadDirRequest,
  FileVolumeReadFileRequest,
  FileVolumeWriteFileRequest,
  FileVolumeDeleteRequest,
  FileVolumeStatRequest,
  FileVolumeReadDirResponse,
  FileVolumeReadFileResponse,
  FileVolumeWriteFileResponse,
  FileVolumeDeleteResponse,
  FileVolumeStatResponse,
  LifecycleCallbackRequest,
  LifecycleCallbackResponse,
  LifecycleInstallRequest,
  LifecycleUninstallRequest,
  LifecycleInstallResponse,
  LifecycleUninstallResponse,
} from './types';

export {
  isCallbackRequest,
  isStorageCallbackRequest,
  isFileCallbackRequest,
  isLifecycleCallbackRequest,
} from './types';

export { consoleLogger } from './types';
