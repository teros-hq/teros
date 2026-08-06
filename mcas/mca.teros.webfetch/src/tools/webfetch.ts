import { type HttpToolConfig as ToolConfig, safeFetch } from '@teros/mca-sdk';
import TurndownService from 'turndown';

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_TIMEOUT = 120 * 1000; // 2 minutes

/**
 * Extract text content from HTML by removing scripts, styles, and other non-text elements.
 * Uses regex-based stripping — sufficient for text extraction from fetched web pages.
 * @fixme nira - 2026.05.02 : consider replacing with a proper HTML parser (e.g. linkedom)
 * if regex-based extraction proves insufficient for complex documents
 */
function extractTextFromHTML(html: string): string {
  // Remove script, style, noscript, iframe, object, embed tags and their content
  let text = html
    .replace(
      /<(script|style|noscript|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi,
      ' ',
    )
    .replace(/<(script|style|noscript|iframe|object|embed)\b[^>]*\/>/gi, ' ')
    .replace(/<[^>]+>/g, ' ') // Remove all remaining HTML tags
    .replace(/&#[0-9]+;/g, (match) => {
      try {
        return String.fromCharCode(parseInt(match.slice(2, -1), 10));
      } catch {
        return match;
      }
    })
    .replace(/&#[xX][0-9a-fA-F]+;/g, (match) => {
      try {
        return String.fromCharCode(parseInt(match.slice(3, -1), 16));
      } catch {
        return match;
      }
    })
    .replace(/&[a-zA-Z]+;/g, (match) => {
      const entities: Record<string, string> = {
        '&nbsp;': ' ',
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&#39;': "'",
        '&apos;': "'",
        '&ndash;': '–',
        '&mdash;': '—',
        '&hellip;': '…',
        '&copy;': '©',
        '&reg;': '®',
        '&trade;': '™',
      };
      return entities[match.toLowerCase()] || match;
    })
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}

/**
 * Convert HTML to Markdown using Turndown
 */
function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  });

  // Remove unwanted elements
  turndownService.remove(['script', 'style', 'meta', 'link']);

  return turndownService.turndown(html);
}

/**
 * Build Accept header based on requested format
 */
function buildAcceptHeader(format: string): string {
  switch (format) {
    case 'markdown':
      return 'text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1';
    case 'text':
      return 'text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1';
    case 'html':
      return 'text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1';
    default:
      return 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
  }
}

export const webfetch: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Fetch content from a URL and convert to text, markdown, or HTML format. Supports intelligent content extraction and format conversion.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch content from (must start with http:// or https://)',
      },
      format: {
        type: 'string',
        description: 'The format to return the content in',
        enum: ['text', 'markdown', 'html'],
      },
      timeout: {
        type: 'number',
        description: 'Optional timeout in seconds (default: 30, max: 120)',
        minimum: 1,
        maximum: 120,
        default: 30,
      },
    },
    required: ['url', 'format'],
  },
  handler: async (args) => {
    const url = args?.url as string;
    const format = args?.format as string;
    const timeout = (args?.timeout as number) || 30;

    // Calculate timeout
    const timeoutMs = Math.min(timeout * 1000, MAX_TIMEOUT);

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // SSRF-safe fetch: validates http(s) + that the host resolves to a public
      // address, and follows redirects manually re-validating every hop (a
      // public host can open-redirect to 169.254.169.254 / an internal IP).
      const response = await safeFetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: buildAcceptHeader(format),
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Request failed with status code: ${response.status}`);
      }

      // Check content length
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
        throw new Error('Response too large (exceeds 5MB limit)');
      }

      // Read response
      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
        throw new Error('Response too large (exceeds 5MB limit)');
      }

      const content = new TextDecoder().decode(arrayBuffer);
      const contentType = response.headers.get('content-type') || '';

      // Process content based on requested format
      let processedContent = content;

      if (format === 'markdown' && contentType.includes('text/html')) {
        processedContent = convertHTMLToMarkdown(content);
      } else if (format === 'text' && contentType.includes('text/html')) {
        processedContent = extractTextFromHTML(content);
      }

      return {
        url,
        contentType,
        size: arrayBuffer.byteLength,
        content: processedContent,
      };
    } catch (error: any) {
      if (error.name === 'AbortError') {
        throw new Error(`Request timed out after ${timeout} seconds`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  },
};
