#!/usr/bin/env npx tsx

/**
 * Gmail MCA
 *
 * Gmail email management using McaServer with HTTP transport.
 * Secrets are fetched on-demand from the backend via callbackUrl.
 *
 * Deployment: per-app (each installed app gets its own process)
 */

import { HealthCheckBuilder, McaBackendClient, McaServer } from '@teros/mca-sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { google } from 'googleapis';
import { join } from 'path';
import {
  getWatcherStatus,
  startEmailWatcher,
  stopEmailWatcher,
} from './email-watcher.js';
import {
  createRawEmail,
  encodeAddressDisplayName,
  encodeSubject,
  findAttachments,
  findTextPart,
  getDisplayName,
  processEmailBody,
  resolveBodyFromFile,
} from './helpers.js';

// =============================================================================
// TYPES
// =============================================================================

interface GmailSecrets {
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
  REDIRECT_URIS?: string;
  ACCESS_TOKEN?: string;
  REFRESH_TOKEN?: string;
  EMAIL?: string;
  EXPIRY_DATE?: string;
}

// =============================================================================
// GMAIL CLIENT FACTORY
// =============================================================================

async function createGmailClient(secrets: GmailSecrets) {
  const clientId = secrets.CLIENT_ID;
  const clientSecret = secrets.CLIENT_SECRET;
  const redirectUrisRaw = secrets.REDIRECT_URIS;

  if (!clientId || !clientSecret || !redirectUrisRaw) {
    throw new Error(
      'Gmail OAuth credentials not configured. Missing CLIENT_ID, CLIENT_SECRET, or REDIRECT_URIS.',
    );
  }

  let redirectUri: string;
  try {
    const uris = JSON.parse(redirectUrisRaw);
    redirectUri = Array.isArray(uris) ? uris[0] : redirectUrisRaw;
  } catch {
    redirectUri = redirectUrisRaw;
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  // El backend es el único dueño del refresh_token y sirve siempre un
  // access_token fresco (refresh lazy en /secrets/user, rotation-safe — TER-388).
  // El contenedor NO refresca por su cuenta: pasamos solo el access_token para
  // que googleapis no auto-refresque y reintroduzca el antipatrón de doble dueño
  // (que invalidaba el refresh_token de Google al rotar). Si el token está
  // vencido, la API devuelve 401 y el siguiente getSecrets traerá uno fresco.
  const accessToken = secrets.ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error('Gmail account not connected. Please connect your Google account.');
  }

  oauth2Client.setCredentials({ access_token: accessToken });

  return {
    gmail: google.gmail({ version: 'v1', auth: oauth2Client }),
    email: secrets.EMAIL || 'unknown@gmail.com',
    displayName: getDisplayName(secrets.EMAIL),
  };
}

