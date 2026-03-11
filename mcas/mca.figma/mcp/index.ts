#!/usr/bin/env npx tsx

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// MCA SDK imports
import { createWebSocketClient, HealthCheckBuilder, type McaWebSocketClient } from '@teros/mca-sdk';

/**
 * Figma MCA - Design File Integration
 *
 * Features:
 * - Access Figma design files, extract styles, components, design tokens
 * - Export assets as images
 * - WebSocket connection to backend for bidirectional communication
 * - Standardized health check protocol
 *
 * Environment Variables:
 *
 * SECRETS (from backend via WebSocket or env):
 * - SECRET_USER_PERSONAL_ACCESS_TOKEN - Figma Personal Access Token
 *
 * MCA Config:
 * - MCA_APP_ID - App instance ID
 * - MCA_APP_NAME - App name (used for tool prefixes)
 * - MCA_WS_ENABLED - Whether WebSocket is enabled
 * - MCA_WS_URL - WebSocket URL to connect to backend
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

const MCA_APP_ID = process.env.MCA_APP_ID || 'unknown';
const MCA_APP_NAME = process.env.MCA_APP_NAME || 'figma';
const MCA_BACKEND_URL = process.env.MCA_BACKEND_URL;
if (!MCA_BACKEND_URL) throw new Error('MCA_BACKEND_URL environment variable is required');

const FIGMA_API_BASE = 'https://api.figma.com/v1';

// WebSocket client for backend communication
let wsClient: McaWebSocketClient | null = null;
let credentialsAvailable = false;

// Cached secrets from WebSocket
let cachedUserSecrets: Record<string, string> | null = null;

/**
 * Get the Personal Access Token from cached secrets or environment
 */
function getAccessToken(): string | null {
  return (
    cachedUserSecrets?.PERSONAL_ACCESS_TOKEN ||
    cachedUserSecrets?.personal_access_token ||
    process.env.SECRET_USER_PERSONAL_ACCESS_TOKEN ||
    process.env.FIGMA_PERSONAL_ACCESS_TOKEN ||
    null
  );
}

/**
 * Check if access token is configured
 */
function isConfigured(): boolean {
  return !!getAccessToken();
}

/**
 * Get the Team ID from cached secrets or environment
 */
function getTeamId(): string | null {
  return (
    cachedUserSecrets?.TEAM_ID ||
    cachedUserSecrets?.team_id ||
    process.env.SECRET_USER_TEAM_ID ||
    process.env.FIGMA_TEAM_ID ||
    null
  );
}

// =============================================================================
// Types
// =============================================================================

interface FigmaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface FigmaPaint {
  type: string;
  color?: FigmaColor;
  opacity?: number;
  gradientStops?: Array<{ color: FigmaColor; position: number }>;
}

interface FigmaTypeStyle {
  fontFamily: string;
  fontPostScriptName?: string;
  fontWeight: number;
  fontSize: number;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  letterSpacing?: number;
  lineHeightPx?: number;
  lineHeightPercent?: number;
  lineHeightUnit?: string;
}

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
  fills?: FigmaPaint[];
  strokes?: FigmaPaint[];
  style?: FigmaTypeStyle;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  constraints?: { vertical: string; horizontal: string };
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  strokeWeight?: number;
  effects?: any[];
  componentId?: string;
  componentSetId?: string;
}

interface FigmaFile {
  name: string;
  lastModified: string;
  thumbnailUrl: string;
  version: string;
  document: FigmaNode;
  components: Record<string, any>;
  componentSets: Record<string, any>;
  styles: Record<string, any>;
}

interface FigmaStyle {
  key: string;
  name: string;
  styleType: 'FILL' | 'TEXT' | 'EFFECT' | 'GRID';
  description: string;
}

interface FigmaVariable {
  id: string;
  name: string;
  resolvedType: string;
  valuesByMode: Record<string, any>;
}

interface FigmaVariableCollection {
  id: string;
  name: string;
  modes: Array<{ modeId: string; name: string }>;
  variableIds: string[];
}

// =============================================================================
// API Helpers
// =============================================================================

