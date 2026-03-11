#!/usr/bin/env npx tsx

/**
 * MinIO MCA
 *
 * S3-compatible object storage - manage buckets, upload/download objects,
 * generate presigned URLs.
 *
 * Uses @teros/mca-sdk for WebSocket-based secrets management.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
// MCA SDK imports
import { createWebSocketClient, HealthCheckBuilder, type McaWebSocketClient } from '@teros/mca-sdk';
import * as fs from 'fs';
import * as Minio from 'minio';
import * as os from 'os';
import * as path from 'path';

// =============================================================================
// CONFIGURATION
// =============================================================================

const MCA_APP_ID = process.env.MCA_APP_ID || 'unknown';
const MCA_APP_NAME = process.env.MCA_APP_NAME || 'minio';

// WebSocket client for backend communication
let wsClient: McaWebSocketClient | null = null;
let credentialsAvailable = false;

// Cached secrets from WebSocket
let cachedSystemSecrets: Record<string, string> | null = null;

// MinIO client (initialized after secrets are loaded)
let minioClient: Minio.Client | null = null;

/**
 * Get MinIO configuration from cached secrets or environment
 */
function getMinioConfig(): {
  endpoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
} | null {
  const endpoint =
    cachedSystemSecrets?.ENDPOINT || cachedSystemSecrets?.endpoint || process.env.MINIO_ENDPOINT;

  const accessKey =
    cachedSystemSecrets?.ACCESS_KEY ||
    cachedSystemSecrets?.access_key ||
    process.env.MINIO_ACCESS_KEY;

  const secretKey =
    cachedSystemSecrets?.SECRET_KEY ||
    cachedSystemSecrets?.secret_key ||
    process.env.MINIO_SECRET_KEY;

  if (!endpoint || !accessKey || !secretKey) {
    return null;
  }

  // Parse endpoint URL
  let host = endpoint;
  let port = 9000;
  let useSSL = false;

  if (endpoint.startsWith('https://')) {
    useSSL = true;
    host = endpoint.replace('https://', '');
  } else if (endpoint.startsWith('http://')) {
    host = endpoint.replace('http://', '');
  }

  // Extract port if present
  if (host.includes(':')) {
    const parts = host.split(':');
    host = parts[0];
    port = parseInt(parts[1], 10);
  } else if (useSSL) {
    port = 443;
  }

  return { endpoint: host, port, useSSL, accessKey, secretKey };
}

/**
 * Check if MinIO is configured
 */
function isConfigured(): boolean {
  return !!getMinioConfig();
}

/**
 * Initialize MinIO client with current configuration
 */
function initializeMinioClient(): boolean {
  const config = getMinioConfig();
  if (!config) {
    minioClient = null;
    return false;
  }

  minioClient = new Minio.Client({
    endPoint: config.endpoint,
    port: config.port,
    useSSL: config.useSSL,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
  });

  return true;
}

/**
 * Get the MinIO client, throwing if not configured
 */
function getClient(): Minio.Client {
  if (!minioClient) {
    throw new Error('MinIO not configured. Please configure ENDPOINT, ACCESS_KEY, and SECRET_KEY.');
  }
  return minioClient;
}

// =============================================================================
// HELPERS
// =============================================================================

async function streamToArray<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) {
    items.push(item);
  }
  return items;
}

// =============================================================================
// MCP SERVER
// =============================================================================

