import type { ToolConfig } from '@teros/mca-sdk';
import { buildProperties, hubspotRequest, formatCompany } from '../lib';

export const updateCompany: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Update an existing HubSpot company. Idempotent per-field — safe to retry. Params: companyId, name?, domain?, industry?, type?, phone?, website?, city?, state?, country?, numberOfEmployees?, annualRevenue?, lifecycleStage?, properties?',
  parameters: {
    type: 'object',
    properties: {
      companyId: { type: 'string', description: 'HubSpot company ID.' },
      name: { type: 'string', description: 'Company name.' },
      domain: { type: 'string', description: 'Company domain.' },
      industry: { type: 'string', description: 'Industry.' },
      type: { type: 'string', description: 'Company type.' },
      phone: { type: 'string', description: 'Phone number.' },
      website: { type: 'string', description: 'Website URL.' },
      city: { type: 'string', description: 'City.' },
      state: { type: 'string', description: 'State/region.' },
      country: { type: 'string', description: 'Country.' },
      numberOfEmployees: { type: 'number', description: 'Number of employees.' },
      annualRevenue: { type: 'number', description: 'Annual revenue.' },
      lifecycleStage: {
        type: 'string',
        description: 'Lifecycle stage.',
        enum: ['subscriber', 'lead', 'marketingqualifiedlead', 'salesqualifiedlead', 'opportunity', 'customer', 'evangelist', 'other'],
      },
      properties: {
        type: 'object',
        description: 'Additional HubSpot company properties as key-value pairs.',
      },
    },
    required: ['companyId'],
  },
  handler: async (args, context) => {
    const { companyId, name, domain, industry, type, phone, website, city, state, country, numberOfEmployees, annualRevenue, lifecycleStage, properties: extraProps } = args as {
      companyId: string;
      name?: string;
      domain?: string;
      industry?: string;
      type?: string;
      phone?: string;
      website?: string;
      city?: string;
      state?: string;
      country?: string;
      numberOfEmployees?: number;
      annualRevenue?: number;
      lifecycleStage?: string;
      properties?: Record<string, string>;
    };

    const payload: Record<string, any> = {
      ...(name && { name }),
      ...(domain && { domain }),
      ...(industry && { industry }),
      ...(type && { type }),
      ...(phone && { phone }),
      ...(website && { website }),
      ...(city && { city }),
      ...(state && { state }),
      ...(country && { country }),
      ...(numberOfEmployees && { numberofemployees: numberOfEmployees }),
      ...(annualRevenue && { annualrevenue: annualRevenue }),
      ...(lifecycleStage && { lifecyclestage: lifecycleStage }),
      ...extraProps,
    };

    const data = (await hubspotRequest(context, `/crm/v3/objects/companies/${encodeURIComponent(companyId)}`, {
      method: 'PATCH',
      body: buildProperties(payload),
    })) as any;

    return formatCompany(data);
  },
};
