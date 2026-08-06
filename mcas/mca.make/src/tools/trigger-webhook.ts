import type { ToolConfig } from '@teros/mca-sdk';
import { triggerWebhook } from '../lib/make-client';

const VERSION = '1.0.0';

/**
 * trigger-webhook — the primary Make.com tool. POSTs a JSON payload to a Make
 * webhook URL. No account token needed; the user supplies their own webhook URL.
 * The host is validated (`*.make.com`) inside `triggerWebhook` (SSRF guard).
 */
export const triggerWebhookTool: ToolConfig<{ webhookUrl: string; payload: unknown }, unknown> = {
  description:
    'Trigger a Make.com scenario by POSTing a JSON payload to its webhook URL. No account token required — the user supplies the webhook URL (https://hook.<region>.make.com/<token>). Returns { delivered, statusCode, webhookHost, region, responseType, response }.',
  parameters: {
    type: 'object',
    properties: {
      webhookUrl: {
        type: 'string',
        description:
          'The Make.com webhook URL (https://hook.<region>.make.com/<token>). Only *.make.com hosts over https are accepted.',
      },
      payload: {
        // The handler accepts an object/array (sent as application/json) OR a
        // string (JSON string forwarded as-is, otherwise sent as text/plain).
        oneOf: [{ type: 'object', additionalProperties: true }, { type: 'string' }],
        description:
          'Body sent to the webhook. A JSON object is sent as application/json; a string is forwarded as-is (JSON string → application/json, otherwise text/plain).',
      },
    },
    required: ['webhookUrl', 'payload'],
  },
  annotations: {
    version: VERSION,
    stability: 'stable',
    readOnlyHint: false,
    // Triggers downstream automations in the user's connected services.
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const webhookUrl = String(args.webhookUrl ?? '');
    return triggerWebhook(webhookUrl, args.payload, { signal: context.signal });
  },
};
