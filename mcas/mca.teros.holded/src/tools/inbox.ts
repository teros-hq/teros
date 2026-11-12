import { holdedRequest } from '../lib/index.js';
import type { ToolConfig } from '@teros/mca-sdk';

// =============================================================================
// TYPES
// =============================================================================

/** Raw inbox document shape returned by the Holded API */
interface HoldedInboxDocument {
  id?: string;
  _id?: string;
  name?: string;
  filename?: string;
  status?: string;
  type?: string;
  created_at?: string;
  updated_at?: string;
}

/** Curated inbox document output returned by our tools */
interface CuratedInboxDocument {
  id: string | null;
  name: string | null;
  status: string | null;
  type: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

// =============================================================================
// MAPPING HELPER
// =============================================================================

function mapInboxDocument(d: HoldedInboxDocument): CuratedInboxDocument {
  return {
    id: d.id ?? d._id ?? null,
    name: d.name ?? d.filename ?? null,
    status: d.status ?? null,
    type: d.type ?? null,
    createdAt: d.created_at ?? null,
    updatedAt: d.updated_at ?? null,
  };
}

// =============================================================================
// LIST INBOX DOCUMENTS
// =============================================================================

export const listInboxDocuments: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List inbox documents from Holded. The inbox contains documents received from external sources. Returns documents with id, name, status, type, and timestamps. Supports pagination and status filtering.',
  parameters: {
    type: 'object',
    properties: {
      page: {
        type: 'number',
        description: 'Page number for pagination (default: 1)',
        default: 1,
      },
      limit: {
        type: 'number',
        description: 'Number of results per page (default: 25, max: 100)',
        default: 25,
      },
      status: {
        type: 'string',
        description: 'Filter by document status (e.g. pending, processed, rejected)',
      },
    },
  },
  handler: async (args, context) => {
    const { page = 1, limit = 25, status } = args as {
      page?: number;
      limit?: number;
      status?: string;
    };

    const params: Record<string, string | number> = { page, limit };
    if (status) params.status = status;

    const data = (await holdedRequest(context, '/v2/inbox', {
      params,
    })) as HoldedInboxDocument[] | { items?: HoldedInboxDocument[]; has_more?: boolean; cursor?: string };

    const rawDocs = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    const documents = rawDocs.map(mapInboxDocument);

    return { documents, count: documents.length, page, limit, hasMore, cursor };
  },
};

// =============================================================================
// GET INBOX DOCUMENT
// =============================================================================

export const getInboxDocument: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get a single inbox document from Holded by its ID.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded inbox document ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/v2/inbox/${encodeURIComponent(id)}`,
    )) as HoldedInboxDocument;

    return mapInboxDocument(data);
  },
};
