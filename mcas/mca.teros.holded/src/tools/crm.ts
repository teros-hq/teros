import { holdedRequest } from '../lib/index.js';
import type { ToolConfig } from '@teros/mca-sdk';

// =============================================================================
// TYPES
// =============================================================================

/** Raw funnel shape returned by the Holded API */
interface HoldedFunnel {
  id?: string;
  _id?: string;
  name?: string;
  stages?: HoldedFunnelStage[];
  lead_count?: number;
  leads_count?: number;
  created_at?: string;
  updated_at?: string;
}

interface HoldedFunnelStage {
  id?: string;
  name?: string;
  position?: number;
}

/** Curated funnel output */
interface CuratedFunnel {
  id: string | null;
  name: string | null;
  stages: CuratedFunnelStage[];
  leadCount: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface CuratedFunnelStage {
  id: string | null;
  name: string | null;
  position: number | null;
}

/** Raw lead shape returned by the Holded API */
interface HoldedLead {
  id?: string;
  _id?: string;
  name?: string;
  email?: string;
  phone?: string;
  company?: string;
  funnel_id?: string;
  funnel?: string;
  funnel_name?: string;
  stage_id?: string;
  stage?: string;
  stage_name?: string;
  status?: string;
  value?: number;
  currency?: string;
  source?: string;
  owner_id?: string;
  assigned_to?: string;
  contact_id?: string;
  expected_close_date?: string;
  description?: string;
  tags?: string[];
  notes?: string;
  custom_fields?: unknown;
  created_at?: string;
  updated_at?: string;
}

/** Curated lead output (list) */
interface CuratedLead {
  id: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  funnelId: string | null;
  funnelName: string | null;
  stageId: string | null;
  stageName: string | null;
  status: string | null;
  value: number | null;
  currency: string | null;
  source: string | null;
  ownerId: string | null;
  contactId: string | null;
  expectedCloseDate: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Curated lead output (detail) */
interface CuratedLeadDetail extends CuratedLead {
  description: string | null;
  tags: string[] | null;
  notes: string | null;
  customFields: unknown;
}

// =============================================================================
// MAPPING HELPERS
// =============================================================================

function mapFunnelStage(s: HoldedFunnelStage): CuratedFunnelStage {
  return {
    id: s.id ?? null,
    name: s.name ?? null,
    position: s.position ?? null,
  };
}

function mapFunnel(f: HoldedFunnel): CuratedFunnel {
  return {
    id: f.id ?? f._id ?? null,
    name: f.name ?? null,
    stages: (f.stages ?? []).map(mapFunnelStage),
    leadCount: f.lead_count ?? f.leads_count ?? null,
    createdAt: f.created_at ?? null,
    updatedAt: f.updated_at ?? null,
  };
}

function mapLead(l: HoldedLead): CuratedLead {
  return {
    id: l.id ?? l._id ?? null,
    name: l.name ?? null,
    email: l.email ?? null,
    phone: l.phone ?? null,
    company: l.company ?? null,
    funnelId: l.funnel_id ?? l.funnel ?? null,
    funnelName: l.funnel_name ?? null,
    stageId: l.stage_id ?? l.stage ?? null,
    stageName: l.stage_name ?? null,
    status: l.status ?? null,
    value: l.value ?? null,
    currency: l.currency ?? null,
    source: l.source ?? null,
    ownerId: l.owner_id ?? l.assigned_to ?? null,
    contactId: l.contact_id ?? null,
    expectedCloseDate: l.expected_close_date ?? null,
    createdAt: l.created_at ?? null,
    updatedAt: l.updated_at ?? null,
  };
}

function mapLeadDetail(l: HoldedLead): CuratedLeadDetail {
  return {
    ...mapLead(l),
    description: l.description ?? null,
    tags: l.tags ?? null,
    notes: l.notes ?? null,
    customFields: l.custom_fields ?? null,
  };
}

// =============================================================================
// LIST FUNNELS
// =============================================================================

export const listFunnels: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List CRM funnels from Holded. Funnels represent sales pipelines with stages that leads move through.',
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

    const data = (await holdedRequest(context, '/v2/funnels', {
      params: { page, limit },
    })) as any;

    const funnels = Array.isArray(data) ? data : (data?.items ?? []);

    return {
      funnels: funnels.map(mapFunnel),
      count: funnels.length,
      page,
      limit,
    };
  },
};

// =============================================================================
// GET FUNNEL
// =============================================================================

export const getFunnel: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get a single CRM funnel from Holded by its ID, including its stages.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded funnel ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/v2/funnels/${encodeURIComponent(id)}`,
    )) as HoldedFunnel;

    return mapFunnel(data);
  },
};

// =============================================================================
// LIST LEADS
// =============================================================================

export const listLeads: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List CRM leads from Holded. Returns leads with id, name, email, phone, stage, funnel, and value. Supports pagination and filtering by funnel and stage.',
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
      funnelId: {
        type: 'string',
        description: 'Filter leads by funnel ID',
      },
      stageId: {
        type: 'string',
        description: 'Filter leads by stage ID',
      },
    },
  },
  handler: async (args, context) => {
    const { page = 1, limit = 25, funnelId, stageId } = args as {
      page?: number;
      limit?: number;
      funnelId?: string;
      stageId?: string;
    };

    const params: Record<string, string | number> = { page, limit };
    if (funnelId) params.funnel_id = funnelId;
    if (stageId) params.stage_id = stageId;

    const data = (await holdedRequest(context, '/v2/leads', {
      params,
    })) as any;

    const rawLeads = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    return {
      leads: rawLeads.map(mapLead),
      count: rawLeads.length,
      page,
      limit,
      hasMore,
      cursor,
    };
  },
};

// =============================================================================
// GET LEAD
// =============================================================================

export const getLead: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get a single CRM lead from Holded by its ID, with full detail including description, tags, and custom fields.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded lead ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/v2/leads/${encodeURIComponent(id)}`,
    )) as HoldedLead;

    return mapLeadDetail(data);
  },
};