function createRawEmailWithAttachments(
  to: string,
  subject: string,
  body: string,
  from: string,
  attachments: Array<{ path: string; filename?: string }>,
  options: {
    cc?: string;
    bcc?: string;
    isHtml?: boolean;
    inReplyTo?: string;
    references?: string;
    fromName?: string;
  } = {},
): string {
  const fromHeader = options.fromName ? encodeAddressDisplayName(`"${options.fromName}" <${from}>`) : from;
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).substring(2)}`;

  const lines = [`From: ${fromHeader}`, `To: ${encodeAddressDisplayName(to)}`, `Subject: ${encodeSubject(subject)}`];

  if (options.cc) lines.push(`Cc: ${encodeAddressDisplayName(options.cc)}`);
  if (options.bcc) lines.push(`Bcc: ${encodeAddressDisplayName(options.bcc)}`);
  if (options.inReplyTo) lines.push(`In-Reply-To: ${options.inReplyTo}`);
  if (options.references) lines.push(`References: ${options.references}`);

  lines.push(`MIME-Version: 1.0`);
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  lines.push('');

  // Body part
  lines.push(`--${boundary}`);
  lines.push(`Content-Type: text/${options.isHtml ? 'html' : 'plain'}; charset=utf-8`);
  lines.push('');
  lines.push(body);
  lines.push('');

  // Attachment parts
  for (const attachment of attachments) {
    const filePath = attachment.path.startsWith('/')
      ? attachment.path
      : join(process.cwd(), attachment.path);

    if (!existsSync(filePath)) {
      throw new Error(`Attachment file not found: ${filePath}`);
    }

    const fileContent = readFileSync(filePath);
    const base64Content = fileContent.toString('base64');
    const filename = attachment.filename || filePath.split('/').pop() || 'attachment';

    const ext = filename.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      pdf: 'application/pdf',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      txt: 'text/plain',
      zip: 'application/zip',
    };
    const mimeType = mimeTypes[ext || ''] || 'application/octet-stream';

    lines.push(`--${boundary}`);
    lines.push(`Content-Type: ${mimeType}; name="${filename}"`);
    lines.push(`Content-Disposition: attachment; filename="${filename}"`);
    lines.push(`Content-Transfer-Encoding: base64`);
    lines.push('');

    const base64Lines = base64Content.match(/.{1,76}/g) || [];
    lines.push(...base64Lines);
    lines.push('');
  }

  lines.push(`--${boundary}--`);

  const email = lines.join('\r\n');
  return Buffer.from(email)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.google.gmail',
  name: 'Gmail',
  version: '2.0.0',
});

// -----------------------------------------------------------------------------
// Health Check Tool
// -----------------------------------------------------------------------------

/**
 * Fetch user secrets treating the backend's "no credentials stored" reply as
 * an empty set: that just means the account is not connected, which the
 * checks below report as AUTH_REQUIRED (user action). Without this, the
 * throw fell through to the catch-all and surfaced as SYSTEM_CONFIG_MISSING
 * (admin action), hiding the connect-account flow from the user
 * (2026-07-06 Teros HQ incident). Real transport/config failures still throw.
 */
async function getUserSecretsOrEmpty(context: {
  getUserSecrets: () => Promise<Record<string, string>>;
}): Promise<Record<string, string>> {
  try {
    return await context.getUserSecrets();
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/no user credentials configured/i.test(message)) return {};
    throw error;
  }
}

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies OAuth credentials and connectivity.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (args, context) => {
    const builder = new HealthCheckBuilder().setVersion('2.0.0');

    try {
      const systemSecrets = await context.getSystemSecrets();
      const userSecrets = await getUserSecretsOrEmpty(context);
      const secrets = { ...systemSecrets, ...userSecrets } as GmailSecrets;

      // Check system secrets
      if (!secrets.CLIENT_ID) {
        builder.addIssue('SYSTEM_CONFIG_MISSING', 'Google OAuth Client ID not configured', {
          type: 'admin_action',
          description: 'Configure CLIENT_ID in system secrets',
        });
      }
      if (!secrets.CLIENT_SECRET) {
        builder.addIssue('SYSTEM_CONFIG_MISSING', 'Google OAuth Client Secret not configured', {
          type: 'admin_action',
          description: 'Configure CLIENT_SECRET in system secrets',
        });
      }

      // Check user credentials
      if (!secrets.ACCESS_TOKEN || !secrets.REFRESH_TOKEN) {
        builder.addIssue('AUTH_REQUIRED', 'Gmail account not connected', {
          type: 'user_action',
          description: 'Connect your Google account to use Gmail',
        });
      } else {
        // Try to validate credentials
        try {
          const { gmail } = await createGmailClient(secrets);
          await gmail.users.getProfile({ userId: 'me' });
        } catch (apiError: any) {
          if (apiError.code === 401 || apiError.code === 403) {
            builder.addIssue('AUTH_EXPIRED', 'Gmail access token expired or revoked', {
              type: 'user_action',
              description: 'Reconnect your Google account',
            });
          } else {
            builder.addIssue('DEPENDENCY_UNAVAILABLE', `Gmail API error: ${apiError.message}`, {
              type: 'auto_retry',
              description: 'Gmail API temporarily unavailable',
            });
          }
        }
      }
    } catch (error) {
      builder.addIssue(
        'SYSTEM_CONFIG_MISSING',
        error instanceof Error ? error.message : 'Failed to get secrets',
        {
          type: 'admin_action',
          description: 'Ensure callbackUrl is provided and backend is reachable',
        },
      );
    }

    return builder.build();
  },
});

// -----------------------------------------------------------------------------
// List Messages
// -----------------------------------------------------------------------------

server.tool('list-messages', {
  annotations: { readOnlyHint: true },
  description:
    'List email messages from inbox or specific labels. Supports filtering by unread, starred, etc.',
  parameters: {
    type: 'object',
    properties: {
      maxResults: {
        type: 'number',
        description: 'Maximum number of messages to return (default: 10, max: 100)',
      },
      labelIds: { type: 'array', items: { type: 'string' }, description: 'Label IDs to filter by' },
      query: { type: 'string', description: 'Gmail search query' },
    },
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GmailSecrets;
    const { gmail, email } = await createGmailClient(secrets);

    const maxResults = Math.min((args.maxResults as number) || 10, 100);
    const labelIds = (args.labelIds as string[]) || ['INBOX'];
    const query = args.query as string | undefined;

    const response = await gmail.users.messages.list({
      userId: 'me',
      maxResults,
      labelIds,
      q: query,
    });

    const messages = response.data.messages || [];
    const detailedMessages = await Promise.all(
      messages.map(async (msg: any) => {
        const detail = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Subject', 'Date'],
        });

        const headers = detail.data.payload?.headers || [];
        return {
          id: msg.id,
          threadId: msg.threadId,
          from: headers.find((h: any) => h.name === 'From')?.value,
          to: headers.find((h: any) => h.name === 'To')?.value,
          subject: headers.find((h: any) => h.name === 'Subject')?.value,
          date: headers.find((h: any) => h.name === 'Date')?.value,
          snippet: detail.data.snippet,
          labelIds: detail.data.labelIds,
        };
      }),
    );

    return { account: email, count: detailedMessages.length, messages: detailedMessages };
  },
});

// -----------------------------------------------------------------------------
// Get Message
// -----------------------------------------------------------------------------

server.tool('get-message', {
  annotations: { readOnlyHint: true },
  description: 'Get full details of a specific email message by ID.',
  parameters: {
    type: 'object',
    properties: {
      messageId: { type: 'string', description: 'The ID of the message to retrieve' },
    },
    required: ['messageId'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GmailSecrets;
    const { gmail, email } = await createGmailClient(secrets);

    const messageId = args.messageId as string;
    const response = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const message = response.data;
    const headers = message.payload?.headers || [];
    const body = findTextPart(message.payload);
    const attachments = findAttachments(message.payload);

    return {
      account: email,
      id: message.id,
      threadId: message.threadId,
      from: headers.find((h: any) => h.name === 'From')?.value,
      to: headers.find((h: any) => h.name === 'To')?.value,
      subject: headers.find((h: any) => h.name === 'Subject')?.value,
      date: headers.find((h: any) => h.name === 'Date')?.value,
      body,
      attachments,
      labelIds: message.labelIds,
    };
  },
});

// -----------------------------------------------------------------------------
// Send Message
// -----------------------------------------------------------------------------

server.tool('send-message', {
  annotations: { readOnlyHint: false },
  description: 'Send an email message from the specified account.',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email address' },
      subject: { type: 'string', description: 'Email subject' },
      body: { type: 'string', description: 'Email body (plain text or HTML)' },
      bodyFile: {
        type: 'string',
        description:
          'Path to a file to use as email body (.html/.htm → HTML, .md/.markdown → Markdown auto-converted to HTML, .txt → plain text). Use instead of body to avoid passing large content as a string.',
      },
      cc: { type: 'string', description: 'CC recipients (comma-separated)' },
      bcc: { type: 'string', description: 'BCC recipients (comma-separated)' },
      isHtml: { type: 'boolean', description: 'Whether body is HTML (default: false)' },
      attachments: {
        type: 'array',
        description: 'Array of attachments to include',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
            filename: { type: 'string', description: 'Optional custom filename' },
          },
          required: ['path'],
        },
      },
    },
    required: ['to', 'subject'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GmailSecrets;
    const { gmail, email, displayName } = await createGmailClient(secrets);

    const attachments = args.attachments as Array<{ path: string; filename?: string }> | undefined;

    // Resolve body: from file or from args.body
    const bodyFile = args.bodyFile as string | undefined;
    const rawBody = bodyFile
      ? resolveBodyFromFile(bodyFile)
      : { body: args.body as string, isHtml: args.isHtml as boolean | undefined };

    if (!rawBody.body) {
      throw new Error('Either body or bodyFile must be provided.');
    }

    // Process body: auto-convert Markdown to HTML if detected
    const { body: processedBody, isHtml } = await processEmailBody(
      rawBody.body,
      rawBody.isHtml,
    );

    const rawEmail =
      attachments && attachments.length > 0
        ? createRawEmailWithAttachments(
            args.to as string,
            args.subject as string,
            processedBody,
            email,
            attachments,
            {
              cc: args.cc as string | undefined,
              bcc: args.bcc as string | undefined,
              isHtml,
              fromName: displayName,
            },
          )
        : createRawEmail(args.to as string, args.subject as string, processedBody, email, {
            cc: args.cc as string | undefined,
            bcc: args.bcc as string | undefined,
            isHtml,
            fromName: displayName,
          });

    const response = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: rawEmail },
    });

    return {
      success: true,
      account: email,
      messageId: response.data.id,
      threadId: response.data.threadId,
      htmlConverted: isHtml && !(args.isHtml as boolean),
    };
  },
});

// -----------------------------------------------------------------------------
// Reply Message
// -----------------------------------------------------------------------------

server.tool('reply-message', {
  annotations: { readOnlyHint: false },
  description: 'Reply to an existing email message.',
  parameters: {
    type: 'object',
    properties: {
      messageId: { type: 'string', description: 'The ID of the message to reply to' },
      body: { type: 'string', description: 'Reply body' },
      isHtml: { type: 'boolean', description: 'Whether body is HTML (default: false)' },
    },
    required: ['messageId', 'body'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GmailSecrets;
    const { gmail, email, displayName } = await createGmailClient(secrets);

    const messageId = args.messageId as string;
    const original = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Subject', 'Message-ID', 'References'],
    });

    const headers = original.data.payload?.headers || [];
    const originalFrom = headers.find((h: any) => h.name === 'From')?.value || '';
    const originalTo = headers.find((h: any) => h.name === 'To')?.value || '';
    const originalSubject = headers.find((h: any) => h.name === 'Subject')?.value || '';
    const messageIdHeader = headers.find((h: any) => h.name === 'Message-ID')?.value || '';
    const referencesHeader = headers.find((h: any) => h.name === 'References')?.value || '';

    const replyTo = originalFrom.includes(email) ? originalTo : originalFrom;
    const subject = originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`;
    const references = referencesHeader
      ? `${referencesHeader} ${messageIdHeader}`
      : messageIdHeader;

    // Process body: auto-convert Markdown to HTML if detected
    const { body: processedBody, isHtml } = await processEmailBody(
      args.body as string,
      args.isHtml as boolean | undefined,
    );

    const rawEmail = createRawEmail(replyTo, subject, processedBody, email, {
      isHtml,
      inReplyTo: messageIdHeader,
      references,
      fromName: displayName,
    });

    const response = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: rawEmail,
        threadId: original.data.threadId,
      },
    });

    return {
      success: true,
      account: email,
      messageId: response.data.id,
      threadId: response.data.threadId,
      htmlConverted: isHtml && !(args.isHtml as boolean),
    };
  },
});