async function figmaRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = getAccessToken();
  if (!token) {
    throw new Error('Figma Personal Access Token not configured');
  }

  const url = `${FIGMA_API_BASE}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'X-Figma-Token': token,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Figma API error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<T>;
}

// =============================================================================
// Color Utilities
// =============================================================================

function rgbaToHex(color: FigmaColor): string {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = color.a ?? 1;

  if (a < 1) {
    return `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`;
  }
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function colorToTailwind(name: string, color: FigmaColor): string {
  const hex = rgbaToHex(color);
  const safeName = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-');
  return `"${safeName}": "${hex}"`;
}

// =============================================================================
// Node Processing
// =============================================================================

function simplifyNode(node: FigmaNode, depth: number, currentDepth = 0): any {
  const simplified: any = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  if (node.absoluteBoundingBox) {
    simplified.bounds = {
      width: Math.round(node.absoluteBoundingBox.width),
      height: Math.round(node.absoluteBoundingBox.height),
    };
  }

  if (node.fills?.length) {
    simplified.fills = node.fills
      .filter((f) => f.type !== 'IMAGE')
      .map((f) => ({
        type: f.type,
        color: f.color ? rgbaToHex(f.color) : undefined,
      }));
  }

  if (node.strokes?.length) {
    simplified.strokes = node.strokes.map((s) => ({
      type: s.type,
      color: s.color ? rgbaToHex(s.color) : undefined,
    }));
    if (node.strokeWeight) {
      simplified.strokeWeight = node.strokeWeight;
    }
  }

  if (node.cornerRadius) {
    simplified.cornerRadius = node.cornerRadius;
  }

  if (node.style) {
    simplified.textStyle = {
      fontFamily: node.style.fontFamily,
      fontSize: node.style.fontSize,
      fontWeight: node.style.fontWeight,
      lineHeight: node.style.lineHeightPx,
      letterSpacing: node.style.letterSpacing,
    };
  }

  if (node.componentId) {
    simplified.componentId = node.componentId;
  }

  if (node.children && currentDepth < depth) {
    simplified.children = node.children.map((child) =>
      simplifyNode(child, depth, currentDepth + 1),
    );
  } else if (node.children) {
    simplified.childCount = node.children.length;
  }

  return simplified;
}

function extractColorsFromNode(node: FigmaNode, colors: Map<string, FigmaColor>): void {
  if (node.fills) {
    for (const fill of node.fills) {
      if (fill.color && fill.type === 'SOLID') {
        const hex = rgbaToHex(fill.color);
        if (!colors.has(hex)) {
          colors.set(hex, fill.color);
        }
      }
    }
  }

  if (node.strokes) {
    for (const stroke of node.strokes) {
      if (stroke.color && stroke.type === 'SOLID') {
        const hex = rgbaToHex(stroke.color);
        if (!colors.has(hex)) {
          colors.set(hex, stroke.color);
        }
      }
    }
  }

  if (node.children) {
    for (const child of node.children) {
      extractColorsFromNode(child, colors);
    }
  }
}

function extractTypographyFromNode(node: FigmaNode, styles: Map<string, FigmaTypeStyle>): void {
  if (node.style && node.type === 'TEXT') {
    const key = `${node.style.fontFamily}-${node.style.fontSize}-${node.style.fontWeight}`;
    if (!styles.has(key)) {
      styles.set(key, node.style);
    }
  }

  if (node.children) {
    for (const child of node.children) {
      extractTypographyFromNode(child, styles);
    }
  }
}

// =============================================================================
// MCP Server
// =============================================================================

const server = new Server(
  {
    name: 'figma',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: '-health-check',
        description:
          'Internal health check tool. Verifies Personal Access Token and connectivity to Figma.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get-file',
        description:
          'Get the full structure of a Figma file including pages, frames, and components.',
        inputSchema: {
          type: 'object',
          properties: {
            fileKey: { type: 'string', description: 'The file key from Figma URL' },
            depth: { type: 'number', description: 'How deep to traverse (default: 2)' },
          },
          required: ['fileKey'],
        },
      },
      {
        name: 'get-file-styles',
        description: 'Get all styles (colors, text, effects) defined in a Figma file.',
        inputSchema: {
          type: 'object',
          properties: {
            fileKey: { type: 'string', description: 'The file key from Figma URL' },
          },
          required: ['fileKey'],
        },
      },
      {
        name: 'get-file-variables',
        description: 'Get all variables (design tokens) from a Figma file.',
        inputSchema: {
          type: 'object',
          properties: {
            fileKey: { type: 'string', description: 'The file key from Figma URL' },
          },
          required: ['fileKey'],
        },
      },
      {
        name: 'get-node',
        description: 'Get detailed information about a specific node by its ID.',
        inputSchema: {
          type: 'object',
          properties: {
            fileKey: { type: 'string', description: 'The file key from Figma URL' },
            nodeId: { type: 'string', description: 'The node ID' },
            depth: { type: 'number', description: 'How deep to traverse children (default: 3)' },
          },
          required: ['fileKey', 'nodeId'],
        },
      },
      {
        name: 'get-components',
        description: 'List all components in a Figma file.',
        inputSchema: {
          type: 'object',
          properties: {
            fileKey: { type: 'string', description: 'The file key from Figma URL' },
          },
          required: ['fileKey'],
        },
      },
      {
        name: 'get-component-sets',
        description: 'List all component sets (variants) in a Figma file.',
        inputSchema: {
          type: 'object',
          properties: {
            fileKey: { type: 'string', description: 'The file key from Figma URL' },
          },
          required: ['fileKey'],
        },
      },
      {
        name: 'export-images',
        description: 'Export nodes as images (PNG, JPG, SVG, or PDF).',
        inputSchema: {
          type: 'object',
          properties: {
            fileKey: { type: 'string', description: 'The file key from Figma URL' },
            nodeIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Node IDs to export',
            },
            format: {
              type: 'string',
              enum: ['png', 'jpg', 'svg', 'pdf'],
              description: 'Export format',
            },
            scale: { type: 'number', description: 'Scale factor (0.01 to 4)' },
          },
          required: ['fileKey', 'nodeIds'],
        },
      },
      {
        name: 'get-comments',
        description: 'Get all comments on a Figma file.',
        inputSchema: {
          type: 'object',
          properties: {
            fileKey: { type: 'string', description: 'The file key from Figma URL' },
          },
          required: ['fileKey'],
        },
      },
      {
        name: 'get-team-projects',
        description:
          'List all projects in a team. If teamId is not provided, uses the configured TEAM_ID from user secrets.',
        inputSchema: {
          type: 'object',
          properties: {
            teamId: {
              type: 'string',
              description: 'The team ID (optional if TEAM_ID is configured in user secrets)',
            },
          },
        },
      },
      {
        name: 'get-project-files',
        description: 'List all files in a project.',
        inputSchema: {
          type: 'object',
          properties: {
            projectId: { type: 'string', description: 'The project ID' },
          },
          required: ['projectId'],
        },
      },
      {
        name: 'extract-colors',
        description: 'Extract all colors used in a file or node, formatted for CSS/Tailwind.',
        inputSchema: {
          type: 'object',
          properties: {
            fileKey: { type: 'string', description: 'The file key from Figma URL' },
            nodeId: { type: 'string', description: 'Optional: specific node ID' },
            format: {
              type: 'string',
              enum: ['css', 'tailwind', 'json'],
              description: 'Output format',
            },
          },
          required: ['fileKey'],
        },
      },
      {
        name: 'extract-typography',
        description: 'Extract all typography styles from a file.',
        inputSchema: {
          type: 'object',
          properties: {
            fileKey: { type: 'string', description: 'The file key from Figma URL' },
            format: {
              type: 'string',
              enum: ['css', 'tailwind', 'json'],
              description: 'Output format',
            },
          },
          required: ['fileKey'],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const params = (args || {}) as Record<string, any>;

  try {
    // Health check - uses standardized format from @teros/mca-sdk
    if (name === '-health-check') {
      const builder = new HealthCheckBuilder({
        user: cachedUserSecrets,
      }).setVersion('1.0.0');

      // Check user secrets (Personal Access Token)
      builder.requireUserSecret('PERSONAL_ACCESS_TOKEN', {
        description: 'Configure your Figma Personal Access Token in app settings',
      });

      const token = getAccessToken();

      if (!token) {
        builder.addIssue('USER_CONFIG_MISSING', 'Figma Personal Access Token not configured', {
          type: 'user_action',
          description: 'Configure your Figma Personal Access Token in app settings',
          actionUrl: `${MCA_BACKEND_URL}/apps/${MCA_APP_ID}/configure`,
        });
      } else {
        // Try to validate token by making a simple request
        try {
          const response = await fetch(`${FIGMA_API_BASE}/me`, {
            headers: { 'X-Figma-Token': token },
          });

          if (!response.ok) {
            if (response.status === 403) {
              builder.addIssue(
                'AUTH_INVALID',
                'Figma Personal Access Token is invalid or expired',
                {
                  type: 'user_action',
                  description:
                    'Your token is invalid. Please generate a new one at figma.com and update your settings.',
                  actionUrl: 'https://www.figma.com/developers/api#access-tokens',
                },
              );
            } else {
              builder.addIssue(
                'DEPENDENCY_UNAVAILABLE',
                `Figma API error: ${response.statusText}`,
                {
                  type: 'auto_retry',
                  description: 'Figma API temporarily unavailable',
                },
              );
            }
          }
          // If response is OK, no issues to add - we're healthy
        } catch (error: any) {
          builder.addIssue(
            'DEPENDENCY_UNAVAILABLE',
            `Failed to connect to Figma: ${error.message}`,
            {
              type: 'auto_retry',
              description: 'Network error connecting to Figma API',
            },
          );
        }
      }

      const healthResult = builder.build();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(healthResult, null, 2),
          },
        ],
      };
    }

    // For all other tools, ensure token is configured
    if (!isConfigured()) {
      throw new Error(
        'Figma Personal Access Token not configured. Please configure it in your app settings.',
      );
    }

    switch (name) {
      // =========================================================================
      // figma_get-file
      // =========================================================================
      case 'get-file': {
        const depth = Math.min(params.depth || 2, 10);
        const file = await figmaRequest<FigmaFile>(`/files/${params.fileKey}?depth=${depth}`);

        const result = {
          name: file.name,
          lastModified: file.lastModified,
          version: file.version,
          thumbnailUrl: file.thumbnailUrl,
          document: simplifyNode(file.document, depth),
          componentCount: Object.keys(file.components || {}).length,
          styleCount: Object.keys(file.styles || {}).length,
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      // =========================================================================
      // figma_get-file-styles
      // =========================================================================
      case 'get-file-styles': {
        const file = await figmaRequest<FigmaFile>(`/files/${params.fileKey}`);

        const styles = Object.entries(file.styles || {}).map(([id, style]: [string, any]) => ({
          id,
          key: style.key,
          name: style.name,
          type: style.styleType,
          description: style.description || '',
        }));

        return {
          content: [
            { type: 'text', text: JSON.stringify({ styles, count: styles.length }, null, 2) },
          ],
        };
      }

      // =========================================================================
      // figma_get-file-variables
      // =========================================================================
      case 'get-file-variables': {
        const response = await figmaRequest<{
          meta: {
            variables: Record<string, FigmaVariable>;
            variableCollections: Record<string, FigmaVariableCollection>;
          };
        }>(`/files/${params.fileKey}/variables/local`);

        const collections = Object.values(response.meta.variableCollections || {}).map((col) => ({
          id: col.id,
          name: col.name,
          modes: col.modes,
          variables: col.variableIds.map((varId) => {
            const variable = response.meta.variables[varId];
            return {
              id: variable.id,
              name: variable.name,
              type: variable.resolvedType,
              values: variable.valuesByMode,
            };
          }),
        }));

        return {
          content: [{ type: 'text', text: JSON.stringify({ collections }, null, 2) }],
        };
      }

      // =========================================================================
      // figma_get-node
      // =========================================================================
      case 'get-node': {
        const depth = Math.min(params.depth || 3, 10);
        const nodeId = params.nodeId.replace('-', ':');

        const response = await figmaRequest<{ nodes: Record<string, { document: FigmaNode }> }>(
          `/files/${params.fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&depth=${depth}`,
        );

        const nodeData = response.nodes[nodeId];
        if (!nodeData) {
          throw new Error(`Node ${params.nodeId} not found`);
        }

        return {
          content: [
            { type: 'text', text: JSON.stringify(simplifyNode(nodeData.document, depth), null, 2) },
          ],
        };
      }

      // =========================================================================
      // figma_get-components
      // =========================================================================
      case 'get-components': {
        const file = await figmaRequest<FigmaFile>(`/files/${params.fileKey}`);

        const components = Object.entries(file.components || {}).map(
          ([id, comp]: [string, any]) => ({
            id,
            key: comp.key,
            name: comp.name,
            description: comp.description || '',
            componentSetId: comp.componentSetId,
          }),
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ components, count: components.length }, null, 2),
            },
          ],
        };
      }

      // =========================================================================
      // figma_get-component-sets
      // =========================================================================
      case 'get-component-sets': {
        const file = await figmaRequest<FigmaFile>(`/files/${params.fileKey}`);

        const componentSets = Object.entries(file.componentSets || {}).map(
          ([id, set]: [string, any]) => ({
            id,
            key: set.key,
            name: set.name,
            description: set.description || '',
          }),
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ componentSets, count: componentSets.length }, null, 2),
            },
          ],
        };
      }

      // =========================================================================
      // figma_export-images
      // =========================================================================
      case 'export-images': {
        const format = params.format || 'png';
        const scale = Math.min(Math.max(params.scale || 1, 0.01), 4);
        const nodeIds = params.nodeIds.map((id: string) => id.replace('-', ':')).join(',');

        const response = await figmaRequest<{ images: Record<string, string> }>(
          `/images/${params.fileKey}?ids=${encodeURIComponent(nodeIds)}&format=${format}&scale=${scale}`,
        );

        const images = Object.entries(response.images).map(([nodeId, url]) => ({
          nodeId,
          url,
          format,
          scale,
        }));

        return {
          content: [{ type: 'text', text: JSON.stringify({ images }, null, 2) }],
        };
      }

      // =========================================================================
      // figma_get-comments
      // =========================================================================
      case 'get-comments': {
        const response = await figmaRequest<{ comments: any[] }>(
          `/files/${params.fileKey}/comments`,
        );

        const comments = response.comments.map((c) => ({
          id: c.id,
          message: c.message,
          createdAt: c.created_at,
          user: c.user?.handle || 'Unknown',
          resolved: c.resolved_at != null,
        }));

        return {
          content: [
            { type: 'text', text: JSON.stringify({ comments, count: comments.length }, null, 2) },
          ],
        };
      }

      // =========================================================================
      // figma_get-team-projects
      // =========================================================================
      case 'get-team-projects': {
        const teamId = params.teamId || getTeamId();
        if (!teamId) {
          throw new Error(
            'Team ID is required. Either pass teamId parameter or configure TEAM_ID in user secrets.',
          );
        }

        const response = await figmaRequest<{ projects: any[] }>(`/teams/${teamId}/projects`);

        const projects = response.projects.map((p) => ({
          id: p.id,
          name: p.name,
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ teamId, projects, count: projects.length }, null, 2),
            },
          ],
        };
      }

      // =========================================================================
      // figma_get-project-files
      // =========================================================================
      case 'get-project-files': {
        const response = await figmaRequest<{ files: any[] }>(
          `/projects/${params.projectId}/files`,
        );

        const files = response.files.map((f) => ({
          key: f.key,
          name: f.name,
          thumbnailUrl: f.thumbnail_url,
          lastModified: f.last_modified,
        }));

        return {
          content: [
            { type: 'text', text: JSON.stringify({ files, count: files.length }, null, 2) },
          ],
        };
      }

      // =========================================================================
      // figma_extract-colors
      // =========================================================================
      case 'extract-colors': {
        let document: FigmaNode;

        if (params.nodeId) {
          const nodeId = params.nodeId.replace('-', ':');
          const response = await figmaRequest<{ nodes: Record<string, { document: FigmaNode }> }>(
            `/files/${params.fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&depth=100`,
          );
          document = response.nodes[nodeId]?.document;
          if (!document) throw new Error(`Node ${params.nodeId} not found`);
        } else {
          const file = await figmaRequest<FigmaFile>(`/files/${params.fileKey}?depth=100`);
          document = file.document;
        }

        const colors = new Map<string, FigmaColor>();
        extractColorsFromNode(document, colors);

        const format = params.format || 'css';
        let output: string;

        if (format === 'css') {
          const cssVars = Array.from(colors.entries())
            .map(([hex], i) => `  --color-${i + 1}: ${hex};`)
            .join('\n');
          output = `:root {\n${cssVars}\n}`;
        } else if (format === 'tailwind') {
          const tailwindColors = Array.from(colors.entries())
            .map(([hex], i) => `  "color-${i + 1}": "${hex}"`)
            .join(',\n');
          output = `// tailwind.config.js colors\n{\n${tailwindColors}\n}`;
        } else {
          output = JSON.stringify(Array.from(colors.keys()), null, 2);
        }

        return {
          content: [{ type: 'text', text: `Found ${colors.size} unique colors:\n\n${output}` }],
        };
      }

      // =========================================================================
      // figma_extract-typography
      // =========================================================================
      case 'extract-typography': {
        const file = await figmaRequest<FigmaFile>(`/files/${params.fileKey}?depth=100`);

        const styles = new Map<string, FigmaTypeStyle>();
        extractTypographyFromNode(file.document, styles);

        const format = params.format || 'css';
        let output: string;

        const styleArray = Array.from(styles.values());

        if (format === 'css') {
          const cssClasses = styleArray
            .map((style, i) => {
              return `.text-style-${i + 1} {
  font-family: "${style.fontFamily}";
  font-size: ${style.fontSize}px;
  font-weight: ${style.fontWeight};${style.lineHeightPx ? `\n  line-height: ${style.lineHeightPx}px;` : ''}${style.letterSpacing ? `\n  letter-spacing: ${style.letterSpacing}px;` : ''}
}`;
            })
            .join('\n\n');
          output = cssClasses;
        } else if (format === 'tailwind') {
          const tailwindConfig = styleArray
            .map((style, i) => {
              return `"text-${i + 1}": ["${style.fontSize}px", { lineHeight: "${style.lineHeightPx || style.fontSize * 1.5}px", fontWeight: "${style.fontWeight}" }]`;
            })
            .join(',\n  ');
          output = `// tailwind.config.js fontSize\n{\n  ${tailwindConfig}\n}`;
        } else {
          output = JSON.stringify(styleArray, null, 2);
        }

        return {
          content: [
            { type: 'text', text: `Found ${styles.size} unique typography styles:\n\n${output}` },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `❌ Error: ${error.message}` }],
      isError: true,
    };
  }
});

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  console.error(`🎨 Figma MCA starting (appId: ${MCA_APP_ID}, name: ${MCA_APP_NAME})`);

  // Connect to backend via WebSocket FIRST to get secrets
  wsClient = createWebSocketClient();
  if (wsClient) {
    wsClient.on('disconnected', (code, reason) => {
      console.error(`🔌 Disconnected from backend: ${code} ${reason}`);
    });

    wsClient.on('command', (command) => {
      if (command.command === 'shutdown') {
        console.error('📴 Shutdown command received');
        gracefulShutdown();
      } else if (command.command === 'health_check') {
        const status = credentialsAvailable ? 'ready' : 'not_ready';
        wsClient!.sendHealthUpdate(status);
      }
    });

    try {
      // Connect and wait for connection
      await wsClient.connect();
      console.error('🔌 Connected to backend via WebSocket');

      // Request secrets via WebSocket
      console.error('🔐 Requesting secrets via WebSocket...');

      try {
        cachedUserSecrets = await wsClient.getUserSecrets();
        console.error(
          `✅ User secrets loaded: ${cachedUserSecrets ? Object.keys(cachedUserSecrets).join(', ') : 'null'}`,
        );
        // Debug: log full object
        console.error(`🔍 Full secrets object: ${JSON.stringify(cachedUserSecrets, null, 2)}`);
        credentialsAvailable = isConfigured();
      } catch (error: any) {
        console.error(`⚠️ Failed to get user secrets: ${error.message}`);
      }
    } catch (error: any) {
      console.error(`⚠️ WebSocket connection failed: ${error.message}`);
    }
  } else {
    console.error('📡 WebSocket not enabled (MCA_WS_ENABLED != true)');
    // Try to use environment variables directly
    credentialsAvailable = isConfigured();
  }

  if (credentialsAvailable) {
    console.error('✅ Figma Personal Access Token configured');
  } else {
    console.error(
      '⚠️ Figma Personal Access Token not configured - health check will report USER_CONFIG_MISSING',
    );
  }

  // Send initial health status via WebSocket
  if (wsClient?.connected) {
    const status = credentialsAvailable ? 'ready' : 'not_ready';
    wsClient.sendHealthUpdate(status);
  }

  // Start MCP server on stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('🔗 Figma MCP Server running on stdio');
}

async function gracefulShutdown() {
  console.error('👋 Shutting down Figma MCA...');

  if (wsClient) {
    wsClient.disconnect();
  }

  process.exit(0);
}

// Handle shutdown signals
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
