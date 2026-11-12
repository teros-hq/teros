import type { ToolConfig } from '@teros/mca-sdk';
import { quickbooksRequest } from '../lib/client';
import { formatCompanyInfo } from '../lib/formatters';

export const getCompanyInfo: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Retrieve QuickBooks Online company information — company name, legal name, country, currency, fiscal year start, tax form, address, email, phone, and website.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const data = await quickbooksRequest(
      'query?query=SELECT%20*%20FROM%20CompanyInfo',
      context,
      'GET',
    );
    return formatCompanyInfo(data);
  },
};
