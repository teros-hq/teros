import { holdedRequest } from '../lib/index.js';
import type { ToolConfig } from '@teros/mca-sdk';

// =============================================================================
// TYPES
// =============================================================================

/** Raw tag shape returned by the Holded API */
interface HoldedTag {
  id?: string;
  _id?: string;
  name?: string;
  color?: string;
  created_at?: string;
}

/** Curated tag output returned by our tools */
interface CuratedTag {
  id: string | null;
  name: string | null;
  color: string | null;
  createdAt: string | null;
}

// =============================================================================
// MAPPING HELPERS
// =============================================================================

function mapTag(t: HoldedTag): CuratedTag {
  return {
    id: t.id ?? t._id ?? null,
    name: t.name ?? null,
    color: t.color ?? null,
    createdAt: t.created_at ?? null,
  };
}

// =============================================================================
// LIST TAGS
// =============================================================================

export const listTags: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List all tags from Holded. Tags can be applied to contacts, documents, and other entities for categorization.',
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
    },
  },
  handler: async (args, context) => {
    const { page = 1, limit = 25 } = args as { page?: number; limit?: number };

    const data = (await holdedRequest(context, '/v2/tags', {
      params: { page, limit },
    })) as HoldedTag[] | { items?: HoldedTag[] };

    const rawTags = Array.isArray(data) ? data : (data?.items ?? []);
    const tags = rawTags.map(mapTag);

    return { tags, count: tags.length, page, limit };
  },
};

// =============================================================================
// CREATE TAG
// =============================================================================

export const createTag: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a new tag in Holded. Tags are used for categorizing contacts, documents, and other entities.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Tag name',
      },
      color: {
        type: 'string',
        description: 'Tag color (hex code, e.g. #FF5733)',
      },
    },
    required: ['name'],
  },
  handler: async (args, context) => {
    const { name, color } = args as { name: string; color?: string };

    const body: Record<string, string> = { name };
    if (color) body.color = color;

    const data = (await holdedRequest(context, '/v2/tags', {
      method: 'POST',
      body,
    })) as HoldedTag;

    return {
      id: data.id ?? data._id ?? null,
      name,
      color: color ?? null,
      createdAt: data.created_at ?? null,
    };
  },
};

// =============================================================================
// DELETE TAG
// =============================================================================

export const deleteTag: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Delete a tag from Holded by its ID.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded tag ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    await holdedRequest(context, `/v2/tags/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });

    return { id, deleted: true };
  },
};
