# Web Fetch MCA

Fetch and extract content from web pages with intelligent format conversion.

## Features

- **Multiple output formats**: text, markdown, or HTML
- **Intelligent conversion**: Automatic HTML to text/markdown conversion
- **Safe extraction**: Removes scripts, styles, and unwanted elements
- **Size limits**: Protects against large responses (5MB max)
- **Timeout control**: Configurable timeout (up to 120 seconds)
- **Smart headers**: Sends appropriate Accept headers based on format

## Configuration

No configuration required - works out of the box!

## Tools

### webfetch

Fetch content from a URL and convert to the desired format.

**Parameters:**
- `url` (string, required): The URL to fetch (must start with http:// or https://)
- `format` (string, required): Output format
  - `text`: Plain text extraction (removes HTML tags)
  - `markdown`: Convert HTML to markdown
  - `html`: Return raw HTML
- `timeout` (number, optional): Timeout in seconds (default: 30, max: 120)

**Example:**
```typescript
{
  "url": "https://example.com/article",
  "format": "markdown",
  "timeout": 60
}
```

## Format Details

### Text Format
- Extracts only text content from HTML
- Removes scripts, styles, and other non-text elements
- Preserves basic text structure
- Best for: Reading content, text analysis

### Markdown Format
- Converts HTML to clean markdown
- Preserves headings, lists, links, and formatting
- Removes scripts, styles, and metadata
- Best for: Documentation, articles, structured content

### HTML Format
- Returns raw HTML content
- No processing or cleaning
- Best for: Detailed parsing, custom processing

## Usage Tips

- Use `text` format for simple content extraction
- Use `markdown` format for readable, structured content
- Use `html` format when you need full control over parsing
- Increase timeout for slow-loading pages
- Be aware of the 5MB size limit

## Safety Features

- **URL validation**: Only http:// and https:// URLs allowed
- **Size limits**: Maximum 5MB response size
- **Timeout protection**: Prevents hanging requests
- **Content filtering**: Removes potentially harmful scripts

## Limitations

- Maximum response size: 5MB
- Maximum timeout: 120 seconds
- Only supports HTTP/HTTPS protocols
- HTMLRewriter requires Bun or Cloudflare Workers runtime

## Error Handling

The tool provides clear error messages for:
- Invalid URLs
- Timeout errors
- Network failures
- Size limit exceeded
- HTTP error responses