// -----------------------------------------------------------------------------
// Search Messages
// -----------------------------------------------------------------------------

server.tool('search-messages', {
  annotations: { readOnlyHint: true },
  description: "Search for email messages using Gmail's search syntax.",
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Gmail search query' },
      maxResults: { type: 'number', description: 'Maximum number of results (default: 10)' },
    },
    required: ['query'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GmailSecrets;
    const { gmail, email } = await createGmailClient(secrets);

    const query = args.query as string;
    const maxResults = Math.min((args.maxResults as number) || 10, 100);

    const response = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults,
    });

    const messages = response.data.messages || [];
    const detailedMessages = await Promise.all(
      messages.map(async (msg: any) => {
        const detail = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Subject', 'Date'],
        });

        const headers = detail.data.payload?.headers || [];
        return {
          id: msg.id,
          threadId: msg.threadId,
          from: headers.find((h: any) => h.name === 'From')?.value,
          to: headers.find((h: any) => h.name === 'To')?.value,
          subject: headers.find((h: any) => h.name === 'Subject')?.value,
          date: headers.find((h: any) => h.name === 'Date')?.value,
          snippet: detail.data.snippet,
        };
      }),
    );

    return { account: email, query, count: detailedMessages.length, messages: detailedMessages };
  },
});

