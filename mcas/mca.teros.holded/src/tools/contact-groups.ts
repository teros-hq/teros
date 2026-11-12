import { holdedRequest } from '../lib/index.js';
import type { ToolConfig } from '@teros/mca-sdk';

// =============================================================================
// TYPES
// =============================================================================

/** Raw contact group shape returned by the Holded API */
interface HoldedContactGroup {
  id?: string;
  _id?: string;
  name?: string;
  description?: string;
  contact_count?: number;
  contacts_count?: number;
  contacts?: unknown[];
  created_at?: string;
  updated_at?: string;
}

/** Curated contact group output for list views */
interface CuratedContactGroup {
  id: string | null;
  name: string | null;
  description: string | null;
  contactCount: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Curated contact group output with members (for get-contact-group) */
interface CuratedContactGroupDetail extends CuratedContactGroup {
  contacts: unknown[] | null;
}

// =============================================================================
// MAPPING HELPERS
// =============================================================================

function mapContactGroup(g: HoldedContactGroup): CuratedContactGroup {
  return {
    id: g.id ?? g._id ?? null,
    name: g.name ?? null,
    description: g.description ?? null,
    contactCount: g.contact_count ?? g.contacts_count ?? null,
    createdAt: g.created_at ?? null,
    updatedAt: g.updated_at ?? null,
  };
}

function mapContactGroupDetail(g: HoldedContactGroup): CuratedContactGroupDetail {
  return {
    ...mapContactGroup(g),
    contacts: g.contacts ?? null,
  };
}

// =============================================================================
// LIST CONTACT GROUPS
// =============================================================================

export const listContactGroups: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List contact groups from Holded. Contact groups are used to organize contacts into categories or segments. Supports pagination via page and limit.',
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

    const data = (await holdedRequest(context, '/v2/contact-groups', {
      params: { page, limit },
    })) as HoldedContactGroup[] | { items?: HoldedContactGroup[]; has_more?: boolean; cursor?: string };

    const rawGroups = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    const groups = rawGroups.map(mapContactGroup);

    return { groups, count: groups.length, page, limit, hasMore, cursor };
  },
};

// =============================================================================
// GET CONTACT GROUP
// =============================================================================

export const getContactGroup: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get a single contact group from Holded by its ID. Returns the group details including its member contacts.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded contact group ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/v2/contact-groups/${encodeURIComponent(id)}`,
    )) as HoldedContactGroup;

    return mapContactGroupDetail(data);
  },
};

// =============================================================================
// CREATE CONTACT GROUP
// =============================================================================

export const createContactGroup: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Create a new contact group in Holded.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Group name',
      },
      description: {
        type: 'string',
        description: 'Group description',
      },
      contactIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of contact IDs to add to this group',
      },
    },
    required: ['name'],
  },
  handler: async (args, context) => {
    const { name, description, contactIds } = args as {
      name: string;
      description?: string;
      contactIds?: string[];
    };

    const body: Record<string, unknown> = { name };
    if (description) body.description = description;
    if (contactIds) body.contact_ids = contactIds;

    const data = (await holdedRequest(context, '/v2/contact-groups', {
      method: 'POST',
      body,
    })) as HoldedContactGroup;

    return {
      id: data.id ?? data._id ?? null,
      name,
      description: description ?? null,
      createdAt: data.created_at ?? null,
    };
  },
};

// =============================================================================
// UPDATE CONTACT GROUP
// =============================================================================

export const updateContactGroup: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Update an existing contact group in Holded by its ID.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded contact group ID',
      },
      name: {
        type: 'string',
        description: 'New group name',
      },
      description: {
        type: 'string',
        description: 'New group description',
      },
      contactIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of contact IDs to set for this group (replaces existing)',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id, name, description, contactIds } = args as {
      id: string;
      name?: string;
      description?: string;
      contactIds?: string[];
    };

    const body: Record<string, unknown> = {};
    if (name) body.name = name;
    if (description) body.description = description;
    if (contactIds) body.contact_ids = contactIds;

    const data = (await holdedRequest(
      context,
      `/v2/contact-groups/${encodeURIComponent(id)}`,
      { method: 'PUT', body },
    )) as HoldedContactGroup;

    return {
      id,
      name: name ?? null,
      description: description ?? null,
      updatedAt: data.updated_at ?? null,
    };
  },
};

// =============================================================================
// DELETE CONTACT GROUP
// =============================================================================

export const deleteContactGroup: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Delete a contact group from Holded by its ID.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded contact group ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    await holdedRequest(
      context,
      `/v2/contact-groups/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );

    return { id, deleted: true };
  },
};
