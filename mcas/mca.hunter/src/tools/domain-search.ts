import type { ToolConfig } from '@teros/mca-sdk';
import { hunterGetEnvelope } from '../lib/hunter-client';
import { HunterError } from '../lib/errors';
import { optionalInt, requireDomain } from '../lib/validation';
import { getApiKey } from './_secrets';

const VERSION = '1.0.0';

interface RawEmail {
  value: string;
  type?: string;
  confidence?: number;
  first_name?: string | null;
  last_name?: string | null;
  position?: string | null;
  seniority?: string | null;
  department?: string | null;
  linkedin?: string | null;
  twitter?: string | null;
  phone_number?: string | null;
}

interface RawDomainSearch {
  domain?: string;
  organization?: string | null;
  pattern?: string | null;
  webmail?: boolean;
  disposable?: boolean;
  accept_all?: boolean;
  emails?: RawEmail[];
}

export interface DomainSearchEmail {
  value: string;
  type: string | null;
  confidence: number | null;
  firstName: string | null;
  lastName: string | null;
  position: string | null;
  seniority: string | null;
  department: string | null;
  linkedin: string | null;
  twitter: string | null;
  phoneNumber: string | null;
}

export interface DomainSearchOutput {
  domain: string;
  organization: string | null;
  pattern: string | null;
  webmail: boolean;
  disposable: boolean;
  acceptAll: boolean;
  total: number;
  emails: DomainSearchEmail[];
}

function curateEmail(e: RawEmail): DomainSearchEmail {
  return {
    value: e.value,
    type: e.type ?? null,
    confidence: typeof e.confidence === 'number' ? e.confidence : null,
    firstName: e.first_name ?? null,
    lastName: e.last_name ?? null,
    position: e.position ?? null,
    seniority: e.seniority ?? null,
    department: e.department ?? null,
    linkedin: e.linkedin ?? null,
    twitter: e.twitter ?? null,
    phoneNumber: e.phone_number ?? null,
  };
}

export const domainSearch: ToolConfig<
  { domain: string; limit?: number; offset?: number },
  DomainSearchOutput
> = {
  description:
    'Find professional email addresses for a company domain. Returns the domain pattern, organization, and a list of emails with confidence, name, position and department. Returns { domain, organization, pattern, total, emails[] }.',
  parameters: {
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        description: 'Company domain to search (e.g. "stripe.com"). A full URL is also accepted.',
      },
      limit: {
        type: 'number',
        description: 'Max number of emails to return (1-100, default 10).',
      },
      offset: {
        type: 'number',
        description: 'Number of emails to skip for pagination (>= 0, default 0).',
      },
    },
    required: ['domain'],
  },
  annotations: {
    version: VERSION,
    stability: 'stable',
    readOnlyHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const domain = requireDomain(args.domain);
    const limit = optionalInt(args.limit, 'limit', 1, 100);
    const offset = optionalInt(args.offset, 'offset', 0, 100_000);
    const apiKey = await getApiKey(context);

    const { data, meta } = await hunterGetEnvelope<RawDomainSearch>('/domain-search', {
      apiKey,
      searchParams: { domain, limit, offset },
      signal: context.signal,
    });

    if (!data || typeof data !== 'object') {
      throw new HunterError('DEPENDENCY_UNAVAILABLE', 'Hunter returned an unexpected domain-search payload');
    }

    const emails = Array.isArray(data.emails) ? data.emails.map(curateEmail) : [];

    return {
      domain: data.domain ?? domain,
      organization: data.organization ?? null,
      pattern: data.pattern ?? null,
      webmail: data.webmail ?? false,
      disposable: data.disposable ?? false,
      acceptAll: data.accept_all ?? false,
      // `meta.results` is the real total across all pages; `emails.length` is
      // just the current page size (the fallback when meta is absent).
      total: typeof meta?.results === 'number' ? meta.results : emails.length,
      emails,
    };
  },
};
