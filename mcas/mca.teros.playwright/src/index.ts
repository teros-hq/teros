/**
 * MCA Teros Playwright - Browser Automation
 *
 * Browser automation and web scraping via Playwright.
 * Navigate, interact, take screenshots, and extract data from web pages.
 *
 * Uses @teros/mca-sdk McaServer with HTTP transport.
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import {
  type Browser,
  type BrowserContext,
  chromium,
  type ElementHandle,
  type Page,
} from 'playwright';

// =============================================================================
// BROWSER STATE
// =============================================================================

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

// Console messages storage
const consoleMessages: Array<{ level: string; text: string; timestamp: number }> = [];

// Timestamps for filtering console messages
let lastNavigationTime: number = 0;
let lastActionTime: number = 0;

// Network requests storage
const networkRequests: Array<{
  url: string;
  method: string;
  status?: number;
  resourceType: string;
  timestamp: Date;
}> = [];

// =============================================================================
// BROWSER MANAGEMENT
// =============================================================================

async function ensureBrowser(): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }

  if (!context) {
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
  }

  if (!page || page.isClosed()) {
    page = await context.newPage();

    // Set up console message collection
    page.on('console', (msg) => {
      consoleMessages.push({
        level: msg.type(),
        text: msg.text(),
        timestamp: Date.now(),
      });
      // Keep only last 1000 messages
      if (consoleMessages.length > 1000) {
        consoleMessages.shift();
      }
    });

    // Set up network request collection
    page.on('request', (request) => {
      networkRequests.push({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        timestamp: new Date(),
      });
    });

    page.on('response', (response) => {
      const req = networkRequests.find((r) => r.url === response.url() && !r.status);
      if (req) {
        req.status = response.status();
      }
    });
  }

  return { browser, context, page };
}

async function closeBrowser(): Promise<void> {
  if (page && !page.isClosed()) {
    await page.close();
    page = null;
  }
  if (context) {
    await context.close();
    context = null;
  }
  if (browser) {
    await browser.close();
    browser = null;
  }
  consoleMessages.length = 0;
  networkRequests.length = 0;
}

// =============================================================================
// SNAPSHOT HELPERS
// =============================================================================

async function getAccessibilitySnapshot(p: Page): Promise<string> {
  // Use Playwright's internal _snapshotForAI method (available since ~1.49)
  // This generates ARIA snapshots with refs that can be used with aria-ref= locators
  try {
    const snapshot = await (p as any)._snapshotForAI();

    if (!snapshot || !snapshot.full) {
      return 'Page has no accessibility tree';
    }

    return `# Page Accessibility Snapshot

URL: ${p.url()}
Title: ${await p.title()}

## Accessibility Tree

${snapshot.full}

---
Use the ref values (e.g., [ref=s1e3]) with browser-click, browser-type, etc. to interact with elements.`;
  } catch (error) {
    // Fallback to CDP if _snapshotForAI is not available
    return await getAccessibilitySnapshotViaCDP(p);
  }
}

async function getAccessibilitySnapshotViaCDP(p: Page): Promise<string> {
  // Fallback: Use CDP to get accessibility tree
  const client = await p.context().newCDPSession(p);

  try {
    const { nodes } = await client.send('Accessibility.getFullAXTree');

    if (!nodes || nodes.length === 0) {
      return 'Page has no accessibility tree';
    }

    const nodeMap = new Map<string, any>();
    for (const node of nodes) {
      nodeMap.set(node.nodeId, node);
    }

    const rootNode = nodes.find((n: any) => !n.parentId);

    function formatNode(node: any, indent: number = 0): string {
      if (!node) return '';

      const prefix = '  '.repeat(indent);
      const role = node.role?.value || 'unknown';
      const name = node.name?.value || '';
      const value = node.value?.value;
      const checked = node.checked?.value;
      const selected = node.selected?.value;
      const expanded = node.expanded?.value;

      if (node.ignored || (role === 'generic' && !name)) {
        let result = '';
        if (node.childIds) {
          for (const childId of node.childIds) {
            const child = nodeMap.get(childId);
            if (child) result += formatNode(child, indent);
          }
        }
        return result;
      }

      let result = `${prefix}- ${role}`;
      if (name) result += `: "${name}"`;
      if (value !== undefined) result += ` [value: "${value}"]`;
      if (checked !== undefined) result += ` [checked: ${checked}]`;
      if (selected !== undefined) result += ` [selected: ${selected}]`;
      if (expanded !== undefined) result += ` [expanded: ${expanded}]`;
      result += '\n';

      if (node.childIds) {
        for (const childId of node.childIds) {
          const child = nodeMap.get(childId);
          if (child) result += formatNode(child, indent + 1);
        }
      }

      return result;
    }

    const tree = formatNode(rootNode);
    return `# Page Accessibility Snapshot

URL: ${p.url()}
Title: ${await p.title()}

## Accessibility Tree

${tree}`;
  } finally {
    await client.detach();
  }
}

// =============================================================================
// ELEMENT HELPERS
// =============================================================================

async function findElementByRef(p: Page, ref: string, retries = 2): Promise<ElementHandle | null> {
  // ref format from _snapshotForAI is like "e3", "e78", "s1e3", etc.
  // These work with the internal aria-ref locator

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Try as aria-ref first (most common case from snapshots)
    // Refs can be "e3", "e78", "s1e3", etc.
    if (/^(s\d+)?e\d+$/.test(ref)) {
      try {
        const locator = p.locator(`aria-ref=${ref}`);
        // Wait briefly for element to be available
        await locator.waitFor({ state: 'attached', timeout: 3000 });
        const element = await locator.first().elementHandle();
        if (element) return element;
      } catch (e) {
        // If this is not the last attempt, wait a bit and retry
        if (attempt < retries) {
          await p.waitForTimeout(500);
          continue;
        }
      }
    }

    // Try as a CSS selector
    try {
      const element = await p.$(ref);
      if (element) return element;
    } catch {}

    // Try as text content
    try {
      const element = await p.getByText(ref, { exact: false }).first().elementHandle();
      if (element) return element;
    } catch {}

    // Try as role + name (e.g., 'button "Submit"')
    try {
      const match = ref.match(/(\w+)\s*"([^"]+)"/);
      if (match) {
        const [, role, name] = match;
        const element = await p
          .getByRole(role as any, { name })
          .first()
          .elementHandle();
        if (element) return element;
      }
    } catch {}

    // Wait before retry
    if (attempt < retries) {
      await p.waitForTimeout(500);
    }
  }

  return null;
}

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.teros.playwright',
  name: 'Playwright Browser',
  version: '1.0.0',
});

// -----------------------------------------------------------------------------
// Health Check
// -----------------------------------------------------------------------------

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies Playwright browser availability.',
  parameters: { type: 'object', properties: {} },
  handler: async () => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0');

    try {
      // Try to launch browser to verify it works
      const testBrowser = await chromium.launch({ headless: true });
      await testBrowser.close();
    } catch (error) {
      builder.addIssue(
        'BROWSER_NOT_AVAILABLE',
        error instanceof Error ? error.message : 'Failed to launch browser',
        { type: 'admin_action', description: 'Install Chromium browser' },
      );
    }

    return builder.build();
  },
});

// -----------------------------------------------------------------------------
// browser-close
// -----------------------------------------------------------------------------

server.tool('browser-close', {
  description: 'Close the page',
  parameters: { type: 'object', properties: {} },
  handler: async () => {
    await closeBrowser();
    return 'Browser closed';
  },
});

// -----------------------------------------------------------------------------
// browser-resize
// -----------------------------------------------------------------------------

server.tool('browser-resize', {
  description: 'Resize the browser window',
  parameters: {
    type: 'object',
    properties: {
      width: { type: 'number', description: 'Width of the browser window' },
      height: { type: 'number', description: 'Height of the browser window' },
    },
    required: ['width', 'height'],
  },
  handler: async (args) => {
    const { page } = await ensureBrowser();
    await page.setViewportSize({
      width: args.width as number,
      height: args.height as number,
    });
    return `Resized viewport to ${args.width}x${args.height}`;
  },
});

// -----------------------------------------------------------------------------
// browser-console-messages
// -----------------------------------------------------------------------------

server.tool('browser-console-messages', {
  description: 'Returns console messages with filtering options',
  parameters: {
    type: 'object',
    properties: {
      level: {
        type: 'string',
        enum: ['error', 'warning', 'info', 'debug'],
        default: 'info',
        description:
          'Level of the console messages to return. Each level includes the messages of more severe levels. Defaults to "info".',
      },
      limit: {
        type: 'number',
        default: 50,
        description: 'Max messages to return (default: 50)',
      },
      offset: {
        type: 'number',
        default: 0,
        description: 'Skip first N messages (for pagination)',
      },
      search: {
        type: 'string',
        description: 'Filter messages containing this text (case-insensitive)',
      },
      sinceTimestamp: {
        type: 'number',
        description: 'Only messages after this timestamp (ms). Use lastTimestamp from previous response to iterate.',
      },
      since: {
        type: 'string',
        enum: ['all', 'last-navigation', 'last-action'],
        default: 'all',
        description: 'Preset filters: all, since last navigation, since last action (click/type/etc)',
      },
    },
  },
  handler: async (args) => {
    const level = (args.level as string) || 'info';
    const limit = Math.min((args.limit as number) || 50, 200);
    const offset = (args.offset as number) || 0;
    const search = (args.search as string)?.toLowerCase();
    const sinceTimestamp = args.sinceTimestamp as number | undefined;
    const since = (args.since as string) || 'all';

    const levels = ['error', 'warning', 'info', 'debug'];
    const minLevel = levels.indexOf(level);

    // Determine the timestamp filter
    let filterTimestamp = 0;
    if (sinceTimestamp) {
      filterTimestamp = sinceTimestamp;
    } else if (since === 'last-navigation') {
      filterTimestamp = lastNavigationTime;
    } else if (since === 'last-action') {
      filterTimestamp = lastActionTime;
    }

    // Apply all filters
    const filtered = consoleMessages.filter((msg) => {
      // Level filter
      const msgLevel = msg.level === 'warn' ? 'warning' : msg.level;
      if (levels.indexOf(msgLevel) > minLevel) return false;

      // Timestamp filter
      if (filterTimestamp && msg.timestamp <= filterTimestamp) return false;

      // Search filter
      if (search && !msg.text.toLowerCase().includes(search)) return false;

      return true;
    });

    const total = filtered.length;

    // Apply pagination
    const paginated = filtered.slice(offset, offset + limit);

    if (paginated.length === 0) {
      return JSON.stringify({
        messages: [],
        count: 0,
        total,
        hasMore: false,
        lastTimestamp: Date.now(),
      });
    }

    const lastTimestamp = paginated[paginated.length - 1].timestamp;

    return JSON.stringify({
      messages: paginated.map((msg) => ({
        level: msg.level.toUpperCase(),
        text: msg.text,
        timestamp: msg.timestamp,
      })),
      count: paginated.length,
      total,
      hasMore: offset + paginated.length < total,
      lastTimestamp,
    });
  },
});

// -----------------------------------------------------------------------------
// browser-console-errors (shortcut)
// -----------------------------------------------------------------------------

server.tool('browser-console-errors', {
  description: 'Returns only error messages (shortcut for level=error)',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        default: 20,
        description: 'Max errors to return (default: 20)',
      },
      search: {
        type: 'string',
        description: 'Filter errors containing this text (case-insensitive)',
      },
      sinceTimestamp: {
        type: 'number',
        description: 'Only errors after this timestamp (ms)',
      },
      since: {
        type: 'string',
        enum: ['all', 'last-navigation', 'last-action'],
        default: 'all',
        description: 'Preset filters',
      },
    },
  },
  handler: async (args) => {
    const limit = Math.min((args.limit as number) || 20, 100);
    const search = (args.search as string)?.toLowerCase();
    const sinceTimestamp = args.sinceTimestamp as number | undefined;
    const since = (args.since as string) || 'all';

    // Determine the timestamp filter
    let filterTimestamp = 0;
    if (sinceTimestamp) {
      filterTimestamp = sinceTimestamp;
    } else if (since === 'last-navigation') {
      filterTimestamp = lastNavigationTime;
    } else if (since === 'last-action') {
      filterTimestamp = lastActionTime;
    }

    const errors = consoleMessages.filter((msg) => {
      if (msg.level !== 'error') return false;
      if (filterTimestamp && msg.timestamp <= filterTimestamp) return false;
      if (search && !msg.text.toLowerCase().includes(search)) return false;
      return true;
    });

    const paginated = errors.slice(0, limit);

    if (paginated.length === 0) {
      return JSON.stringify({ errors: [], count: 0, total: errors.length });
    }

    return JSON.stringify({
      errors: paginated.map((msg) => ({
        text: msg.text,
        timestamp: msg.timestamp,
      })),
      count: paginated.length,
      total: errors.length,
      lastTimestamp: paginated[paginated.length - 1].timestamp,
    });
  },
});

// -----------------------------------------------------------------------------
// browser-console-clear
// -----------------------------------------------------------------------------

server.tool('browser-console-clear', {
  description: 'Clear all captured console messages',
  parameters: { type: 'object', properties: {} },
  handler: async () => {
    const count = consoleMessages.length;
    consoleMessages.length = 0;
    lastNavigationTime = Date.now();
    lastActionTime = Date.now();
    return JSON.stringify({ cleared: count, message: `Cleared ${count} console messages` });
  },
});

// -----------------------------------------------------------------------------
// browser-handle-dialog
// -----------------------------------------------------------------------------

server.tool('browser-handle-dialog', {
  description: 'Handle a dialog',
  parameters: {
    type: 'object',
    properties: {
      accept: { type: 'boolean', description: 'Whether to accept the dialog.' },
      promptText: {
        type: 'string',
        description: 'The text of the prompt in case of a prompt dialog.',
      },
    },
    required: ['accept'],
  },
  handler: async (args) => {
    const { page } = await ensureBrowser();

    page.once('dialog', async (dialog) => {
      if (args.accept) {
        await dialog.accept(args.promptText as string);
      } else {
        await dialog.dismiss();
      }
    });

    return `Dialog handler set: ${args.accept ? 'accept' : 'dismiss'}`;
  },
});

// -----------------------------------------------------------------------------
// browser-evaluate
// -----------------------------------------------------------------------------

server.tool('browser-evaluate', {
  description: 'Evaluate JavaScript expression on page or element',
  parameters: {
    type: 'object',
    properties: {
      function: {
        type: 'string',
        description: '() => { /* code */ } or (element) => { /* code */ } when element is provided',
      },
      element: {
        type: 'string',
        description:
          'Human-readable element description used to obtain permission to interact with the element',
      },
      ref: { type: 'string', description: 'Exact target element reference from the page snapshot' },
    },
    required: ['function'],
  },
  handler: async (args) => {
    const { page } = await ensureBrowser();
    const fn = args.function as string;

    if (args.ref) {
      const el = await findElementByRef(page, args.ref as string);
      if (!el) {
        throw new Error(`Element not found: ${args.ref}`);
      }
      const result = await el.evaluate(new Function('element', `return (${fn})(element)`) as any);
      return JSON.stringify(result, null, 2);
    }

    const result = await page.evaluate(new Function(`return (${fn})()`) as any);
    return JSON.stringify(result, null, 2);
  },
});

