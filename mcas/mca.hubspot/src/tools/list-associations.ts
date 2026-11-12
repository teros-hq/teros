import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest } from '../lib';

// Engagement objects are valid association endpoints too, so associations
// created by create-engagement can be verified from either side.
const OBJECT_TYPES = ['contacts', 'companies', 'deals', 'tickets', 'tasks', 'notes', 'calls', 'emails', 'meetings'];

export const listAssociations: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List the associated records of a given type for a HubSpot object (e.g., a deal\'s tasks, a contact\'s companies). Uses GET /crm/v4/objects/{objectType}/{objectId}/associations/{toObjectType}. Params: objectType, objectId, toObjectType, limit?',
  parameters: {
    type: 'object',
    properties: {
      objectType: {
        type: 'string',
        description: 'Object type of the record being queried.',
        enum: OBJECT_TYPES,
      },
      objectId: { type: 'string', description: 'HubSpot object ID.' },
      toObjectType: {
        type: 'string',
        description: 'Associated object type to retrieve (e.g., tasks for a deal).',
        enum: OBJECT_TYPES,
      },
      limit: { type: 'number', description: 'Max results. Default 100.' },
    },
    required: ['objectType', 'objectId', 'toObjectType'],
  },
  handler: async (args, context) => {
    const { objectType, objectId, toObjectType, limit = 100 } = args as {
      objectType: string;
      objectId: string;
      toObjectType: string;
      limit?: number;
    };

    // v4 route: /crm/v4/objects/{fromType}/{fromId}/associations/{toType}.
    // The previous /crm/v4/associations/{a}/{b}/{objectId} path is not a real
    // endpoint — it 404s, so association verification never worked.
    const data = (await hubspotRequest(
      context,
      `/crm/v4/objects/${objectType}/${encodeURIComponent(objectId)}/associations/${toObjectType}`,
      { params: { limit: Math.min(limit, 500) } },
    )) as any;

    // v4 GET response: { results: [{ toObjectId, associationTypes: [{category, typeId, label}] }] }
    const associations = (data.results ?? []).map((r: any) => ({
      toObjectId: String(r.toObjectId ?? r.to?.id ?? ''),
      associationTypes: (r.associationTypes ?? []).map((t: any) => ({
        category: t.category ?? null,
        typeId: t.typeId ?? null,
        label: t.label ?? null,
      })),
    }));

    return {
      associations,
      total: associations.length,
    };
  },
};
