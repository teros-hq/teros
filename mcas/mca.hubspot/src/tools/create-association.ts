import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest, resolveAssociationTypeId } from '../lib';

// Engagement objects are valid association endpoints too — needed for manual
// remediation when create-engagement could not associate a record.
const FROM_TYPES = ['contacts', 'companies', 'deals', 'tickets', 'tasks', 'notes', 'calls', 'emails', 'meetings'];
const TO_TYPES = ['contacts', 'companies', 'deals', 'tickets', 'tasks', 'notes', 'calls', 'emails', 'meetings'];

export const createAssociation: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create an association between two HubSpot CRM objects (e.g., contact-company, deal-contact, task-deal). Uses v4 associations API with the verified HUBSPOT_DEFINED typeId for the pair. Params: fromObjectType, fromObjectId, toObjectType, toObjectId, associationTypeId?',
  parameters: {
    type: 'object',
    properties: {
      fromObjectType: {
        type: 'string',
        description: 'Source object type: contacts, companies, deals, tickets, tasks, notes, calls, emails, meetings.',
        enum: FROM_TYPES,
      },
      fromObjectId: { type: 'string', description: 'Source object HubSpot ID.' },
      toObjectType: {
        type: 'string',
        description: 'Target object type: contacts, companies, deals, tickets, tasks, notes, calls, emails, meetings.',
        enum: TO_TYPES,
      },
      toObjectId: { type: 'string', description: 'Target object HubSpot ID.' },
      associationTypeId: {
        type: 'string',
        description:
          'Optional association type ID (e.g. "216" for task→deal). If omitted, the verified default HUBSPOT_DEFINED typeId for the pair is used.',
      },
    },
    required: ['fromObjectType', 'fromObjectId', 'toObjectType', 'toObjectId'],
  },
  handler: async (args, context) => {
    const { fromObjectType, fromObjectId, toObjectType, toObjectId, associationTypeId } = args as {
      fromObjectType: string;
      fromObjectId: string;
      toObjectType: string;
      toObjectId: string;
      associationTypeId?: string;
    };

    // Resolve the pair's verified typeId. The old fallback hardcoded typeId 1
    // (contact→primary company) for every pair, which HubSpot rejects with
    // HTTP 400 for any other pair. Unknown pair + no explicit id → explicit
    // error instead of a guessed typeId.
    const typeId = associationTypeId ?? resolveAssociationTypeId(fromObjectType, toObjectType);

    if (typeId === undefined) {
      return {
        success: false,
        error: `No verified HUBSPOT_DEFINED association type for ${fromObjectType} → ${toObjectType}. Pass an explicit associationTypeId (GET /crm/v4/associations/${fromObjectType}/${toObjectType}/labels lists the valid ones).`,
      };
    }

    const body: Record<string, any> = {
      inputs: [
        {
          from: { id: fromObjectId },
          to: { id: toObjectId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }],
        },
      ],
    };

    const data = (await hubspotRequest(
      context,
      `/crm/v4/associations/${fromObjectType}/${toObjectType}/batch/create`,
      { method: 'POST', body },
    )) as any;

    // v4 batch/create response: { status, results: [{ from: {id}, to: {id} }] }
    const created = (data.results ?? []).map((r: any) => ({
      fromObjectId: String(r.from?.id ?? fromObjectId),
      toObjectId: String(r.to?.id ?? toObjectId),
    }));

    return {
      associations: created.length > 0 ? created : [{ fromObjectId, toObjectId }],
      success: true,
      associationTypeId: typeId,
    };
  },
};
