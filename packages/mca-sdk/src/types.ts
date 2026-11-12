/**
 * Storage type definitions for the MCA SDK.
 *
 * Defines the unified volume + sharing API that MCAs access via
 * `ctx.volume` and `ctx.share` in their tool handlers, plus the
 * document store (`ctx.storage`) and object storage (`ctx.objects`)
 * APIs backed by AgentApps storage endpoints.
 *
 * @see docs/specs/STORAGE-VOLUME-SPEC.md
 */

// ============================================================================
// VOLUME STORAGE
// ============================================================================

/**
 * Directory entry returned by `VolumeStorage.list()`.
 */
export interface VolumeEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
}

/**
 * File metadata returned by `VolumeStorage.stat()`.
 */
export interface VolumeStat {
  size: number;
  isDirectory: boolean;
  modifiedAt: string;
}

/**
 * Options for `VolumeStorage.delete()`.
 */
export interface VolumeDeleteOptions {
  /** If true, recursively delete non-empty directories. */
  recursive?: boolean;
}

/**
 * Volume storage interface — the unified file-system API for MCAs.
 *
 * Exposed as `ctx.volume` in the tool handler context. All paths are
 * relative to the workspace volume root (e.g. `/file.txt`, `/src/file.ts`).
 *
 * Methods:
 * - `list(path)` — list directory entries
 * - `read(path)` — read file contents as a base64-encoded string
 * - `write(path, data)` — write data to a file (creates or overwrites, data is base64)
 * - `delete(path, options?)` — delete a file or directory
 * - `stat(path)` — get file/directory metadata
 * - `mkdir(path)` — create a directory (recursive, idempotent)
 * - `getTempPath(filename)` — get a path for a temporary file (no I/O, just constructs the path)
 */
export interface VolumeStorage {
  /**
   * List entries in a directory.
   * @param path Path within the volume (e.g. `/src`)
   * @returns Array of directory entries
   */
  list(path: string): Promise<VolumeEntry[]>;

  /**
   * Read a file's contents as a base64-encoded string.
   * @param path Path within the volume
   * @returns Base64-encoded file contents, or null if the file does not exist
   */
  read(path: string): Promise<string | null>;

  /**
   * Write data to a file. Creates the file if it doesn't exist,
   * overwrites if it does. Parent directories are created automatically.
   * @param path Path within the volume
   * @param data File contents as a base64-encoded string
   */
  write(path: string, data: string): Promise<void>;

  /**
   * Delete a file or directory.
   * @param path Path within the volume
   * @param options Optional deletion options (e.g. recursive for directories)
   */
  delete(path: string, options?: VolumeDeleteOptions): Promise<void>;

  /**
   * Get metadata for a file or directory.
   * @param path Path within the volume
   * @returns Stat info, or null if the path does not exist
   */
  stat(path: string): Promise<VolumeStat | null>;

  /**
   * Create a directory. Parent directories are created automatically.
   * Idempotent — succeeds silently if the directory already exists.
   * @param path Path within the volume
   */
  mkdir(path: string): Promise<void>;

  /**
   * Get a path for a temporary file within the volume.
   *
   * This is a pure path-construction helper — it does NOT create the file
   * or any directories. The path is scoped to the current session to avoid
   * collisions between concurrent tool calls.
   *
   * @param filename Name of the temp file (e.g. `output.json`)
   * @returns Path within the volume (e.g. `/tmp/{sessionId}/output.json`)
   */
  getTempPath(filename: string): string;
}

// ============================================================================
// SHARE ACCESS
// ============================================================================

/**
 * Options for `ShareAccess.share()`.
 */
export interface ShareOptions {
  /** If true, the shared URL allows write access (e.g. PUT). Default: false. */
  mutable?: boolean;
  /** Expiration time in seconds from now. If omitted, uses backend default. */
  expiresIn?: number;
}

/**
 * Result of `ShareAccess.share()`.
 */
export interface ShareResult {
  /** The publicly accessible URL. */
  url: string;
  /** ISO 8601 timestamp when the URL expires. */
  expiresAt: string;
  /** Whether the URL allows write access. */
  mutable: boolean;
}

/**
 * Share access interface — for creating and revoking public URLs to
 * files on the workspace volume.
 *
 * Exposed as `ctx.share` in the tool handler context.
 *
 * Methods:
 * - `share(path, options?)` — create a public URL for a file
 * - `revoke(url)` — revoke a previously created share URL
 */
export interface ShareAccess {
  /**
   * Create a public URL for a file on the workspace volume.
   * @param path Absolute path within the volume (e.g. `/workspace/report.pdf`)
   * @param options Optional sharing options (mutable, expiresIn)
   * @returns The share result with URL, expiration, and mutability flag
   */
  share(path: string, options?: ShareOptions): Promise<ShareResult>;

  /**
   * Revoke a previously created share URL.
   * @param url The URL returned by `share()`
   */
  revoke(url: string): Promise<void>;
}

// ============================================================================
// DOCUMENT STORAGE (AgentApps document store — MongoDB-backed)
// ============================================================================

/**
 * Result of `DocumentStorage.put()`.
 */
export interface StoragePutResult {
  success: boolean;
  documentId: string;
  error?: string;
}

/**
 * Result of `DocumentStorage.get()`.
 */
export interface StorageGetResult {
  success: boolean;
  document: Record<string, unknown> | null;
  error?: string;
}