// -----------------------------------------------------------------------------
// browser-file-upload
// -----------------------------------------------------------------------------

server.tool('browser-file-upload', {
  description: 'Upload one or multiple files',
  parameters: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description:
          'The absolute paths to the files to upload. Can be single file or multiple files. If omitted, file chooser is cancelled.',
      },
    },
  },
  handler: async (args) => {
    const { page } = await ensureBrowser();
    const paths = args.paths as string[] | undefined;

    // Set up file chooser handler
    const [fileChooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 30000 })]);

    if (paths && paths.length > 0) {
      await fileChooser.setFiles(paths);
      return `Uploaded ${paths.length} file(s): ${paths.join(', ')}`;
    } else {
      await fileChooser.setFiles([]);
      return 'File chooser cancelled';
    }
  },
});

// -----------------------------------------------------------------------------
// browser-fill-form
// -----------------------------------------------------------------------------

server.tool('browser-fill-form', {
  description: 'Fill multiple form fields',
  parameters: {
    type: 'object',
    properties: {
      fields: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Human-readable field name' },
            type: {
              type: 'string',
              enum: ['textbox', 'checkbox', 'radio', 'combobox', 'slider'],
              description: 'Type of the field',
            },
            ref: {
              type: 'string',
              description: 'Exact target field reference from the page snapshot',
            },
            value: {
              type: 'string',
              description:
                'Value to fill in the field. If the field is a checkbox, the value should be `true` or `false`. If the field is a combobox, the value should be the text of the option.',
            },
          },
          required: ['name', 'type', 'ref', 'value'],
          additionalProperties: false,
        },
        description: 'Fields to fill in',
      },
    },
    required: ['fields'],
  },
  handler: async (args) => {
    const { page } = await ensureBrowser();
    const fields = args.fields as Array<{ name: string; type: string; ref: string; value: string }>;
    const results: string[] = [];

    for (const field of fields) {
      const el = await findElementByRef(page, field.ref);
      if (!el) {
        results.push(`❌ ${field.name}: Element not found`);
        continue;
      }

      try {
        switch (field.type) {
          case 'textbox':
            await el.fill(field.value);
            results.push(`✅ ${field.name}: filled with "${field.value}"`);
            break;

          case 'checkbox': {
            const shouldCheck = field.value === 'true';
            const isChecked = await el.isChecked();
            if (shouldCheck !== isChecked) {
              await el.click();
            }
            results.push(`✅ ${field.name}: ${shouldCheck ? 'checked' : 'unchecked'}`);
            break;
          }

          case 'radio':
            await el.click();
            results.push(`✅ ${field.name}: selected`);
            break;

          case 'combobox':
            await el.selectOption({ label: field.value });
            results.push(`✅ ${field.name}: selected "${field.value}"`);
            break;

          case 'slider':
            // For sliders, we need to set the value via JavaScript
            await el.evaluate((node, val) => {
              (node as HTMLInputElement).value = val;
              node.dispatchEvent(new Event('input', { bubbles: true }));
              node.dispatchEvent(new Event('change', { bubbles: true }));
            }, field.value);
            results.push(`✅ ${field.name}: set to ${field.value}`);
            break;

          default:
            results.push(`❌ ${field.name}: Unknown field type "${field.type}"`);
        }
      } catch (error) {
        results.push(
          `❌ ${field.name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }

    return results.join('\n');
  },
});

// -----------------------------------------------------------------------------
// browser-install
// -----------------------------------------------------------------------------

server.tool('browser-install', {
  description:
    'Install the browser specified in the config. Call this if you get an error about the browser not being installed.',
  parameters: { type: 'object', properties: {} },
  handler: async () => {
    const { execSync } = await import('child_process');
    try {
      execSync('npx playwright install chromium', { stdio: 'inherit' });
      return 'Chromium browser installed successfully';
    } catch (error) {
      throw new Error(`Failed to install browser: ${error}`);
    }
  },
});

// -----------------------------------------------------------------------------
// browser-press-key
// -----------------------------------------------------------------------------

server.tool('browser-press-key', {
  description: 'Press a key on the keyboard',
  parameters: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description:
          'Name of the key to press or a character to generate, such as `ArrowLeft` or `a`',
      },
    },
    required: ['key'],
  },
  handler: async (args) => {
    const { page } = await ensureBrowser();
    await page.keyboard.press(args.key as string);
    return `Pressed key: ${args.key}`;
  },
});

// -----------------------------------------------------------------------------
// browser-type
// -----------------------------------------------------------------------------

server.tool('browser-type', {
  description: 'Type text into editable element',
  parameters: {
    type: 'object',
    properties: {
      element: {
        type: 'string',
        description:
          'Human-readable element description used to obtain permission to interact with the element',
      },
      ref: { type: 'string', description: 'Exact target element reference from the page snapshot' },
      text: { type: 'string', description: 'Text to type into the element' },
      submit: {
        type: 'boolean',
        description: 'Whether to submit entered text (press Enter after)',
      },
      slowly: {
        type: 'boolean',
        description:
          'Whether to type one character at a time. Useful for triggering key handlers in the page. By default entire text is filled in at once.',
      },
    },
    required: ['element', 'ref', 'text'],
  },
  handler: async (args) => {
    const { page } = await ensureBrowser();
    const el = await findElementByRef(page, args.ref as string);

    if (!el) {
      throw new Error(`Element not found: ${args.ref}`);
    }

    lastActionTime = Date.now();

    if (args.slowly) {
      await el.type(args.text as string, { delay: 50 });
    } else {
      await el.fill(args.text as string);
    }

    if (args.submit) {
      await el.press('Enter');
    }

    return `Typed "${args.text}" into "${args.element}"`;
  },
});

// -----------------------------------------------------------------------------
// browser-navigate
// -----------------------------------------------------------------------------

server.tool('browser-navigate', {
  description: 'Navigate to a URL',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to navigate to' },
    },
    required: ['url'],
  },
  handler: async (args) => {
    const { page } = await ensureBrowser();
    lastNavigationTime = Date.now();
    lastActionTime = Date.now();
    await page.goto(args.url as string, { waitUntil: 'domcontentloaded' });
    return `Navigated to ${args.url}\n\nTitle: ${await page.title()}`;
  },
});

// -----------------------------------------------------------------------------
// browser-navigate-back
// -----------------------------------------------------------------------------

server.tool('browser-navigate-back', {
  description: 'Go back to the previous page',
  parameters: { type: 'object', properties: {} },
  handler: async () => {
    const { page } = await ensureBrowser();
    lastNavigationTime = Date.now();
    lastActionTime = Date.now();
    await page.goBack();
    return `Navigated back to ${page.url()}`;
  },
});

// -----------------------------------------------------------------------------
// browser-network-requests
// -----------------------------------------------------------------------------

server.tool('browser-network-requests', {
  description: 'Returns all network requests since loading the page',
  parameters: {
    type: 'object',
    properties: {
      includeStatic: {
        type: 'boolean',
        default: false,
        description:
          'Whether to include successful static resources like images, fonts, scripts, etc. Defaults to false.',
      },
    },
  },
  handler: async (args) => {
    const includeStatic = args.includeStatic as boolean;
    const staticTypes = ['image', 'font', 'stylesheet', 'script', 'media'];

    const filtered = includeStatic
      ? networkRequests
      : networkRequests.filter((r) => !staticTypes.includes(r.resourceType));

    if (filtered.length === 0) {
      return 'No network requests';
    }

    return filtered.map((r) => `${r.method} ${r.url} -> ${r.status || 'pending'}`).join('\n');
  },
});

// -----------------------------------------------------------------------------
// browser-run-code
// -----------------------------------------------------------------------------

server.tool('browser-run-code', {
  description: 'Run Playwright code snippet',
  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description:
          "A JavaScript function containing Playwright code to execute. It will be invoked with a single argument, page, which you can use for any page interaction. For example: `async (page) => { await page.getByRole('button', { name: 'Submit' }).click(); return await page.title(); }`",
      },
    },
    required: ['code'],
  },
  handler: async (args) => {
    const { page } = await ensureBrowser();
    const code = args.code as string;

    // Create an async function from the code string and execute it with the page
    const fn = new Function('page', `return (${code})(page)`);
    const result = await fn(page);

    if (result === undefined) {
      return 'Code executed successfully (no return value)';
    }

    return JSON.stringify(result, null, 2);
  },
});

// -----------------------------------------------------------------------------
// browser-take-screenshot
// -----------------------------------------------------------------------------

server.tool('browser-take-screenshot', {
  description:
    "Take a screenshot of the current page. You can't perform actions based on the screenshot, use browser_snapshot for actions. Screenshots are saved to /workspace/ (shared volume).",
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['png', 'jpeg'],
        default: 'png',
        description: 'Image format for the screenshot. Default is png.',
      },
      filename: {
        type: 'string',
        description:
          'File name for the screenshot (e.g., "screenshot.png"). Saved to /workspace/. Defaults to screenshot-{timestamp}.{png|jpeg}.',
      },
      element: {
        type: 'string',
        description:
          'Human-readable element description used to obtain permission to screenshot the element. If not provided, the screenshot will be taken of viewport. If element is provided, ref must be provided too.',
      },
      ref: {
        type: 'string',
        description:
          'Exact target element reference from the page snapshot. If not provided, the screenshot will be taken of viewport. If ref is provided, element must be provided too.',
      },
      fullPage: {
        type: 'boolean',
        description:
          'When true, takes a screenshot of the full scrollable page, instead of the currently visible viewport. Cannot be used with element screenshots.',
      },
    },
  },
  handler: async (args) => {
    const { page } = await ensureBrowser();
    const fs = await import('fs/promises');
    const pathModule = await import('path');

    const format = (args.type as 'png' | 'jpeg') || 'png';
    let filename = (args.filename as string) || `screenshot-${Date.now()}.${format}`;

    // Always save to /workspace/ (shared volume) if path is not absolute
    // or if it doesn't start with /workspace
    if (!pathModule.isAbsolute(filename)) {
      filename = pathModule.join('/workspace', filename);
    } else if (!filename.startsWith('/workspace')) {
      // Force all screenshots to /workspace for security
      const basename = pathModule.basename(filename);
      filename = pathModule.join('/workspace', basename);
    }

    // Ensure parent directory exists
    const parentDir = pathModule.dirname(filename);
    await fs.mkdir(parentDir, { recursive: true });

    if (args.ref) {
      const element = await findElementByRef(page, args.ref as string);
      if (element) {
        await element.screenshot({ path: filename, type: format });
        return `Screenshot of element saved to ${filename}`;
      }
    }

    await page.screenshot({
      path: filename,
      type: format,
      fullPage: args.fullPage as boolean,
    });
    return `Screenshot saved to ${filename}`;
  },
});

// -----------------------------------------------------------------------------
// browser-snapshot
// -----------------------------------------------------------------------------

server.tool('browser-snapshot', {
  description: 'Capture accessibility snapshot of the current page, this is better than screenshot',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description:
          'Save snapshot to markdown file in /workspace/ instead of returning it in the response (e.g., "snapshot.md").',
      },
    },
  },
  handler: async (args) => {
    const { page } = await ensureBrowser();
    const snapshot = await getAccessibilitySnapshot(page);

    if (args.filename) {
      const fs = await import('fs/promises');
      const pathModule = await import('path');

      let filename = args.filename as string;

      // Always save to /workspace/ (shared volume)
      if (!pathModule.isAbsolute(filename)) {
        filename = pathModule.join('/workspace', filename);
      } else if (!filename.startsWith('/workspace')) {
        const basename = pathModule.basename(filename);
        filename = pathModule.join('/workspace', basename);
      }

      const parentDir = pathModule.dirname(filename);
      await fs.mkdir(parentDir, { recursive: true });

      await fs.writeFile(filename, snapshot);
      return `Snapshot saved to ${filename}`;
    }

    return snapshot;
  },
});

// -----------------------------------------------------------------------------
// browser-click
// -----------------------------------------------------------------------------

server.tool('browser-click', {
  description: 'Perform click on a web page',
  parameters: {
    type: 'object',
    properties: {
      element: {
        type: 'string',
        description:
          'Human-readable element description used to obtain permission to interact with the element',
      },
      ref: { type: 'string', description: 'Exact target element reference from the page snapshot' },
      doubleClick: {
        type: 'boolean',
        description: 'Whether to perform a double click instead of a single click',
      },
      button: {
        type: 'string',
        enum: ['left', 'right', 'middle'],
        description: 'Button to click, defaults to left',
      },
      modifiers: {
        type: 'array',
        items: { type: 'string', enum: ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'] },
        description: 'Modifier keys to press',
      },
    },
    required: ['element', 'ref'],
  },
  handler: async (args) => {
    const { page } = await ensureBrowser();
    const el = await findElementByRef(page, args.ref as string);

    if (!el) {
      throw new Error(`Element not found: ${args.ref}`);
    }

    const clickOptions: any = {
      button: args.button || 'left',
      clickCount: args.doubleClick ? 2 : 1,
    };

    if (args.modifiers) {
      clickOptions.modifiers = args.modifiers;
    }

    lastActionTime = Date.now();
    await el.click(clickOptions);
    return `Clicked on "${args.element}"`;
  },
});

// -----------------------------------------------------------------------------
// browser-drag
// -----------------------------------------------------------------------------

server.tool('browser-drag', {
  description: 'Perform drag and drop between two elements',
  parameters: {
    type: 'object',
    properties: {
      startElement: {
        type: 'string',
        description:
          'Human-readable source element description used to obtain the permission to interact with the element',
      },
      startRef: {
        type: 'string',
        description: 'Exact source element reference from the page snapshot',
      },
      endElement: {
        type: 'string',
        description:
          'Human-readable target element description used to obtain the permission to interact with the element',
      },
      endRef: {
        type: 'string',
        description: 'Exact target element reference from the page snapshot',
      },
    },
    required: ['startElement', 'startRef', 'endElement', 'endRef'],
  },
  handler: async (args) => {
    const { page } = await ensureBrowser();

    const startEl = await findElementByRef(page, args.startRef as string);
    if (!startEl) {
      throw new Error(`Source element not found: ${args.startRef}`);
    }

    const endEl = await findElementByRef(page, args.endRef as string);
    if (!endEl) {
      throw new Error(`Target element not found: ${args.endRef}`);
    }

    // Get bounding boxes
    const startBox = await startEl.boundingBox();
    const endBox = await endEl.boundingBox();

    if (!startBox || !endBox) {
      throw new Error('Could not get element positions');
    }

    // Perform drag and drop
    await page.mouse.move(startBox.x + startBox.width / 2, startBox.y + startBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(endBox.x + endBox.width / 2, endBox.y + endBox.height / 2, { steps: 10 });
    await page.mouse.up();

    return `Dragged "${args.startElement}" to "${args.endElement}"`;
  },
});

// -----------------------------------------------------------------------------
// browser-hover
// -----------------------------------------------------------------------------

server.tool('browser-hover', {
  description: 'Hover over element on page',
  parameters: {
    type: 'object',
    properties: {
      element: {
        type: 'string',
        description:
          'Human-readable element description used to obtain permission to interact with the element',
      },
      ref: { type: 'string', description: 'Exact target element reference from the page snapshot' },
    },
    required: ['element', 'ref'],
  },
  handler: async (args) => {
    const { page } = await ensureBrowser();
    const el = await findElementByRef(page, args.ref as string);

    if (!el) {
      throw new Error(`Element not found: ${args.ref}`);
    }

    await el.hover();
    return `Hovered over "${args.element}"`;
  },
});

// -----------------------------------------------------------------------------
// browser-select-option
// -----------------------------------------------------------------------------

server.tool('browser-select-option', {
  description: 'Select an option in a dropdown',
  parameters: {
    type: 'object',
    properties: {
      element: {
        type: 'string',
        description:
          'Human-readable element description used to obtain permission to interact with the element',
      },
      ref: { type: 'string', description: 'Exact target element reference from the page snapshot' },
      values: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Array of values to select in the dropdown. This can be a single value or multiple values.',
      },
    },
    required: ['element', 'ref', 'values'],
  },
  handler: async (args) => {
    const { page } = await ensureBrowser();
    const el = await findElementByRef(page, args.ref as string);

    if (!el) {
      throw new Error(`Element not found: ${args.ref}`);
    }

    await el.selectOption(args.values as string[]);
    return `Selected options in "${args.element}"`;
  },
});

// -----------------------------------------------------------------------------
// browser-tabs
// -----------------------------------------------------------------------------

server.tool('browser-tabs', {
  description: 'List, create, close, or select a browser tab.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'new', 'close', 'select'],
        description: 'Operation to perform',
      },
      index: {
        type: 'number',
        description:
          'Tab index, used for close/select. If omitted for close, current tab is closed.',
      },
    },
    required: ['action'],
  },
  handler: async (args) => {
    const { context } = await ensureBrowser();
    const pages = context.pages();

    switch (args.action) {
      case 'list':
        return pages.map((p, i) => `${i}: ${p.url()} ${p === page ? '(active)' : ''}`).join('\n');

      case 'new':
        page = await context.newPage();
        return `Created new tab (${pages.length} tabs total)`;

      case 'close': {
        const closeIndex = (args.index as number) ?? pages.indexOf(page!);
        if (closeIndex >= 0 && closeIndex < pages.length) {
          await pages[closeIndex].close();
          if (pages[closeIndex] === page) {
            page = pages[0] || null;
          }
          return `Closed tab ${closeIndex}`;
        }
        return 'Invalid tab index';
      }

      case 'select': {
        const selectIndex = args.index as number;
        if (selectIndex >= 0 && selectIndex < pages.length) {
          page = pages[selectIndex];
          await page.bringToFront();
          return `Selected tab ${selectIndex}: ${page.url()}`;
        }
        return 'Invalid tab index';
      }

      default:
        return 'Unknown action';
    }
  },
});

// -----------------------------------------------------------------------------
// browser-wait-for
// -----------------------------------------------------------------------------

server.tool('browser-wait-for', {
  description: 'Wait for text to appear or disappear or a specified time to pass',
  parameters: {
    type: 'object',
    properties: {
      time: { type: 'number', description: 'The time to wait in seconds' },
      text: { type: 'string', description: 'The text to wait for' },
      textGone: { type: 'string', description: 'The text to wait for to disappear' },
    },
  },
  handler: async (args) => {
    const { page } = await ensureBrowser();

    if (args.time) {
      await page.waitForTimeout((args.time as number) * 1000);
      return `Waited ${args.time} seconds`;
    }

    if (args.text) {
      await page.waitForSelector(`text=${args.text}`);
      return `Text "${args.text}" appeared`;
    }

    if (args.textGone) {
      await page.waitForSelector(`text=${args.textGone}`, { state: 'hidden' });
      return `Text "${args.textGone}" disappeared`;
    }

    return 'Nothing to wait for';
  },
});

// =============================================================================
// START SERVER
// =============================================================================

server
  .start()
  .then(() => {
    console.error('🎭 Playwright MCA server running');
  })
  .catch((error) => {
    console.error('Failed to start Playwright MCA:', error);
    process.exit(1);
  });

// Cleanup on exit
process.on('SIGTERM', async () => {
  await closeBrowser();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await closeBrowser();
  process.exit(0);
});