// -----------------------------------------------------------------------------
// Modify Labels
// -----------------------------------------------------------------------------

server.tool('modify-labels', {
  annotations: { readOnlyHint: false },
  description: 'Add or remove labels from a message (e.g., mark as read/unread, archive, star).',
  parameters: {
    type: 'object',
    properties: {
      messageId: { type: 'string', description: 'The ID of the message to modify' },
      addLabelIds: { type: 'array', items: { type: 'string' }, description: 'Labels to add' },
      removeLabelIds: { type: 'array', items: { type: 'string' }, description: 'Labels to remove' },
    },
    required: ['messageId'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GmailSecrets;
    const { gmail, email } = await createGmailClient(secrets);

    const messageId = args.messageId as string;
    const addLabelIds = (args.addLabelIds as string[]) || [];
    const removeLabelIds = (args.removeLabelIds as string[]) || [];

    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { addLabelIds, removeLabelIds },
    });

    return {
      success: true,
      account: email,
      messageId,
      addedLabels: addLabelIds,
      removedLabels: removeLabelIds,
    };
  },
});

// -----------------------------------------------------------------------------
// List Drafts
// -----------------------------------------------------------------------------

server.tool('list-drafts', {
  annotations: { readOnlyHint: true },
  description: 'List all draft emails in the account.',
  parameters: {
    type: 'object',
    properties: {
      maxResults: {
        type: 'number',
        description: 'Maximum number of drafts to return (default: 10, max: 100)',
      },
    },
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GmailSecrets;
    const { gmail, email } = await createGmailClient(secrets);

    const maxResults = Math.min((args.maxResults as number) || 10, 100);

    const response = await gmail.users.drafts.list({
      userId: 'me',
      maxResults,
    });

    const drafts = response.data.drafts || [];
    const detailedDrafts = await Promise.all(
      drafts.map(async (draft: any) => {
        const detail = await gmail.users.drafts.get({
          userId: 'me',
          id: draft.id,
          format: 'metadata',
        });

        const headers = detail.data.message?.payload?.headers || [];
        return {
          draftId: draft.id,
          messageId: draft.message?.id,
          threadId: draft.message?.threadId,
          from: headers.find((h: any) => h.name === 'From')?.value,
          to: headers.find((h: any) => h.name === 'To')?.value,
          subject: headers.find((h: any) => h.name === 'Subject')?.value,
          date: headers.find((h: any) => h.name === 'Date')?.value,
          snippet: detail.data.message?.snippet,
        };
      }),
    );

    return { account: email, count: detailedDrafts.length, drafts: detailedDrafts };
  },
});