const server = new Server(
  {
    name: 'mca.minio',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: '-health-check',
        description: 'Internal health check tool. Verifies MinIO credentials and connectivity.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list-buckets',
        description: 'List all buckets in the MinIO server',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'create-bucket',
        description: 'Create a new bucket',
        inputSchema: {
          type: 'object',
          properties: {
            bucket: {
              type: 'string',
              description: 'Name of the bucket to create (lowercase, 3-63 chars)',
            },
            region: {
              type: 'string',
              description: 'Region for the bucket (optional, default: us-east-1)',
            },
          },
          required: ['bucket'],
        },
      },
      {
        name: 'delete-bucket',
        description: 'Delete a bucket (must be empty)',
        inputSchema: {
          type: 'object',
          properties: {
            bucket: {
              type: 'string',
              description: 'Name of the bucket to delete',
            },
          },
          required: ['bucket'],
        },
      },
      {
        name: 'bucket-exists',
        description: 'Check if a bucket exists',
        inputSchema: {
          type: 'object',
          properties: {
            bucket: {
              type: 'string',
              description: 'Name of the bucket to check',
            },
          },
          required: ['bucket'],
        },
      },
      {
        name: 'list-objects',
        description: 'List objects in a bucket with optional prefix filter',
        inputSchema: {
          type: 'object',
          properties: {
            bucket: {
              type: 'string',
              description: 'Name of the bucket',
            },
            prefix: {
              type: 'string',
              description: 'Filter objects by prefix/folder (optional)',
            },
            recursive: {
              type: 'boolean',
              description: 'List recursively (default: true)',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of objects to return (default: 100)',
            },
          },
          required: ['bucket'],
        },
      },
      {
        name: 'upload-object',
        description: 'Upload a file or content to a bucket',
        inputSchema: {
          type: 'object',
          properties: {
            bucket: {
              type: 'string',
              description: 'Name of the bucket',
            },
            objectName: {
              type: 'string',
              description: 'Name/path for the object in the bucket',
            },
            filePath: {
              type: 'string',
              description: 'Local file path to upload (use this OR content)',
            },
            content: {
              type: 'string',
              description: 'String content to upload (use this OR filePath)',
            },
            contentType: {
              type: 'string',
              description: 'MIME type (optional, auto-detected if possible)',
            },
          },
          required: ['bucket', 'objectName'],
        },
      },
      {
        name: 'download-object',
        description: 'Download an object from a bucket',
        inputSchema: {
          type: 'object',
          properties: {
            bucket: {
              type: 'string',
              description: 'Name of the bucket',
            },
            objectName: {
              type: 'string',
              description: 'Name/path of the object to download',
            },
            destPath: {
              type: 'string',
              description: 'Local destination path (optional, defaults to ~/Downloads/minio/)',
            },
          },
          required: ['bucket', 'objectName'],
        },
      },
      {
        name: 'delete-object',
        description: 'Delete an object from a bucket',
        inputSchema: {
          type: 'object',
          properties: {
            bucket: {
              type: 'string',
              description: 'Name of the bucket',
            },
            objectName: {
              type: 'string',
              description: 'Name/path of the object to delete',
            },
          },
          required: ['bucket', 'objectName'],
        },
      },
      {
        name: 'copy-object',
        description: 'Copy an object within or between buckets',
        inputSchema: {
          type: 'object',
          properties: {
            sourceBucket: {
              type: 'string',
              description: 'Source bucket name',
            },
            sourceObject: {
              type: 'string',
              description: 'Source object name/path',
            },
            destBucket: {
              type: 'string',
              description: 'Destination bucket name',
            },
            destObject: {
              type: 'string',
              description: 'Destination object name/path',
            },
          },
          required: ['sourceBucket', 'sourceObject', 'destBucket', 'destObject'],
        },
      },
      {
        name: 'get-presigned-url',
        description: 'Generate a presigned URL for temporary access to an object',
        inputSchema: {
          type: 'object',
          properties: {
            bucket: {
              type: 'string',
              description: 'Name of the bucket',
            },
            objectName: {
              type: 'string',
              description: 'Name/path of the object',
            },
            expiry: {
              type: 'number',
              description:
                'URL expiry time in seconds (default: 3600 = 1 hour, max: 604800 = 7 days)',
            },
            method: {
              type: 'string',
              description: 'HTTP method: GET (download) or PUT (upload)',
              enum: ['GET', 'PUT'],
            },
          },
          required: ['bucket', 'objectName'],
        },
      },
      {
        name: 'get-object-info',
        description: 'Get metadata/info about an object (size, type, etag, etc.)',
        inputSchema: {
          type: 'object',
          properties: {
            bucket: {
              type: 'string',
              description: 'Name of the bucket',
            },
            objectName: {
              type: 'string',
              description: 'Name/path of the object',
            },
          },
          required: ['bucket', 'objectName'],
        },
      },
    ],
  };
});

