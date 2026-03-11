import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { marked } from 'marked'

// =============================================================================
// MESSAGE FORMATTING
// =============================================================================

function extractAttachments(message: any): any[] {
  if (!message.hasAttachments || !message.attachments) return []
  return (message.attachments || []).map((att: any) => ({
    id: att.id,
    name: att.name,
    contentType: att.contentType,
    size: att.size,
    isInline: att.isInline || false,
  }))
}

export function formatMessage(msg: any, includeBody = false) {
  const result: any = {
    id: msg.id,
    conversationId: msg.conversationId,
    subject: msg.subject,
    from: msg.from?.emailAddress
      ? `${msg.from.emailAddress.name || ''} <${msg.from.emailAddress.address}>`.trim()
      : undefined,
    to: (msg.toRecipients || [])
      .map((r: any) => `${r.emailAddress?.name || ''} <${r.emailAddress?.address}>`.trim())
      .join(', '),
    cc:
      (msg.ccRecipients || [])
        .map((r: any) => `${r.emailAddress?.name || ''} <${r.emailAddress?.address}>`.trim())
        .join(', ') || undefined,
    date: msg.receivedDateTime || msg.sentDateTime || msg.createdDateTime,
    snippet: msg.bodyPreview,
    isRead: msg.isRead,
    isDraft: msg.isDraft,
    importance: msg.importance,
    hasAttachments: msg.hasAttachments,
    categories: msg.categories,
    parentFolderId: msg.parentFolderId,
  }

  if (includeBody) {
    result.body = msg.body?.content || ''
    result.bodyType = msg.body?.contentType || 'text'
    result.attachments = extractAttachments(msg)
  }

  return result
}

export function buildRecipients(
  emails: string,
): Array<{ emailAddress: { address: string; name?: string } }> {
  return emails
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
    .map((email) => {
      const match = email.match(/^(.+?)\s*<(.+?)>$/)
      if (match) {
        return { emailAddress: { name: match[1].trim(), address: match[2].trim() } }
      }
      return { emailAddress: { address: email } }
    })
}

// =============================================================================
// MARKDOWN / HTML
// =============================================================================

function containsMarkdown(text: string): boolean {
  const markdownPatterns = [
    /^#{1,6}\s/m,
    /\*\*[^*]+\*\*/,
    /\*[^*]+\*/,
    /__[^_]+__/,
    /_[^_]+_/,
    /\[.+\]\(.+\)/,
    /^[-*+]\s/m,
    /^\d+\.\s/m,
    /^>\s/m,
    /`[^`]+`/,
    /```[\s\S]*?```/,
    /^\|.+\|$/m,
    /^---+$/m,
  ]
  return markdownPatterns.some((pattern) => pattern.test(text))
}

async function markdownToHtmlEmail(markdown: string): Promise<string> {
  marked.setOptions({ gfm: true, breaks: true })
  const htmlContent = await marked.parse(markdown)

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <style>
    h1 { font-size: 24px; font-weight: 600; margin: 24px 0 16px 0; color: #1a1a1a; }
    h2 { font-size: 20px; font-weight: 600; margin: 20px 0 12px 0; color: #1a1a1a; }
    h3 { font-size: 16px; font-weight: 600; margin: 16px 0 8px 0; color: #1a1a1a; }
    p { margin: 0 0 16px 0; }
    ul, ol { margin: 0 0 16px 0; padding-left: 24px; }
    li { margin: 4px 0; }
    a { color: #0066cc; text-decoration: none; }
    code { background-color: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-family: 'SF Mono', Monaco, 'Courier New', monospace; font-size: 13px; }
    pre { background-color: #f4f4f4; padding: 12px; border-radius: 6px; overflow-x: auto; margin: 0 0 16px 0; }
    pre code { background: none; padding: 0; }
    blockquote { border-left: 4px solid #ddd; margin: 0 0 16px 0; padding: 8px 16px; color: #666; }
    table { border-collapse: collapse; width: 100%; margin: 0 0 16px 0; }
    th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
    th { background-color: #f4f4f4; font-weight: 600; }
    hr { border: none; border-top: 1px solid #ddd; margin: 24px 0; }
    strong { font-weight: 600; }
  </style>
  ${htmlContent}
</body>
</html>`
}

export async function processEmailBody(
  body: string,
  explicitIsHtml?: boolean,
): Promise<{ body: string; isHtml: boolean }> {
  if (explicitIsHtml === true) return { body, isHtml: true }
  if (explicitIsHtml === false && !containsMarkdown(body)) return { body, isHtml: false }
  if (containsMarkdown(body)) {
    const htmlBody = await markdownToHtmlEmail(body)
    return { body: htmlBody, isHtml: true }
  }
  return { body, isHtml: false }
}

// =============================================================================
// ATTACHMENTS
// =============================================================================

const MIME_TYPES: Record<string, string> = {
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
}

export function buildFileAttachment(att: { path: string; filename?: string }) {
  const filePath = att.path.startsWith('/') ? att.path : join(process.cwd(), att.path)
  if (!existsSync(filePath)) {
    throw new Error(`Attachment file not found: ${filePath}`)
  }

  const fileContent = readFileSync(filePath)
  const base64Content = fileContent.toString('base64')
  const filename = att.filename || filePath.split('/').pop() || 'attachment'
  const ext = filename.split('.').pop()?.toLowerCase()
  const contentType = MIME_TYPES[ext || ''] || 'application/octet-stream'

  return {
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: filename,
    contentType,
    contentBytes: base64Content,
  }
}