// -----------------------------------------------------------------------------
// Create Draft
// -----------------------------------------------------------------------------

server.tool('create-draft', {
  annotations: { readOnlyHint: false },
  description: 'Create a draft email message.',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email address' },
      subject: { type: 'string', description: 'Email subject' },
      body: { type: 'string', description: 'Email body' },
      bodyFile: {
        type: 'string',
        description:
          'Path to a file to use as email body (.html/.htm → HTML, .md/.markdown → Markdown auto-converted to HTML, .txt → plain text). Use instead of body to avoid passing large content as a string.',
      },
      isHtml: { type: 'boolean', description: 'Whether body is HTML (default: false)' },
      attachments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            filename: { type: 'string' },
          },
          required: ['path'],
        },
      },
    },
    required: ['to', 'subject'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GmailSecrets;
    const { gmail, email, displayName } = await createGmailClient(secrets);

    const attachments = args.attachments as Array<{ path: string; filename?: string }> | undefined;

    // Resolve body: from file or from args.body
    const bodyFile = args.bodyFile as string | undefined;
    const rawBody = bodyFile
      ? resolveBodyFromFile(bodyFile)
      : { body: args.body as string, isHtml: args.isHtml as boolean | undefined };

    if (!rawBody.body) {
      throw new Error('Either body or bodyFile must be provided.');
    }

    // Process body: auto-convert Markdown to HTML if detected
    const { body: processedBody, isHtml } = await processEmailBody(
      rawBody.body,
      rawBody.isHtml,
    );

    const rawEmail =
      attachments && attachments.length > 0
        ? createRawEmailWithAttachments(
            args.to as string,
            args.subject as string,
            processedBody,
            email,
            attachments,
            { isHtml, fromName: displayName },
          )
        : createRawEmail(args.to as string, args.subject as string, processedBody, email, {
            isHtml,
            fromName: displayName,
          });

    const response = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw: rawEmail } },
    });

    return {
      success: true,
      account: email,
      draftId: response.data.id,
      messageId: response.data.message?.id,
      htmlConverted: isHtml && !(args.isHtml as boolean),
    };
  },
});

// -----------------------------------------------------------------------------
// Delete Draft
// -----------------------------------------------------------------------------

server.tool('delete-draft', {
  annotations: { readOnlyHint: false, irreversible: true },
  description: 'Delete a draft email by its draft ID.',
  parameters: {
    type: 'object',
    properties: {
      draftId: { type: 'string', description: 'The ID of the draft to delete' },
    },
    required: ['draftId'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GmailSecrets;
    const { gmail, email } = await createGmailClient(secrets);

    const draftId = args.draftId as string;
    await gmail.users.drafts.delete({ userId: 'me', id: draftId });

    return { success: true, account: email, draftId, message: 'Draft deleted successfully' };
  },
});

// -----------------------------------------------------------------------------
// Update Draft
// -----------------------------------------------------------------------------

server.tool('update-draft', {
  annotations: { readOnlyHint: false },
  description: 'Update an existing draft email by replacing its content.',
  parameters: {
    type: 'object',
    properties: {
      draftId: { type: 'string', description: 'The ID of the draft to update' },
      to: { type: 'string', description: 'Recipient email address' },
      subject: { type: 'string', description: 'Email subject' },
      body: { type: 'string', description: 'Email body' },
      bodyFile: {
        type: 'string',
        description:
          'Path to a file to use as email body (.html/.htm → HTML, .md/.markdown → Markdown auto-converted to HTML, .txt → plain text). Use instead of body to avoid passing large content as a string.',
      },
      isHtml: { type: 'boolean', description: 'Whether body is HTML (default: false)' },
      attachments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            filename: { type: 'string' },
          },
          required: ['path'],
        },
      },
    },
    required: ['draftId', 'to', 'subject'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GmailSecrets;
    const { gmail, email, displayName } = await createGmailClient(secrets);

    const draftId = args.draftId as string;
    const attachments = args.attachments as Array<{ path: string; filename?: string }> | undefined;

    // Resolve body: from file or from args.body
    const bodyFile = args.bodyFile as string | undefined;
    const rawBody = bodyFile
      ? resolveBodyFromFile(bodyFile)
      : { body: args.body as string, isHtml: args.isHtml as boolean | undefined };

    if (!rawBody.body) {
      throw new Error('Either body or bodyFile must be provided.');
    }

    // Process body: auto-convert Markdown to HTML if detected
    const { body: processedBody, isHtml } = await processEmailBody(
      rawBody.body,
      rawBody.isHtml,
    );

    const rawEmail =
      attachments && attachments.length > 0
        ? createRawEmailWithAttachments(
            args.to as string,
            args.subject as string,
            processedBody,
            email,
            attachments,
            { isHtml, fromName: displayName },
          )
        : createRawEmail(args.to as string, args.subject as string, processedBody, email, {
            isHtml,
            fromName: displayName,
          });

    const response = await gmail.users.drafts.update({
      userId: 'me',
      id: draftId,
      requestBody: { message: { raw: rawEmail } },
    });

    return {
      success: true,
      account: email,
      draftId: response.data.id,
      messageId: response.data.message?.id,
      htmlConverted: isHtml && !(args.isHtml as boolean),
    };
  },
});