interface Args {
  bucket?: string;
  region?: string;
  prefix?: string;
  recursive?: boolean;
  limit?: number;
  objectName?: string;
  filePath?: string;
  content?: string;
  contentType?: string;
  destPath?: string;
  sourceBucket?: string;
  sourceObject?: string;
  destBucket?: string;
  destObject?: string;
  expiry?: number;
  method?: 'GET' | 'PUT';
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs || {}) as Args;

  try {
    // Health check
    if (name === '-health-check') {
      const builder = new HealthCheckBuilder({
        system: cachedSystemSecrets,
      }).setVersion('1.0.0');

      builder.requireSystemSecret('ENDPOINT', 'MinIO endpoint not configured');
      builder.requireSystemSecret('ACCESS_KEY', 'MinIO access key not configured');
      builder.requireSystemSecret('SECRET_KEY', 'MinIO secret key not configured');

      const config = getMinioConfig();
      if (!config) {
        builder.addIssue('SYSTEM_CONFIG_MISSING', 'MinIO credentials not configured', {
          type: 'admin_action',
          description: 'Configure ENDPOINT, ACCESS_KEY, and SECRET_KEY in system secrets',
        });
      } else {
        // Try to connect and list buckets to verify credentials
        try {
          const client = getClient();
          await client.listBuckets();
          builder.addCheck('connectivity', true, 'Connected to MinIO server');
        } catch (error: any) {
          builder.addCheck('connectivity', false, `Failed to connect: ${error.message}`);
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(builder.build(), null, 2) }],
      };
    }

    // All other tools require MinIO client
    const client = getClient();

    switch (name) {
      case 'list-buckets': {
        const buckets = await client.listBuckets();

        const formattedBuckets = buckets.map((bucket) => ({
          name: bucket.name,
          creationDate: bucket.creationDate?.toISOString(),
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(formattedBuckets, null, 2),
            },
          ],
        };
      }

      case 'create-bucket': {
        const bucket = args.bucket!;
        const region = args.region || 'us-east-1';

        await client.makeBucket(bucket, region);

        return {
          content: [
            {
              type: 'text',
              text: `Bucket '${bucket}' created successfully in region '${region}'`,
            },
          ],
        };
      }

      case 'delete-bucket': {
        const bucket = args.bucket!;

        await client.removeBucket(bucket);

        return {
          content: [
            {
              type: 'text',
              text: `Bucket '${bucket}' deleted successfully`,
            },
          ],
        };
      }

      case 'bucket-exists': {
        const bucket = args.bucket!;

        const exists = await client.bucketExists(bucket);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ bucket, exists }, null, 2),
            },
          ],
        };
      }

      case 'list-objects': {
        const bucket = args.bucket!;
        const prefix = args.prefix || '';
        const recursive = args.recursive !== false;
        const limit = args.limit || 100;

        const objectsStream = client.listObjects(bucket, prefix, recursive);
        const allObjects = await streamToArray(objectsStream);
        const objects = allObjects.slice(0, limit);

        const formattedObjects = objects.map((obj) => ({
          name: obj.name,
          size: obj.size,
          etag: obj.etag,
          lastModified: obj.lastModified?.toISOString(),
          isDir: obj.prefix !== undefined,
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  bucket,
                  prefix: prefix || '(root)',
                  count: formattedObjects.length,
                  totalFound: allObjects.length,
                  objects: formattedObjects,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'upload-object': {
        const bucket = args.bucket!;
        const objectName = args.objectName!;

        let size: number;
        const metaData: { [key: string]: string } = {};

        if (args.contentType) {
          metaData['Content-Type'] = args.contentType;
        }

        if (args.filePath) {
          // Upload from file
          const filePath = args.filePath.startsWith('~')
            ? args.filePath.replace('~', os.homedir())
            : args.filePath;

          if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
          }

          const stats = fs.statSync(filePath);
          size = stats.size;

          await client.fPutObject(bucket, objectName, filePath, metaData);
        } else if (args.content) {
          // Upload from string content
          const buffer = Buffer.from(args.content, 'utf-8');
          size = buffer.length;

          await client.putObject(bucket, objectName, buffer, size, metaData);
        } else {
          throw new Error("Either 'filePath' or 'content' must be provided");
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  bucket,
                  objectName,
                  size,
                  message: `Object '${objectName}' uploaded successfully to bucket '${bucket}'`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'download-object': {
        const bucket = args.bucket!;
        const objectName = args.objectName!;

        // Determine destination path
        let destPath = args.destPath;
        if (!destPath) {
          const downloadDir = path.join(os.homedir(), 'Downloads', 'minio');
          if (!fs.existsSync(downloadDir)) {
            fs.mkdirSync(downloadDir, { recursive: true });
          }
          destPath = path.join(downloadDir, path.basename(objectName));
        } else if (destPath.startsWith('~')) {
          destPath = destPath.replace('~', os.homedir());
        }

        // Ensure directory exists
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }

        await client.fGetObject(bucket, objectName, destPath);

        const stats = fs.statSync(destPath);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  bucket,
                  objectName,
                  destPath,
                  size: stats.size,
                  message: `Object '${objectName}' downloaded to '${destPath}'`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'delete-object': {
        const bucket = args.bucket!;
        const objectName = args.objectName!;

        await client.removeObject(bucket, objectName);

        return {
          content: [
            {
              type: 'text',
              text: `Object '${objectName}' deleted from bucket '${bucket}'`,
            },
          ],
        };
      }

      case 'copy-object': {
        const sourceBucket = args.sourceBucket!;
        const sourceObject = args.sourceObject!;
        const destBucket = args.destBucket!;
        const destObject = args.destObject!;

        const conds = new Minio.CopyConditions();

        await client.copyObject(destBucket, destObject, `/${sourceBucket}/${sourceObject}`, conds);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  source: `${sourceBucket}/${sourceObject}`,
                  destination: `${destBucket}/${destObject}`,
                  message: 'Object copied successfully',
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'get-presigned-url': {
        const bucket = args.bucket!;
        const objectName = args.objectName!;
        const expiry = Math.min(args.expiry || 3600, 604800); // Default 1 hour, max 7 days
        const method = args.method || 'GET';

        let url: string;
        if (method === 'PUT') {
          url = await client.presignedPutObject(bucket, objectName, expiry);
        } else {
          url = await client.presignedGetObject(bucket, objectName, expiry);
        }

        const expiresAt = new Date(Date.now() + expiry * 1000);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  bucket,
                  objectName,
                  method,
                  url,
                  expirySeconds: expiry,
                  expiresAt: expiresAt.toISOString(),
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'get-object-info': {
        const bucket = args.bucket!;
        const objectName = args.objectName!;

        const stat = await client.statObject(bucket, objectName);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  bucket,
                  objectName,
                  size: stat.size,
                  etag: stat.etag,
                  lastModified: stat.lastModified?.toISOString(),
                  metaData: stat.metaData,
                  versionId: stat.versionId,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  console.error(`🗄️ MinIO MCA starting (appId: ${MCA_APP_ID}, name: ${MCA_APP_NAME})`);

  wsClient = createWebSocketClient();
  if (wsClient) {
    wsClient.on('disconnected', (code, reason) => {
      console.error(`🔌 Disconnected from backend: ${code} ${reason}`);
    });

    wsClient.on('command', (command) => {
      if (command.command === 'shutdown') {
        gracefulShutdown();
      } else if (command.command === 'health_check') {
        wsClient!.sendHealthUpdate(credentialsAvailable ? 'ready' : 'not_ready');
      }
    });

    try {
      await wsClient.connect();
      console.error('🔌 Connected to backend via WebSocket');

      try {
        cachedSystemSecrets = await wsClient.getSystemSecrets();
        console.error(
          `✅ System secrets loaded: ${cachedSystemSecrets ? Object.keys(cachedSystemSecrets).join(', ') : 'null'}`,
        );

        // Initialize MinIO client with loaded secrets
        if (initializeMinioClient()) {
          console.error('✅ MinIO client initialized');
          credentialsAvailable = true;
        } else {
          console.error('⚠️ MinIO credentials not configured');
          credentialsAvailable = false;
        }
      } catch (error: any) {
        console.error(`⚠️ Failed to get system secrets: ${error.message}`);
      }
    } catch (error: any) {
      console.error(`⚠️ WebSocket connection failed: ${error.message}`);
    }
  } else {
    console.error('📡 WebSocket not enabled');
    // Try to initialize from environment variables
    if (initializeMinioClient()) {
      console.error('✅ MinIO client initialized from environment');
      credentialsAvailable = true;
    } else {
      console.error('⚠️ MinIO credentials not configured');
      credentialsAvailable = false;
    }
  }

  if (wsClient?.connected) {
    wsClient.sendHealthUpdate(credentialsAvailable ? 'ready' : 'not_ready');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('🔗 MinIO MCP Server running on stdio');
}

async function gracefulShutdown() {
  console.error('👋 Shutting down MinIO MCA...');
  if (wsClient) wsClient.disconnect();
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

main().catch(console.error);
