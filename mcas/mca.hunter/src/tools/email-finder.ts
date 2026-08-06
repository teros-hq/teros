import type { ToolConfig } from '@teros/mca-sdk';
import { hunterGet } from '../lib/hunter-client';
import { HunterError } from '../lib/errors';
import { requireDomain, requireNonEmpty } from '../lib/validation';
import { getApiKey } from './_secrets';

const VERSION = '1.0.0';

interface RawEmailFinder {
  email?: string | null;
  score?: number | null;
  domain?: string;
  first_name?: string | null;
  last_name?: string | null;
  position?: string | null;
  company?: string | null;
  linkedin_url?: string | null;
  twitter?: string | null;
  phone_number?: string | null;
  verification?: { status?: string | null; date?: string | null } | null;
}

export interface EmailFinderOutput {
  email: string | null;
  score: number | null;
  domain: string;
  firstName: string | null;
  lastName: string | null;
  position: string | null;
  company: string | null;
  linkedin: string | null;
  twitter: string | null;
  phoneNumber: string | null;
  verificationStatus: string | null;
}

export const emailFinder: ToolConfig<
  { domain: string; first_name: string; last_name: string },
  EmailFinderOutput
> = {
  description:
    "Guess a specific person's professional email from their first/last name and company domain. Returns the most likely email with a confidence score (0-100). Returns { email, score, domain, firstName, lastName, position }.",
  parameters: {
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        description: 'Company domain (e.g. "stripe.com"). A full URL is also accepted.',
      },
      first_name: { type: 'string', description: "The person's first name." },
      last_name: { type: 'string', description: "The person's last name." },
    },
    required: ['domain', 'first_name', 'last_name'],
  },
  annotations: {
    version: VERSION,
    stability: 'stable',
    readOnlyHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const domain = requireDomain(args.domain);
    const firstName = requireNonEmpty(args.first_name, 'first_name');
    const lastName = requireNonEmpty(args.last_name, 'last_name');
    const apiKey = await getApiKey(context);

    const data = await hunterGet<RawEmailFinder>('/email-finder', {
      apiKey,
      searchParams: { domain, first_name: firstName, last_name: lastName },
      signal: context.signal,
    });

    if (!data || typeof data !== 'object') {
      throw new HunterError('DEPENDENCY_UNAVAILABLE', 'Hunter returned an unexpected email-finder payload');
    }

    return {
      email: data.email ?? null,
      score: typeof data.score === 'number' ? data.score : null,
      domain: data.domain ?? domain,
      firstName: data.first_name ?? firstName,
      lastName: data.last_name ?? lastName,
      position: data.position ?? null,
      company: data.company ?? null,
      linkedin: data.linkedin_url ?? null,
      twitter: data.twitter ?? null,
      phoneNumber: data.phone_number ?? null,
      verificationStatus: data.verification?.status ?? null,
    };
  },
};