// -----------------------------------------------------------------------------
// Get Attachment
// -----------------------------------------------------------------------------

server.tool('get-attachment', {
  annotations: { readOnlyHint: true },
  description: 'Get the content of an email attachment by its attachment ID.',
  parameters: {
    type: 'object',
    properties: {
      messageId: { type: 'string', description: 'The ID of the message containing the attachment' },
      attachmentId: { type: 'string', description: 'The ID of the attachment to retrieve' },
      saveToFile: {
        type: 'boolean',
        description: 'If true, saves to ~/Downloads/email-attachments/',
      },
    },
    required: ['messageId', 'attachmentId'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GmailSecrets;
    const { gmail, email } = await createGmailClient(secrets);

    const messageId = args.messageId as string;
    const attachmentId = args.attachmentId as string;
    const saveToFile = args.saveToFile as boolean | undefined;

    const response = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: attachmentId,
    });

    const attachmentData = response.data.data;
    if (!attachmentData) {
      throw new Error('Attachment data not found');
    }

    const base64Data = attachmentData.replace(/-/g, '+').replace(/_/g, '/');
    const buffer = Buffer.from(base64Data, 'base64');

    if (saveToFile) {
      const messageResponse = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });

      const allAttachments = findAttachments(messageResponse.data.payload);
      const originalFilename =
        allAttachments.length === 1 && allAttachments[0].filename
          ? allAttachments[0].filename
          : 'attachment';

      const now = new Date();
      const timestamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
      const filenameParts = originalFilename.split('.');
      const extension = filenameParts.length > 1 ? filenameParts.pop() : '';
      const baseName = filenameParts.join('.');
      const filename = extension
        ? `${timestamp}_${baseName}.${extension}`
        : `${timestamp}_${originalFilename}`;
      const outputDir = join(process.env.HOME || '/tmp', 'Downloads', 'email-attachments');
      const outputPath = join(outputDir, filename);

      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
      }

      writeFileSync(outputPath, buffer);

      return {
        account: email,
        messageId,
        attachmentId,
        size: response.data.size,
        filename,
        savedTo: outputPath,
      };
    }

    return {
      account: email,
      messageId,
      attachmentId,
      size: response.data.size,
      data: base64Data,
    };
  },
});

// -----------------------------------------------------------------------------
// Store Attachment
// -----------------------------------------------------------------------------

server.tool('store-attachment', {
  annotations: { readOnlyHint: false },
  description: 'Download and store an email attachment to the local filesystem.',
  parameters: {
    type: 'object',
    properties: {
      messageId: { type: 'string', description: 'The ID of the message containing the attachment' },
      attachmentId: { type: 'string', description: 'The ID of the attachment to store' },
      outputPath: { type: 'string', description: 'Optional output directory path' },
    },
    required: ['messageId', 'attachmentId'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GmailSecrets;
    const { gmail, email } = await createGmailClient(secrets);

    const messageId = args.messageId as string;
    const attachmentId = args.attachmentId as string;
    const customOutputPath = args.outputPath as string | undefined;

    const response = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: attachmentId,
    });

    const attachmentData = response.data.data;
    if (!attachmentData) {
      throw new Error('Attachment data not found');
    }

    const base64Data = attachmentData.replace(/-/g, '+').replace(/_/g, '/');
    const buffer = Buffer.from(base64Data, 'base64');

    const messageResponse = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const allAttachments = findAttachments(messageResponse.data.payload);
    const originalFilename =
      allAttachments.length === 1 && allAttachments[0].filename
        ? allAttachments[0].filename
        : 'attachment';

    const now = new Date();
    const timestamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
    const filenameParts = originalFilename.split('.');
    const extension = filenameParts.length > 1 ? filenameParts.pop() : '';
    const baseName = filenameParts.join('.');
    const filename = extension
      ? `${timestamp}_${baseName}.${extension}`
      : `${timestamp}_${originalFilename}`;
    const outputDir =
      customOutputPath || join(process.env.HOME || '/tmp', 'Downloads', 'email-attachments');
    const outputPath = join(outputDir, filename);

    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    writeFileSync(outputPath, buffer);

    return {
      account: email,
      messageId,
      attachmentId,
      size: response.data.size,
      filename,
      savedTo: outputPath,
    };
  },
});

