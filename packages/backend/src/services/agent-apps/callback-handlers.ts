/**
 * Agent Apps — Host Callback Handlers
 *
 * Implements the host-side handlers for callbacks sent from remote stations.
 * When a station's app calls ctx.storage.put(), ctx.files.object.put(), etc.,
 * the station sends a callback request to the host. These handlers process
 * those requests against real Teros infrastructure (MongoDB, filesystem, volumes).
 *
 * All operations are scoped by installationId to ensure isolation between
 * different app installations.
 */

import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';
import type {
  CallbackRequest,
  CallbackResponse,
  StorageCallbackRequest,
  StorageCallbackResponse,
  FileCallbackRequest,
  FileCallbackResponse,
  LifecycleCallbackRequest,
  LifecycleCallbackResponse,
  Logger,
} from './types';
import { consoleLogger } from './types';
import { ensureDynamicCollectionIndexes } from './storage-indexes';
import { config } from '../../config';
import { objectVariantsDir } from '../platform-objects';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CallbackHandlersConfig {
  db: Db;
  /** Base path for object storage (default: /data/agent-apps-objects) */
  objectStoragePath?: string;
  /** Max document size in bytes (default: 1MB) */
  maxDocumentSize?: number;
  /** Max object storage file size in bytes (default: 50MB) */
  maxObjectSize?: number;
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Collection name sanitisation
// ---------------------------------------------------------------------------

/** Allowed collection name pattern: alphanumeric + underscore, 1-64 chars */
const COLLECTION_PATTERN = /^[a-zA-Z0-9_]{1,64}$/;

function sanitizeCollectionName(collection: string): string {
  if (!COLLECTION_PATTERN.test(collection)) {
    throw new Error(`Invalid collection name: '${collection}'. Only alphanumeric and underscore, 1-64 chars.`);
  }
  return `agent_app_storage_${collection}`;
}

/** Sanitize installationId for use in filesystem paths */
function sanitizeInstallationId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Sanitize a storage key for filesystem use — allows / for directory structure */
function sanitizeKey(key: string): string {
  // Reject path traversal
  if (key.split('/').includes('..')) {
    throw new Error('Invalid key: path traversal detected');
  }
  // Replace dangerous chars but keep / for directory hierarchy
  return key.replace(/[^a-zA-Z0-9._\/-]/g, '_');
}

// ---------------------------------------------------------------------------
// Main dispatch function
// ---------------------------------------------------------------------------

export class CallbackHandlers {
  private db: Db;
  private objectStoragePath: string;
  private maxDocumentSize: number;
  private maxObjectSize: number;
  private log: Logger;

  constructor(config: CallbackHandlersConfig) {
    this.db = config.db;
    this.objectStoragePath = config.objectStoragePath ?? '/data/agent-apps-objects';
    this.maxDocumentSize = config.maxDocumentSize ?? 1024 * 1024; // 1MB
    this.maxObjectSize = config.maxObjectSize ?? 50 * 1024 * 1024; // 50MB
    this.log = config.logger ?? consoleLogger;
  }

  /**
   * Dispatch a callback request to the appropriate handler.
   * Returns a callback response.
   */
  async handle(request: CallbackRequest): Promise<CallbackResponse> {
    try {
      switch (request.type) {
        // Document Store
        case 'storage_put':
          return await this.handleStoragePut(request);
        case 'storage_get':
          return await this.handleStorageGet(request);
        case 'storage_query':
          return await this.handleStorageQuery(request);
        case 'storage_update':
          return await this.handleStorageUpdate(request);
        case 'storage_delete':
          return await this.handleStorageDelete(request);

        // Object Storage
        case 'file_object_put':
          return await this.handleFileObjectPut(request);
        case 'file_object_get':
          return await this.handleFileObjectGet(request);
        case 'file_object_delete':
          return await this.handleFileObjectDelete(request);
        case 'file_object_list':
          return await this.handleFileObjectList(request);

        // Volume Storage
        case 'file_volume_read_dir':
          return await this.handleFileVolumeReadDir(request);
        case 'file_volume_read_file':
          return await this.handleFileVolumeReadFile(request);
        case 'file_volume_write_file':
          return await this.handleFileVolumeWriteFile(request);
        case 'file_volume_delete':
          return await this.handleFileVolumeDelete(request);
        case 'file_volume_stat':
          return await this.handleFileVolumeStat(request);
        case 'file_volume_mkdir':
          return await this.handleFileVolumeMkdir(request);

        // Lifecycle
        case 'lifecycle_install':
          return await this.handleLifecycleInstall(request);
        case 'lifecycle_uninstall':
          return await this.handleLifecycleUninstall(request);

        default:
          return { success: false, error: `Unknown callback type: ${(request as any).type}` } as any;
      }
    } catch (error: any) {
      this.log.error('Callback handler error', { type: request.type, error: error.message });
      return { success: false, error: error.message } as any;
    }
  }

  // -------------------------------------------------------------------------
  // Document Store Handlers (MongoDB)
  // -------------------------------------------------------------------------

  private async handleStoragePut(req: StorageCallbackRequest & { documentId: string; document: Record<string, unknown> }): Promise<StorageCallbackResponse> {
    if (req.type !== 'storage_put') return { success: false, error: 'Internal dispatch error' } as any;

    const collectionName = sanitizeCollectionName(req.collection);
    const docSize = JSON.stringify(req.document).length;
    if (docSize > this.maxDocumentSize) {
      return { success: false, documentId: req.documentId, error: `Document too large: ${docSize} bytes (max ${this.maxDocumentSize})` };
    }

    // Ensure indexes exist on this dynamic collection (first use only —
    // the in-memory Set in storage-indexes.ts skips if already indexed).
    await ensureDynamicCollectionIndexes(this.db, collectionName);

    const collection = this.db.collection(collectionName);
    const now = new Date();

    await collection.updateOne(
      { _installationId: req.installationId, _documentId: req.documentId },
      {
        $set: {
          ...req.document,
          _installationId: req.installationId,
          _documentId: req.documentId,
          _updatedAt: now,
        },
        $setOnInsert: {
          _createdAt: now,
        },
      },
      { upsert: true },
    );

    this.log.debug('storage_put', { installationId: req.installationId, collection: req.collection, documentId: req.documentId });
    return { success: true, documentId: req.documentId };
  }

  private async handleStorageGet(req: StorageCallbackRequest & { documentId: string }): Promise<StorageCallbackResponse> {
    if (req.type !== 'storage_get') return { success: false, error: 'Internal dispatch error' } as any;

    const collectionName = sanitizeCollectionName(req.collection);
    const collection = this.db.collection(collectionName);

    const doc = await collection.findOne(
      { _installationId: req.installationId, _documentId: req.documentId },
      { projection: { _installationId: 0, _documentId: 0, _createdAt: 0, _updatedAt: 0 } },
    );

    return { success: true, document: doc ?? null };
  }

  private async handleStorageQuery(req: StorageCallbackRequest & { filter?: Record<string, unknown>; limit?: number; cursor?: string }): Promise<StorageCallbackResponse> {
    if (req.type !== 'storage_query') return { success: false, error: 'Internal dispatch error' } as any;

    const collectionName = sanitizeCollectionName(req.collection);
    const collection = this.db.collection(collectionName);

    // Build filter — always scope by installationId
    const filter: Record<string, unknown> = { _installationId: req.installationId };
    if (req.filter) {
      // Merge user filter with installation scope
      for (const [key, value] of Object.entries(req.filter)) {
        if (key.startsWith('_')) continue; // Prevent overriding internal fields
        filter[key] = value;
      }
    }

    const limit = Math.min(req.limit ?? 100, 1000);
    const cursor = req.cursor;

    // Simple cursor-based pagination using _id
    if (cursor) {
      try {
        const lastId = Buffer.from(cursor, 'base64url').toString('utf8');
        // Use $gt with the string representation — MongoDB ObjectId comparison works
        (filter as any)._id = { $gt: new ObjectId(lastId) };
      } catch {
        return { success: false, documents: [], error: 'Invalid cursor' };
      }
    }

    const docs = await collection
      .find(filter, { projection: { _installationId: 0, _updatedAt: 0 } })
      .sort({ _id: 1 })
      .limit(limit + 1)
      .toArray();

    let nextCursor: string | undefined;
    if (docs.length > limit) {
      const lastDoc = docs[limit - 1];
      nextCursor = Buffer.from((lastDoc as any)._id.toString()).toString('base64url');
      docs.length = limit; // Trim the extra doc
    }

    // Clean up internal fields from output
    const cleanDocs = docs.map((d) => {
      const { _installationId, _documentId, _createdAt, _updatedAt, _id, ...rest } = d as any;
      return rest as Record<string, unknown>;
    });

    return { success: true, documents: cleanDocs, nextCursor };
  }

  private async handleStorageUpdate(req: StorageCallbackRequest & { documentId: string; patch: Record<string, unknown> }): Promise<StorageCallbackResponse> {
    if (req.type !== 'storage_update') return { success: false, error: 'Internal dispatch error' } as any;

    const collectionName = sanitizeCollectionName(req.collection);
    const collection = this.db.collection(collectionName);
    const now = new Date();

    // Remove any attempt to modify internal fields
    const cleanPatch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(req.patch)) {
      if (key.startsWith('_')) continue;
      cleanPatch[key] = value;
    }

    const result = await collection.findOneAndUpdate(
      { _installationId: req.installationId, _documentId: req.documentId },
      {
        $set: { ...cleanPatch, _updatedAt: now },
      },
      { returnDocument: 'after', projection: { _installationId: 0, _documentId: 0, _createdAt: 0, _updatedAt: 0 } },
    );

    if (!result) {
      return { success: false, document: null, error: 'Document not found' };
    }

    return { success: true, document: result as Record<string, unknown> };
  }

  private async handleStorageDelete(req: StorageCallbackRequest & { documentId: string }): Promise<StorageCallbackResponse> {
    if (req.type !== 'storage_delete') return { success: false, error: 'Internal dispatch error' } as any;

    const collectionName = sanitizeCollectionName(req.collection);
    const collection = this.db.collection(collectionName);

    const result = await collection.deleteOne({
      _installationId: req.installationId,
      _documentId: req.documentId,
    });

    return { success: true };
  }

  // -------------------------------------------------------------------------
  // Object Storage Handlers (Filesystem + MongoDB index)
  // -------------------------------------------------------------------------

  /**
   * Generate a random objectId: `obj_` + 16 hex chars.
   * Not guessable — does not derive from content or key.
   */
  private generateObjectId(): string {
    return 'obj_' + randomBytes(8).toString('hex');
  }

  private objectPath(installationId: string, objectId: string): string {
    const instDir = sanitizeInstallationId(installationId);
    return join(this.objectStoragePath, instDir, objectId);
  }

  private metaPath(installationId: string, objectId: string): string {
    return this.objectPath(installationId, objectId) + '.meta.json';
  }

  /**
   * Construct the public URL for an objectId.
   * Uses config.agentApps.publicUrl (BACKEND_PUBLIC_URL or SERVER_BASE_URL).
   */
  private objectPublicUrl(objectId: string): string {
    const base = (config.agentApps.publicUrl || 'http://localhost:3000').replace(/\/$/, '');
    return `${base}/objects/${objectId}`;
  }

  private async handleFileObjectPut(req: FileObjectCallbackRequest & { data: string; contentType?: string; metadata?: Record<string, string> }): Promise<FileCallbackResponse> {
    if (req.type !== 'file_object_put') return { success: false, error: 'Internal dispatch error' } as any;

    const dataBuffer = Buffer.from(req.data, 'base64');
    if (dataBuffer.length > this.maxObjectSize) {
      return { success: false, error: `Object too large: ${dataBuffer.length} bytes (max ${this.maxObjectSize})` };
    }

    // Generate a random objectId — not guessable, not derived from content
    const objectId = this.generateObjectId();
    const filePath = this.objectPath(req.installationId, objectId);
    const metaFilePath = this.metaPath(req.installationId, objectId);

    await fs.mkdir(dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, dataBuffer);

    // Write metadata sidecar
    const now = new Date();
    const meta = {
      contentType: req.contentType ?? 'application/octet-stream',
      metadata: req.metadata ?? {},
      size: dataBuffer.length,
      createdAt: now.toISOString(),
    };
    await fs.writeFile(metaFilePath, JSON.stringify(meta));

    // Store in MongoDB for index + public URL resolution
    await this.db.collection('agent_app_objects').insertOne({
      objectId,
      installationId: req.installationId,
      contentType: meta.contentType,
      metadata: meta.metadata,
      size: dataBuffer.length,
      path: filePath,
      createdAt: now,
    });

    const url = this.objectPublicUrl(objectId);

    this.log.debug('file_object_put', { installationId: req.installationId, objectId, size: dataBuffer.length });
    return { success: true, objectId, url };
  }

  private async handleFileObjectGet(req: FileObjectCallbackRequest & { objectId: string }): Promise<FileCallbackResponse> {
    if (req.type !== 'file_object_get') return { success: false, error: 'Internal dispatch error' } as any;

    // Look up the object in MongoDB to verify it belongs to this installation
    const objDoc = await this.db.collection('agent_app_objects').findOne({
      objectId: req.objectId,
      installationId: req.installationId,
    });

    if (!objDoc) {
      return { success: true, data: null };
    }

    const filePath = objDoc.path as string;
    const metaFilePath = filePath + '.meta.json';

    try {
      const data = await fs.readFile(filePath);
      let meta: any = {};
      try {
        meta = JSON.parse(await fs.readFile(metaFilePath, 'utf8'));
      } catch { /* no metadata */ }

      return {
        success: true,
        data: data.toString('base64'),
        contentType: meta.contentType ?? objDoc.contentType,
        metadata: meta.metadata ?? objDoc.metadata,
      };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return { success: true, data: null };
      }
      throw error;
    }
  }

  private async handleFileObjectDelete(req: FileObjectCallbackRequest & { objectId: string }): Promise<FileCallbackResponse> {
    if (req.type !== 'file_object_delete') return { success: false, error: 'Internal dispatch error' } as any;

    // Find the object in MongoDB
    const objDoc = await this.db.collection('agent_app_objects').findOne({
      objectId: req.objectId,
      installationId: req.installationId,
    });

    if (!objDoc) {
      return { success: true };
    }

    const filePath = objDoc.path as string;
    const metaFilePath = filePath + '.meta.json';

    try {
      await fs.unlink(filePath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await fs.unlink(metaFilePath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
    // Stored image variants of the object (OBJ-REQ-3) go with it.
    await fs.rm(objectVariantsDir(filePath), { recursive: true, force: true });

    // Remove from MongoDB
    await this.db.collection('agent_app_objects').deleteOne({
      objectId: req.objectId,
      installationId: req.installationId,
    });

    return { success: true };
  }

  private async handleFileObjectList(req: FileObjectCallbackRequest): Promise<FileCallbackResponse> {
    if (req.type !== 'file_object_list') return { success: false, error: 'Internal dispatch error' } as any;

    // Query MongoDB for all objects in this installation
    const docs = await this.db.collection('agent_app_objects')
      .find({ installationId: req.installationId })
      .sort({ createdAt: -1 })
      .toArray();

    const objects = docs.map((doc: any) => ({
      objectId: doc.objectId,
      size: doc.size,
      contentType: doc.contentType,
      createdAt: doc.createdAt?.toISOString?.() ?? doc.createdAt,
    }));

    return { success: true, objects };
  }

  // -------------------------------------------------------------------------
  // Volume Storage Handlers (Workspace Volumes)
  // -------------------------------------------------------------------------

  private async handleFileVolumeReadDir(req: FileVolumeCallbackRequest & { path: string }): Promise<FileCallbackResponse> {
    if (req.type !== 'file_volume_read_dir') return { success: false, error: 'Internal dispatch error' } as any;

    // For volume operations, we need the workspace volume path.
    // The path is relative to the workspace volume root.
    const hostPath = await this.resolveVolumePath(req.workspaceId, req.path);
    const entries = await fs.readdir(hostPath, { withFileTypes: true });

    const result = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(hostPath, entry.name);
        let size: number | undefined;
        if (entry.isFile()) {
          try {
            const stat = await fs.stat(entryPath);
            size = stat.size;
          } catch { /* ignore */ }
        }
        return {
          name: entry.name,
          type: entry.isDirectory() ? 'directory' as const : 'file' as const,
          size,
        };
      }),
    );

    return { success: true, entries: result };
  }

  private async handleFileVolumeReadFile(req: FileVolumeCallbackRequest & { path: string }): Promise<FileCallbackResponse> {
    if (req.type !== 'file_volume_read_file') return { success: false, error: 'Internal dispatch error' } as any;

    const hostPath = await this.resolveVolumePath(req.workspaceId, req.path);

    try {
      const data = await fs.readFile(hostPath);
      return { success: true, data: data.toString('base64') };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return { success: true, data: null };
      }
      throw error;
    }
  }

  private async handleFileVolumeWriteFile(req: FileVolumeCallbackRequest & { path: string; data: string }): Promise<FileCallbackResponse> {
    if (req.type !== 'file_volume_write_file') return { success: false, error: 'Internal dispatch error' } as any;

    const hostPath = await this.resolveVolumePath(req.workspaceId, req.path);
    const dataBuffer = Buffer.from(req.data, 'base64');

    await fs.mkdir(dirname(hostPath), { recursive: true });
    await fs.writeFile(hostPath, dataBuffer);

    return { success: true };
  }

  private async handleFileVolumeDelete(req: FileVolumeCallbackRequest & { path: string; recursive?: boolean }): Promise<FileCallbackResponse> {
    if (req.type !== 'file_volume_delete') return { success: false, error: 'Internal dispatch error' } as any;

    const hostPath = await this.resolveVolumePath(req.workspaceId, req.path);

    try {
      const stat = await fs.stat(hostPath);
      if (stat.isDirectory()) {
        await fs.rmdir(hostPath);
      } else {
        await fs.unlink(hostPath);
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return { success: true };
      }
      // If recursive is requested and it's a directory, use rm
      if (req.recursive && error.code === 'ENOTEMPTY') {
        await fs.rm(hostPath, { recursive: true });
        return { success: true };
      }
      throw error;
    }

    return { success: true };
  }

  private async handleFileVolumeStat(req: FileVolumeCallbackRequest & { path: string }): Promise<FileCallbackResponse> {
    if (req.type !== 'file_volume_stat') return { success: false, error: 'Internal dispatch error' } as any;

    const hostPath = await this.resolveVolumePath(req.workspaceId, req.path);

    try {
      const stat = await fs.stat(hostPath);
      return {
        success: true,
        stat: {
          size: stat.size,
          isDirectory: stat.isDirectory(),
          modifiedAt: stat.mtime.toISOString(),
        },
      };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return { success: true, stat: null };
      }
      throw error;
    }
  }

  private async handleFileVolumeMkdir(req: FileVolumeCallbackRequest & { path: string }): Promise<FileCallbackResponse> {
    if (req.type !== 'file_volume_mkdir') return { success: false, error: 'Internal dispatch error' } as any;

    const hostPath = await this.resolveVolumePath(req.workspaceId, req.path);
    await fs.mkdir(hostPath, { recursive: true });
    return { success: true };
  }

  // -------------------------------------------------------------------------
  // Lifecycle Handlers
  // -------------------------------------------------------------------------

  private async handleLifecycleInstall(req: LifecycleCallbackRequest & { workspaceId?: string; userId?: string }): Promise<LifecycleCallbackResponse> {
    if (req.type !== 'lifecycle_install') return { success: false, error: 'Internal dispatch error' } as any;

    this.log.info('lifecycle_install', { installationId: req.installationId, workspaceId: req.workspaceId });

    // Record the installation in MongoDB
    await this.db.collection('agent_app_installations').updateOne(
      { installationId: req.installationId },
      {
        $set: {
          installationId: req.installationId,
          workspaceId: req.workspaceId,
          userId: req.userId,
          installedAt: new Date(),
          status: 'installed',
        },
      },
      { upsert: true },
    );

    return { success: true };
  }

  private async handleLifecycleUninstall(req: LifecycleCallbackRequest & { workspaceId?: string }): Promise<LifecycleCallbackResponse> {
    if (req.type !== 'lifecycle_uninstall') return { success: false, error: 'Internal dispatch error' } as any;

    this.log.info('lifecycle_uninstall', { installationId: req.installationId, workspaceId: req.workspaceId });

    // Mark as uninstalled
    await this.db.collection('agent_app_installations').updateOne(
      { installationId: req.installationId },
      {
        $set: {
          status: 'uninstalled',
          uninstalledAt: new Date(),
        },
      },
    );

    // Clean up object storage for this installation
    const instDir = sanitizeInstallationId(req.installationId);
    const objPath = join(this.objectStoragePath, instDir);
    try {
      await fs.rm(objPath, { recursive: true });
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        this.log.warn('Failed to clean up object storage on uninstall', { installationId: req.installationId, error: error.message });
      }
    }

    return { success: true };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve a workspace-relative path to a host filesystem path.
   * Uses the volume service to find the workspace's volume host path.
   */
  private async resolveVolumePath(workspaceId: string, relativePath: string): Promise<string> {
    // Prevent path traversal
    if (relativePath.split('/').includes('..')) {
      throw new Error('Invalid path: path traversal detected');
    }

    // Look up the workspace's volume
    const workspace = await this.db.collection('workspaces').findOne({ workspaceId });
    if (!workspace?.volumeId) {
      throw new Error(`Workspace has no volume: ${workspaceId}`);
    }

    const volume = await this.db.collection('volumes').findOne({ volumeId: workspace.volumeId });
    if (!volume) {
      throw new Error(`Volume not found: ${workspace.volumeId}`);
    }

    const hostPath = join(volume.hostPath, relativePath);
    return hostPath;
  }


}

// ---------------------------------------------------------------------------
// Type re-exports for narrower internal typing
// ---------------------------------------------------------------------------

type FileObjectCallbackRequest = Extract<FileCallbackRequest, { type: `file_object_${string}` }>;
type FileVolumeCallbackRequest = Extract<FileCallbackRequest, { type: `file_volume_${string}` }>;
