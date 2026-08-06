import type { ToolConfig } from '@teros/mca-sdk';
import { brevoRequest } from '../lib/brevo-client';
import { clampInt, shapeTemplate } from './_helpers';

interface ListTemplatesResponse {
  templates?: unknown[];
  count?: number;
}

/**
 * list-email-templates — GET /smtp/templates.
 *
 * `templateStatus` is an optional tri-state filter: true=active only,
 * false=inactive only, omitted=all. The template HTML body is intentionally
 * dropped from each item (see `shapeTemplate`) to keep the context small.
 */
export const listEmailTemplates: ToolConfig = {
  description:
    'List transactional email templates from Brevo (GET /smtp/templates). Returns { templates:[{id,name,subject,isActive,testSent,sender,replyTo,toField,tag,createdAt,modifiedAt}], count, templateStatus, limit, offset }. Params: templateStatus? (true=active only, false=inactive only, omit for all), limit? (1-1000, default 50), offset? (default 0).',
  parameters: {
    type: 'object',
    properties: {
      templateStatus: {
        type: 'boolean',
        description: 'Filter by status: true=active only, false=inactive only. Omit to return all.',
      },
      limit: {
        type: 'number',
        description: 'Max templates to return (1-1000, default 50).',
        default: 50,
      },
      offset: {
        type: 'number',
        description: 'Index of the first template for pagination (default 0).',
        default: 0,
      },
    },
  },
  annotations: {
    version: '1.0.0',
    stability: 'stable',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const templateStatus = typeof a.templateStatus === 'boolean' ? a.templateStatus : undefined;
    const limit = clampInt(a.limit, 1, 1000, 50);
    const offset = clampInt(a.offset, 0, Number.MAX_SAFE_INTEGER, 0);

    const res = await brevoRequest<ListTemplatesResponse>(context, '/smtp/templates', {
      query: { templateStatus, limit, offset },
    });

    const templates = (res.templates ?? []).map(shapeTemplate);
    return {
      templates,
      count: typeof res.count === 'number' ? res.count : templates.length,
      templateStatus: templateStatus ?? null,
      limit,
      offset,
    };
  },
};
