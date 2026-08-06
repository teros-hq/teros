import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';

/**
 * notify-by-email — Send a notification email to the current user via Resend.
 *
 * The agent provides a subject + content (text or HTML). The MCA calls the
 * backend's /email/send endpoint, which:
 *   1. Resolves the user's email from the channel context
 *   2. Wraps the content in the Teros notification template
 *   3. Sends it via Resend from notifications@teros.ai
 *
 * The agent never sees the API key or the user's email — the backend handles
 * everything internally.
 */
export const notifyByEmail: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Send a notification email to the current user. The email is sent via Resend from a Teros notification address (notifications@teros.ai). Use this instead of Gmail when you want to deliver a report or alert to the user by email — it does not require any email account connection. The user\'s email is resolved automatically from their Teros account. The backend appends a Teros banner with a CTA to os.teros.ai at the bottom automatically — do NOT include your own footer or Teros branding. EMAIL HTML GUIDELINES: Use table-based layouts (not divs/flexbox/grid). Inline ALL styles (no <style> blocks, no class attributes). Use full HTML document: <!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body>...</body></html>. Max width 560px for content. Use system fonts: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif. For headings use Georgia, serif. Background via <body> or outer table with bgcolor. Use <table role="presentation" cellpadding="0" cellspacing="0" border="0"> for layout. Spacers: <tr><td style="height: Npx;"></td></tr>. Buttons: <a> with inline display:inline-block, padding, background-color, border-radius. Images: absolute URLs only, width/height attributes, style="display:block". No JavaScript, no <form>, no external CSS, no web fonts. Colors: dark theme #0A0A0F (bg), #FAFAFA (text), #A1A1AA (secondary), #5E6AD2 (accent/CTA). Light theme: #EFE9DB (bg), #18181B (text). Keep it clean and minimal.',
  parameters: {
    type: 'object',
    properties: {
      subject: {
        type: 'string',
        description: 'Email subject line',
      },
      content: {
        type: 'string',
        description:
          'Email body content as email-safe HTML. The backend sends it as-is (no wrapping template) and appends a Teros banner at the bottom. See the tool description for HTML formatting guidelines. If contentType is "text", line breaks are converted to <br> tags.',
      },
      contentType: {
        type: 'string',
        enum: ['text', 'html'],
        description:
          'Format of the content. "text" = plain text (will be converted to HTML with line breaks). "html" = raw HTML (will be embedded as-is). Default: "html".',
      },
    },
    required: ['subject', 'content'],
  },
  handler: async (args, context) => {
    const subject = args?.subject as string;
    const content = args?.content as string;
    const contentType = (args?.contentType as 'text' | 'html') || 'html';

    if (!subject) {
      throw new Error('subject is required');
    }
    if (!content) {
      throw new Error('content is required');
    }

    // Convert plain text to HTML
    let htmlContent = content;
    if (contentType === 'text') {
      // Escape HTML special chars, then convert newlines to <br>
      htmlContent = content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');
    }

    // Call the backend /email/send endpoint
    const callbackUrl = context.execution.callbackUrl;
    const appId = context.execution.appId;
    const callbackToken = process.env.MCA_CALLBACK_TOKEN;

    if (!callbackUrl) {
      throw new Error('No backend callback URL available — cannot send email');
    }

    const response = await fetch(`${callbackUrl}/email/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-App-Id': appId || '',
        ...(callbackToken && { Authorization: `Bearer ${callbackToken}` }),
      },
      body: JSON.stringify({
        subject,
        content: htmlContent,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `Backend returned ${response.status}`;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error || errorMessage;
      } catch {
        errorMessage = errorText || errorMessage;
      }
      throw new Error(`Failed to send notification email: ${errorMessage}`);
    }

    const result = await response.json();

    return {
      success: true,
      messageId: result.messageId,
      sentTo: result.sentTo,
      description: `Notification email sent to user: "${subject}"`,
    };
  },
};