// -----------------------------------------------------------------------------
// List Labels
// -----------------------------------------------------------------------------

server.tool('list-labels', {
  annotations: { readOnlyHint: true },
  description: 'List all Gmail labels (both system and custom labels) for the account.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GmailSecrets;
    const { gmail, email } = await createGmailClient(secrets);

    const response = await gmail.users.labels.list({ userId: 'me' });
    const labels = response.data.labels || [];

    return {
      account: email,
      count: labels.length,
      labels: labels.map((l: any) => ({
        id: l.id,
        name: l.name,
        type: l.type,
        messageListVisibility: l.messageListVisibility,
        labelListVisibility: l.labelListVisibility,
        color: l.color,
      })),
    };
  },
});

// -----------------------------------------------------------------------------
// Create Label
// -----------------------------------------------------------------------------

server.tool('create-label', {
  annotations: { readOnlyHint: false },
  description: 'Create a new Gmail label.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name of the label' },
      backgroundColor: { type: 'string', description: 'Background color in hex format' },
      textColor: { type: 'string', description: 'Text color in hex format' },
    },
    required: ['name'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GmailSecrets;
    const { gmail, email } = await createGmailClient(secrets);

    const labelName = args.name as string;
    const backgroundColor = args.backgroundColor as string | undefined;
    const textColor = args.textColor as string | undefined;

    const labelRequest: any = {
      name: labelName,
      messageListVisibility: 'show',
      labelListVisibility: 'labelShow',
    };

    if (backgroundColor || textColor) {
      labelRequest.color = {};
      if (backgroundColor) labelRequest.color.backgroundColor = backgroundColor;
      if (textColor) labelRequest.color.textColor = textColor;
    }

    const response = await gmail.users.labels.create({
      userId: 'me',
      requestBody: labelRequest,
    });

    return {
      success: true,
      account: email,
      label: {
        id: response.data.id,
        name: response.data.name,
        color: response.data.color,
      },
    };
  },
});

// -----------------------------------------------------------------------------
// Update Label
// -----------------------------------------------------------------------------

