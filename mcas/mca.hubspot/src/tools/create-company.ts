import type { ToolConfig } from '@teros/mca-sdk';
import { buildProperties, hubspotRequest, formatCompany } from '../lib';

export const createCompany: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a new HubSpot company. Returns curated company shape. Not retryable. Params: name, domain?, industry?, type?, phone?, website?, city?, state?, country?, numberOfEmployees?, annualRevenue?, lifecycleStage?, properties?',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Company name (required).' },
      domain: { type: 'string', description: 'Company domain (e.g. "example.com").' },
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
    required: ['name'],
  },
  handler: async (args, context) => {
    const { name, domain, industry, type, phone, website, city, state, country, numberOfEmployees, annualRevenue, lifecycleStage, properties: extraProps } = args as {
      name: string;
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
      name,
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

    const data = (await hubspotRequest(context, '/crm/v3/objects/companies', {
      method: 'POST',
      body: buildProperties(payload),
    })) as any;

    return formatCompany(data);
  },
};