/**
 * Result of `DocumentStorage.query()`.
 */
export interface StorageQueryResult {
  success: boolean;
  documents: Record<string, unknown>[];
  nextCursor?: string;
  error?: string;
}

/**
 * Result of `DocumentStorage.update()`.
 */
export interface StorageUpdateResult {
  success: boolean;
  document: Record<string, unknown> | null;
  error?: string;
}

/**
 * Result of `DocumentStorage.delete()`.
 */
export interface StorageDeleteResult {
  success: boolean;
  error?: string;
}

/**
 * Document storage interface — a MongoDB-backed key-document store scoped
 * per app installation.
 *
 * Exposed as `ctx.storage` in the tool handler context. Each installation
 * gets its own isolated namespace — documents from one app installation are
 * not visible to another.
 *
 * Methods:
 * - `put(collection, documentId, document)` — upsert a document
 * - `get(collection, documentId)` — retrieve a single document
 * - `query(collection, filter?, limit?)` — list documents matching a filter
 * - `update(collection, documentId, patch)` — partially update a document
 * - `delete(collection, documentId)` — remove a document
 */
export interface DocumentStorage {
  /**
   * Upsert a document into a collection.
   * @param collection Collection name (alphanumeric + underscore, 1-64 chars)
   * @param documentId Unique document ID within the collection
   * @param document The document to store (any JSON-serialisable object)
   * @returns Result with success flag and documentId
   */
  put(
    collection: string,
    documentId: string,
    document: Record<string, unknown>,
  ): Promise<StoragePutResult>;

  /**
   * Retrieve a single document by ID.
   * @param collection Collection name
   * @param documentId Document ID
   * @returns Result with the document (or null if not found)
   */
  get(
    collection: string,
    documentId: string,
  ): Promise<StorageGetResult>;

  /**
   * Query documents in a collection matching a filter.
   * @param collection Collection name
   * @param filter Optional MongoDB-style filter object
   * @param limit Optional max results (default 100, max 1000)
   * @returns Result with array of documents and optional pagination cursor
   */
  query(
    collection: string,
    filter?: Record<string, unknown>,
    limit?: number,
  ): Promise<StorageQueryResult>;

  /**
   * Partially update a document (patch merge).
   * @param collection Collection name
   * @param documentId Document ID
   * @param patch Fields to update
   * @returns Result with the updated document (or null if not found)
   */
  update(
    collection: string,
    documentId: string,
    patch: Record<string, unknown>,
  ): Promise<StorageUpdateResult>;

  /**
   * Delete a document by ID.
   * @param collection Collection name
   * @param documentId Document ID
   * @returns Result with success flag
   */
  delete(collection: string, documentId: string): Promise<StorageDeleteResult>;
}

// ============================================================================
// OBJECT STORAGE (AgentApps object storage — filesystem-backed blob store)
// ============================================================================

/**
 * An object listed by `ObjectStorage.list()`.
 */
export interface ObjectListItem {
  objectId: string;
  size: number;
  contentType?: string;
  createdAt?: string;
}

/**
 * Result of `ObjectStorage.put()`.
 */
export interface ObjectPutResult {
  success: boolean;
  objectId: string;
  url: string;
  error?: string;
}

/**
 * Result of `ObjectStorage.get()`.
 */
export interface ObjectGetResult {
  success: boolean;
  data: Buffer | null;
  contentType?: string;
  metadata?: Record<string, string>;
  error?: string;
}

/**
 * Result of `ObjectStorage.delete()`.
 */
export interface ObjectDeleteResult {
  success: boolean;
  error?: string;
}

/**
 * Result of `ObjectStorage.list()`.
 */
export interface ObjectListResult {
  success: boolean;
  objects: ObjectListItem[];
  error?: string;
}

/**
 * Object storage interface — a filesystem-backed binary blob store scoped
 * per app installation.
 *
 * Exposed as `ctx.objects` in the tool handler context. Each installation
 * gets its own isolated directory — objects from one app installation are
 * not visible to another.
 *
 * The system generates a random `objectId` for each object. The `put` method
 * returns a permanent public URL that serves the object without auth.
 *
 * Methods:
 * - `put(data, contentType, metadata?)` — store a binary object, get objectId + public URL
 * - `get(objectId)` — retrieve a binary object as a Buffer
 * - `delete(objectId)` — remove an object
 * - `list()` — list all objects in this installation
 */
export interface ObjectStorage {
  /**
   * Store a binary object. The system generates a random objectId.
   * @param data Binary content
   * @param contentType MIME type (default: application/octet-stream)
   * @param metadata Optional key-value metadata stored alongside the object
   * @returns Result with objectId and permanent public URL
   */
  put(
    data: Buffer,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<ObjectPutResult>;

  /**
   * Retrieve a binary object by objectId.
   * @param objectId The object ID returned by `put()`
   * @returns Result with data as Buffer (or null if not found), plus contentType and metadata
   */
  get(objectId: string): Promise<ObjectGetResult>;

  /**
   * Delete an object by objectId.
   * @param objectId The object ID returned by `put()`
   * @returns Result with success flag
   */
  delete(objectId: string): Promise<ObjectDeleteResult>;

  /**
   * List all objects in this installation.
   * @returns Result with array of object metadata
   */
  list(): Promise<ObjectListResult>;
}
