import type { ToolConfig } from '@teros/mca-sdk'
import { resolveSignatureHtml, SIGNATURE_SECRET_KEY } from '../lib/signature'
import type { OutlookSecrets } from '../lib'

export const setSignature: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Save the email signature (HTML) for the connected Outlook account. Microsoft Graph does not expose the mailbox signature, so this is the canonical way to configure it. The signature is stored per-account and automatically appended to outgoing emails (create-draft, update-draft, send-message, reply-message) — never invented or reconstructed from other emails. If the user wants a signature but none is configured, ask them for it (HTML preferred) and save it with this tool.',
  parameters: {
    type: 'object',
    properties: {
      signatureHtml: {
        type: 'string',
        description:
          'The signature as HTML (e.g. with logo <img>, styled name, role, company). Images must use absolute https URLs.',
      },
    },
    required: ['signatureHtml'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as OutlookSecrets

    const signatureHtml = (args.signatureHtml as string).trim()
    if (!signatureHtml) {
      return { success: false, error: 'signatureHtml must not be empty' }
    }

    // Merge-persist: only SIGNATURE_HTML is written — tokens are preserved
    // (backend merges: { ...existing, ...body.secrets }).
    await context.updateUserSecrets?.({ [SIGNATURE_SECRET_KEY]: signatureHtml })

    return {
      success: true,
      account: secrets.EMAIL,
      saved: true,
      signatureLength: signatureHtml.length,
    }
  },
}

export const getSignature: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get the configured email signature (HTML) for the connected Outlook account, if any. Use before composing emails to check whether a signature is configured.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as OutlookSecrets

    const signature = resolveSignatureHtml(secrets.SIGNATURE_HTML)
    return {
      account: secrets.EMAIL,
      configured: Boolean(signature),
      signatureHtml: signature || undefined,
    }
  },
}
