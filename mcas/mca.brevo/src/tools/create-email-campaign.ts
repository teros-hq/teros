import type { ToolConfig } from '@teros/mca-sdk';
import { brevoRequest } from '../lib/brevo-client';
import { buildCampaignBody, validateCreateCampaignArgs } from './_helpers';

interface CreateCampaignResponse {
  id?: number;
}

/**
 * create-email-campaign — POST /emailCampaigns.
 *
 * Creates a campaign (newsletter). Without `scheduledAt` it's a draft you send
 * later with `send-email-campaign`; with `scheduledAt` (and listIds) Brevo
 * schedules it. Content is EXACTLY ONE of htmlContent / htmlUrl / templateId.
 * Creating a campaign is reversible (it can be deleted before sending), so it's
 * not marked irreversible/destructive — only the actual send is.
 */
export const createEmailCampaign: ToolConfig = {
  description:
    'Create an email campaign (newsletter) in Brevo (POST /emailCampaigns). Returns { id, name, subject, scheduledAt }. Provide content via EXACTLY ONE of htmlContent (≥10 chars), htmlUrl or templateId. sender is { email } XOR { id }. Add recipients{listIds} to target lists; if scheduledAt (ISO 8601) is set, listIds is required. Without scheduledAt the campaign is a draft you send later with send-email-campaign. Params: name (required), subject (required), sender{email?,id?,name?} (required), htmlContent?, htmlUrl?, templateId?, recipients{listIds?,exclusionListIds?,segmentIds?}?, scheduledAt?, replyTo?, toField?, tag?, previewText?.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Internal campaign name (required).' },
      subject: { type: 'string', description: 'Email subject line (required).' },
      sender: {
        type: 'object',
        description: 'Sender — EITHER { email } (verified) OR { id }, not both. Optional name.',
        properties: {
          email: { type: 'string', description: 'Verified sender email address.' },
          id: { type: 'number', description: 'Brevo sender id (alternative to email).' },
          name: { type: 'string', description: 'Optional sender display name.' },
        },
      },
      htmlContent: {
        type: 'string',
        description: 'HTML body (≥10 chars). Provide exactly one of htmlContent, htmlUrl or templateId.',
      },
      htmlUrl: {
        type: 'string',
        description: 'Absolute http(s) URL of the HTML body. Provide exactly one of htmlContent, htmlUrl or templateId.',
      },
      templateId: {
        type: 'number',
        description: 'Id of an active transactional template used as content. Provide exactly one of htmlContent, htmlUrl or templateId.',
      },
      recipients: {
        type: 'object',
        description: 'Who receives the campaign. Required to send; listIds is required when scheduledAt is set.',
        properties: {
          listIds: {
            type: 'array',
            description: 'List ids to send to.',
            items: { type: 'number' },
          },
          exclusionListIds: {
            type: 'array',
            description: 'List ids to exclude from the send.',
            items: { type: 'number' },
          },
          segmentIds: {
            type: 'array',
            description: 'Segment ids to send to (alternative to listIds).',
            items: { type: 'number' },
          },
        },
      },
      scheduledAt: {
        type: 'string',
        description: 'ISO 8601 send date-time (e.g. 2026-06-01T12:30:00+02:00). Omit to create a draft sent later with send-email-campaign.',
      },
      replyTo: { type: 'string', description: 'Optional Reply-To email address.' },
      toField: {
        type: 'string',
        description: 'Optional To-field personalization (e.g. {FNAME} {LNAME}).',
      },
      tag: { type: 'string', description: 'Optional campaign tag.' },
      previewText: { type: 'string', description: 'Optional preview text / preheader.' },
    },
    required: ['name', 'subject', 'sender'],
  },
  annotations: {
    readOnlyHint: false,
    version: '1.0.0',
    stability: 'stable',
    openWorldHint: true,
    idempotentHint: false,
  },
  handler: async (args, context) => {
    validateCreateCampaignArgs(args);
    const body = buildCampaignBody(args as Record<string, unknown>);

    const res = await brevoRequest<CreateCampaignResponse>(context, '/emailCampaigns', {
      method: 'POST',
      body,
    });

    return {
      id: typeof res?.id === 'number' ? res.id : null,
      name: body.name,
      subject: body.subject ?? null,
      scheduledAt: body.scheduledAt ?? null,
    };
  },
};
