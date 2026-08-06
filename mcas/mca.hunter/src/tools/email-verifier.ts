import type { ToolConfig } from '@teros/mca-sdk';
import { hunterGet } from '../lib/hunter-client';
import { HunterError } from '../lib/errors';
import { requireEmail } from '../lib/validation';
import { getApiKey } from './_secrets';

const VERSION = '1.0.0';

interface RawEmailVerifier {
  email?: string;
  status?: string | null;
  result?: string | null;
  score?: number | null;
  regexp?: boolean;
  gibberish?: boolean;
  disposable?: boolean;
  webmail?: boolean;
  mx_records?: boolean;
  smtp_server?: boolean;
  smtp_check?: boolean;
  accept_all?: boolean;
  block?: boolean;
}

export interface EmailVerifierOutput {
  email: string;
  status: string | null;
  result: string | null;
  score: number | null;
  gibberish: boolean;
  disposable: boolean;
  webmail: boolean;
  acceptAll: boolean;
  block: boolean;
  mxRecords: boolean;
  smtpServer: boolean;
  smtpCheck: boolean;
}

export const emailVerifier: ToolConfig<{ email: string }, EmailVerifierOutput> = {
  description:
    'Verify whether an email address is deliverable. Returns a status (valid / invalid / accept_all / webmail / disposable / unknown), a result (deliverable / risky / undeliverable) and a 0-100 score plus the underlying checks. Returns { email, status, result, score }.',
  parameters: {
    type: 'object',
    properties: {
      email: { type: 'string', description: 'The email address to verify (e.g. "patrick@stripe.com").' },
    },
    required: ['email'],
  },
  annotations: {
    version: VERSION,
    stability: 'stable',
    readOnlyHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const email = requireEmail(args.email);
    const apiKey = await getApiKey(context);

    const data = await hunterGet<RawEmailVerifier>('/email-verifier', {
      apiKey,
      searchParams: { email },
      signal: context.signal,
    });

    if (!data || typeof data !== 'object') {
      throw new HunterError('DEPENDENCY_UNAVAILABLE', 'Hunter returned an unexpected email-verifier payload');
    }

    return {
      email: data.email ?? email,
      status: data.status ?? null,
      result: data.result ?? null,
      score: typeof data.score === 'number' ? data.score : null,
      gibberish: data.gibberish ?? false,
      disposable: data.disposable ?? false,
      webmail: data.webmail ?? false,
      acceptAll: data.accept_all ?? false,
      block: data.block ?? false,
      mxRecords: data.mx_records ?? false,
      smtpServer: data.smtp_server ?? false,
      smtpCheck: data.smtp_check ?? false,
    };
  },
};