// =============================================================================
// CREATE LEAD
// =============================================================================

export const createLead: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Create a new CRM lead in Holded.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Lead name (required)' },
      funnelId: { type: 'string', description: 'Funnel ID to place the lead in' },
      stageId: { type: 'string', description: 'Stage ID within the funnel' },
      contactId: { type: 'string', description: 'Associated contact ID' },
      value: { type: 'number', description: 'Estimated deal value' },
      expectedCloseDate: { type: 'string', description: 'Expected close date (ISO date string, e.g. 2026-12-31)' },
      description: { type: 'string', description: 'Lead description' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags to assign to the lead',
      },
    },
    required: ['name'],
  },
  handler: async (args, context) => {
    const {
      name,
      funnelId,
      stageId,
      contactId,
      value,
      expectedCloseDate,
      description,
      tags,
    } = args as {
      name: string;
      funnelId?: string;
      stageId?: string;
      contactId?: string;
      value?: number;
      expectedCloseDate?: string;
      description?: string;
      tags?: string[];
    };

    const body: Record<string, unknown> = { name };
    if (funnelId) body.funnel_id = funnelId;
    if (stageId) body.stage_id = stageId;
    if (contactId) body.contact_id = contactId;
    if (value !== undefined) body.value = value;
    if (expectedCloseDate) body.expected_close_date = expectedCloseDate;
    if (description) body.description = description;
    if (tags) body.tags = tags;

    const data = (await holdedRequest(context, '/v2/leads', {
      method: 'POST',
      body,
    })) as any;

    return {
      id: data.id ?? data._id ?? null,
      name,
      funnelId: funnelId ?? null,
      stageId: stageId ?? null,
      createdAt: data.created_at ?? null,
    };
  },
};

// =============================================================================
// UPDATE LEAD
// =============================================================================

export const updateLead: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Update an existing CRM lead in Holded by its ID. All fields are optional — only provided fields are updated.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The Holded lead ID' },
      name: { type: 'string', description: 'Lead name' },
      funnelId: { type: 'string', description: 'Funnel ID' },
      stageId: { type: 'string', description: 'Stage ID within the funnel' },
      contactId: { type: 'string', description: 'Associated contact ID' },
      value: { type: 'number', description: 'Estimated deal value' },
      expectedCloseDate: { type: 'string', description: 'Expected close date (ISO date string)' },
      description: { type: 'string', description: 'Lead description' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags to assign to the lead',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const {
      id,
      name,
      funnelId,
      stageId,
      contactId,
      value,
      expectedCloseDate,
      description,
      tags,
    } = args as {
      id: string;
      name?: string;
      funnelId?: string;
      stageId?: string;
      contactId?: string;
      value?: number;
      expectedCloseDate?: string;
      description?: string;
      tags?: string[];
    };

    const body: Record<string, unknown> = {};
    if (name) body.name = name;
    if (funnelId) body.funnel_id = funnelId;
    if (stageId) body.stage_id = stageId;
    if (contactId) body.contact_id = contactId;
    if (value !== undefined) body.value = value;
    if (expectedCloseDate) body.expected_close_date = expectedCloseDate;
    if (description) body.description = description;
    if (tags) body.tags = tags;

    const data = (await holdedRequest(
      context,
      `/v2/leads/${encodeURIComponent(id)}`,
      { method: 'PUT', body },
    )) as any;

    return {
      id,
      updatedAt: data.updated_at ?? null,
    };
  },
};

// =============================================================================
// UPDATE LEAD STAGE
// =============================================================================

export const updateLeadStage: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Move a CRM lead to a different stage within its funnel. This is the primary action for advancing leads through the sales pipeline.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded lead ID',
      },
      stageId: {
        type: 'string',
        description: 'The target stage ID to move the lead to',
      },
    },
    required: ['id', 'stageId'],
  },
  handler: async (args, context) => {
    const { id, stageId } = args as { id: string; stageId: string };

    const data = (await holdedRequest(
      context,
      `/v2/leads/${encodeURIComponent(id)}/stage`,
      {
        method: 'POST',
        body: { stage_id: stageId },
      },
    )) as any;

    return {
      id,
      stageId,
      updatedAt: data.updated_at ?? null,
    };
  },
};

// =============================================================================
// DELETE LEAD
// =============================================================================

export const deleteLead: ToolConfig = {
  description: 'Delete a CRM lead from Holded by its ID. This action is irreversible.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded lead ID to delete',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    await holdedRequest(context, `/v2/leads/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });

    return {
      id,
      deleted: true,
    };
  },
};