server.tool('update-label', {
  annotations: { readOnlyHint: false },
  description: 'Update an existing Gmail label (name, colors, visibility).',
  parameters: {
    type: 'object',
    properties: {
      labelId: { type: 'string', description: 'ID of the label to update' },
      name: { type: 'string', description: 'New name for the label' },
      backgroundColor: { type: 'string', description: 'Background color in hex format' },
      textColor: { type: 'string', description: 'Text color in hex format' },
    },
    required: ['labelId'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GmailSecrets;
    const { gmail, email } = await createGmailClient(secrets);

    const labelId = args.labelId as string;
    const labelName = args.name as string | undefined;
    const backgroundColor = args.backgroundColor as string | undefined;
    const textColor = args.textColor as string | undefined;

    const updateRequest: any = {};
    if (labelName) updateRequest.name = labelName;

    if (backgroundColor || textColor) {
      updateRequest.color = {};
      if (backgroundColor) updateRequest.color.backgroundColor = backgroundColor;
      if (textColor) updateRequest.color.textColor = textColor;
    }

    const response = await gmail.users.labels.update({
      userId: 'me',
      id: labelId,
      requestBody: updateRequest,
    });

    return {
      success: true,
      account: email,
      label: {
        id: response.data.id,
        name: response.data.name,
        color: response.data.color,
      },
    };
  },
});

// -----------------------------------------------------------------------------
// Delete Label
// -----------------------------------------------------------------------------

server.tool('delete-label', {
  annotations: { readOnlyHint: false, irreversible: true },
  description: 'Delete a Gmail label. This does NOT delete the emails with this label.',
  parameters: {
    type: 'object',
    properties: {
      labelId: { type: 'string', description: 'ID of the label to delete' },
    },
    required: ['labelId'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GmailSecrets;
    const { gmail, email } = await createGmailClient(secrets);

    const labelId = args.labelId as string;
    await gmail.users.labels.delete({ userId: 'me', id: labelId });

    return { success: true, account: email, labelId, message: 'Label deleted successfully' };
  },
});

// -----------------------------------------------------------------------------
// List Filters
// -----------------------------------------------------------------------------

server.tool('list-filters', {
  annotations: { readOnlyHint: true },
  description: 'List all Gmail filters for the account.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GmailSecrets;
    const { gmail, email } = await createGmailClient(secrets);

    const response = await gmail.users.settings.filters.list({ userId: 'me' });
    const filters = response.data.filter || [];

    return { success: true, account: email, count: filters.length, filters };
  },
});

// -----------------------------------------------------------------------------
// Create Filter
// -----------------------------------------------------------------------------

server.tool('create-filter', {
  annotations: { readOnlyHint: false },
  description: 'Create a new Gmail filter to automatically organize emails.',
  parameters: {
    type: 'object',
    properties: {
      criteria: {
        type: 'object',
        description: 'Filter criteria',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          subject: { type: 'string' },
          query: { type: 'string' },
          hasAttachment: { type: 'boolean' },
          excludeChats: { type: 'boolean' },
        },
      },
      action: {
        type: 'object',
        description: 'Actions to perform when filter matches',
        properties: {
          addLabelIds: { type: 'array', items: { type: 'string' } },
          removeLabelIds: { type: 'array', items: { type: 'string' } },
          forward: { type: 'string' },
        },
      },
    },
    required: ['criteria', 'action'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GmailSecrets;
    const { gmail, email } = await createGmailClient(secrets);

    const criteria = args.criteria as any;
    const action = args.action as any;

    const response = await gmail.users.settings.filters.create({
      userId: 'me',
      requestBody: { criteria, action },
    });

    return { success: true, account: email, filter: response.data };
  },
});

// -----------------------------------------------------------------------------
// Delete Filter
// -----------------------------------------------------------------------------

server.tool('delete-filter', {
  annotations: { readOnlyHint: false, irreversible: true },
  description: 'Delete a Gmail filter by its ID.',
  parameters: {
    type: 'object',
    properties: {
      filterId: { type: 'string', description: 'ID of the filter to delete' },
    },
    required: ['filterId'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GmailSecrets;
    const { gmail, email } = await createGmailClient(secrets);

    const filterId = args.filterId as string;
    await gmail.users.settings.filters.delete({ userId: 'me', id: filterId });

    return { success: true, account: email, filterId, message: 'Filter deleted successfully' };
  },
});

// ---------------------------------------------------------------------------
// Email Watcher Tools
// ---------------------------------------------------------------------------

server.tool('start-email-watcher', {
  annotations: { readOnlyHint: false },
  description:
    'Start a background polling loop that detects new unread emails and emits `gmail.email.received` events to the backend. The watcher polls the Gmail API at a configurable interval (default: 5 minutes). Only one watcher can be active per MCA process.',
  parameters: {
    type: 'object',
    properties: {
      intervalMinutes: {
        type: 'number',
        description:
          'Polling interval in minutes (default: 5, minimum: 1). Lower values consume more Gmail API quota.',
        minimum: 1,
      },
    },
  },
  handler: async (args, context) => {
    const intervalMinutes =
      typeof args.intervalMinutes === 'number' && args.intervalMinutes >= 1
        ? args.intervalMinutes
        : 5;

    // Build a backend client from the execution context callbackUrl
    const callbackUrl = context.execution?.callbackUrl;
    const appId = context.execution?.appId;
    const backendClient =
      callbackUrl && appId
        ? new McaBackendClient({
            callbackUrl,
            appId,
            mcaId: 'mca.google.gmail',
            callbackToken: process.env.MCA_CALLBACK_TOKEN,
          })
        : null;

    if (!backendClient) {
      return {
        success: false,
        error:
          'No callbackUrl available in execution context. The watcher cannot emit events to the backend.',
      };
    }

    const result = await startEmailWatcher(backendClient, intervalMinutes);
    return {
      success: result.started,
      intervalMs: result.intervalMs,
      message: result.message,
    };
  },
});

server.tool('stop-email-watcher', {
  annotations: { readOnlyHint: false },
  description: 'Stop the background email polling loop. No more events will be emitted.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, _context) => {
    const result = stopEmailWatcher();
    return {
      success: result.stopped,
      message: result.message,
    };
  },
});

server.tool('get-watcher-status', {
  annotations: { readOnlyHint: true },
  description:
    'Get the current status of the email watcher: whether it is active, when it last checked, how many message IDs are tracked, and the polling interval.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, _context) => {
    const status = getWatcherStatus();
    return {
      success: true,
      ...status,
    };
  },
});

// =============================================================================
// START SERVER
// =============================================================================

server
  .start()
  .then(() => {
    console.error('📧 Gmail MCA server running');
  })
  .catch((error) => {
    console.error('Failed to start Gmail MCA:', error);
    process.exit(1);
  });
