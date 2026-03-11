#!/usr/bin/env npx tsx

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { exec } from 'child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { glob } from 'glob';
import { basename, dirname, join } from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Session state for file safety tracking (like OpenCode)
// Tracks files that have been read in this session to prevent accidental overwrites
const filesReadInSession = new Set<string>();

const server = new Server(
  {
    name: 'mca.teros.filesystem',
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
        name: 'read',
        description:
          'Read file contents with optional offset and limit. Returns up to 2000 lines by default with line numbers (cat -n format).',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Absolute path to the file to read',
            },
            offset: {
              type: 'number',
              description: 'Line number to start reading from (0-based, optional)',
            },
            limit: {
              type: 'number',
              description: 'Number of lines to read (default: 2000, optional)',
            },
          },
          required: ['filePath'],
        },
      },
      {
        name: 'write',
        description:
          'Write content to a file (creates new file or overwrites existing). IMPORTANT: You must read the file first using filesystem_read before overwriting it. ALWAYS prefer filesystem_edit for modifying existing files to prevent data loss.',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Absolute path to the file to write',
            },
            content: {
              type: 'string',
              description: 'Content to write to the file',
            },
          },
          required: ['filePath', 'content'],
        },
      },
      {
        name: 'edit',
        description:
          'Edit file by replacing exact string matches. SAFETY: If oldString appears multiple times, you MUST provide more context to make it unique, or use replaceAll. This prevents accidental changes. Preserves indentation exactly as in the original file.',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Absolute path to the file to edit',
            },
            oldString: {
              type: 'string',
              description:
                'Exact text to replace (must match exactly, including indentation). If this appears multiple times in the file, provide more surrounding context to make it unique.',
            },
            newString: {
              type: 'string',
              description:
                'Text to replace it with (must preserve indentation to match surrounding code)',
            },
            replaceAll: {
              type: 'boolean',
              description:
                'Replace all occurrences in the file (useful for renaming variables). Default: false for safety.',
              default: false,
            },
          },
          required: ['filePath', 'oldString', 'newString'],
        },
      },
      {
        name: 'list',
        description:
          'List files and directories in a path with details (size, modified date, permissions).',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absolute path to directory (optional, defaults to cwd)',
            },
            ignore: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of glob patterns to ignore (optional)',
            },
          },
        },
      },
      {
        name: 'search-files',
        description:
          "Search for files by glob pattern (e.g., '**/*.ts', 'src/**/*.json'). Fast file pattern matching.",
        inputSchema: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'Glob pattern to match files',
            },
            path: {
              type: 'string',
              description: 'Directory to search in (optional, defaults to cwd)',
            },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'search-content',
        description:
          'Search file contents using regex. Returns files with matches sorted by modification time.',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'Regex pattern to search for in file contents',
            },
            path: {
              type: 'string',
              description: 'Directory to search in (optional, defaults to cwd)',
            },
            include: {
              type: 'string',
              description: "File pattern to include (e.g., '*.js', '*.{ts,tsx}')",
            },
          },
          required: ['pattern'],
        },
      },
      {
        name: 'delete',
        description: 'Delete a file or directory (recursive). Use with caution.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absolute path to file or directory to delete',
            },
            recursive: {
              type: 'boolean',
              description: 'Delete directory recursively (default: false)',
              default: false,
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'copy',
        description: 'Copy a file to another location',
        inputSchema: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              description: 'Source file path',
            },
            destination: {
              type: 'string',
              description: 'Destination file path',
            },
          },
          required: ['source', 'destination'],
        },
      },
      {
        name: 'move',
        description: 'Move or rename a file/directory',
        inputSchema: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              description: 'Source path',
            },
            destination: {
              type: 'string',
              description: 'Destination path',
            },
          },
          required: ['source', 'destination'],
        },
      },
      {
        name: 'mkdir',
        description: 'Create a directory (with parents if needed)',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Directory path to create',
            },
            recursive: {
              type: 'boolean',
              description: 'Create parent directories if needed (default: true)',
              default: true,
            },
          },
          required: ['path'],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'read': {
        const filePath = args?.filePath as string;
        const offset = (args?.offset as number) || 0;
        const limit = (args?.limit as number) || 2000;

        if (!filePath) throw new Error('filePath is required');
        if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const selectedLines = lines.slice(offset, offset + limit);

        // Track that this file has been read (for write safety)
        filesReadInSession.add(filePath);

        // Format like cat -n (line numbers starting at offset+1)
        const formatted = selectedLines
          .map((line, idx) => `${String(offset + idx + 1).padStart(5, '0')}| ${line}`)
          .join('\n');

        const result = {
          filePath,
          totalLines: lines.length,
          offset,
          limit,
          linesReturned: selectedLines.length,
          content: formatted,
        };

        return {
          content: [{ type: 'text', text: formatted }],
        };
      }

      case 'write': {
        const filePath = args?.filePath as string;
        const content = args?.content as string;

        if (!filePath) throw new Error('filePath is required');
        if (content === undefined) throw new Error('content is required');

        // Safety check: prevent overwriting files that haven't been read (like OpenCode)
        const fileExists = existsSync(filePath);
        if (fileExists && !filesReadInSession.has(filePath)) {
          throw new Error(
            `You must read the file before overwriting it. Use filesystem_read first.\n` +
              `This prevents accidental data loss. ALWAYS prefer editing existing files with filesystem_edit.`,
          );
        }

        // Create directory if it doesn't exist
        const dir = dirname(filePath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }

        writeFileSync(filePath, content, 'utf-8');

        // Track this file as read after writing (for subsequent edits)
        filesReadInSession.add(filePath);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  filePath,
                  bytesWritten: content.length,
                  newFile: !fileExists,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'edit': {
        const filePath = args?.filePath as string;
        const oldString = args?.oldString as string;
        const newString = args?.newString as string;
        const replaceAll = (args?.replaceAll as boolean) || false;

        if (!filePath) throw new Error('filePath is required');
        if (!oldString) throw new Error('oldString is required');
        if (newString === undefined) throw new Error('newString is required');
        if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

        const content = readFileSync(filePath, 'utf-8');

        if (replaceAll) {
          const regex = new RegExp(escapeRegex(oldString), 'g');
          const newContent = content.replace(regex, newString);
          writeFileSync(filePath, newContent, 'utf-8');

          const count = (content.match(regex) || []).length;

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    filePath,
                    replacements: count,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } else {
          // Single replacement - ensure it's unique
          const occurrences = content.split(oldString).length - 1;

          if (occurrences === 0) {
            throw new Error('oldString not found in file');
          }
          if (occurrences > 1) {
            throw new Error(
              `oldString found ${occurrences} times - use replaceAll or provide more context`,
            );
          }

          const newContent = content.replace(oldString, newString);
          writeFileSync(filePath, newContent, 'utf-8');

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    filePath,
                    replacements: 1,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      }

      case 'list': {
        const path = (args?.path as string) || process.env.MCA_CWD || '/workspace';
        const ignore = (args?.ignore as string[]) || [];

        if (!existsSync(path)) throw new Error(`Path not found: ${path}`);

        const items = readdirSync(path).map((name) => {
          const fullPath = join(path, name);
          const stats = statSync(fullPath);

          return {
            name,
            path: fullPath,
            type: stats.isDirectory() ? 'directory' : 'file',
            size: stats.size,
            modified: stats.mtime.toISOString(),
          };
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ path, items }, null, 2),
            },
          ],
        };
      }

      case 'search-files': {
        const pattern = args?.pattern as string;
        const searchPath = (args?.path as string) || process.env.MCA_CWD || '/workspace';

        if (!pattern) throw new Error('pattern is required');

        const files = await glob(pattern, {
          cwd: searchPath,
          absolute: true,
          ignore: ['node_modules/**', '.git/**'],
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  pattern,
                  searchPath,
                  matches: files.length,
                  files: files.slice(0, 100), // Limit to 100 results
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'search-content': {
        const pattern = args?.pattern as string;
        const searchPath = (args?.path as string) || process.env.MCA_CWD || '/workspace';
        const include = args?.include as string | undefined;

        if (!pattern) throw new Error('pattern is required');

        // Check which grep is available
        let grepCmd: string | null = null;
        try {
          await execAsync('which grep');
          grepCmd = 'grep -E';
        } catch {
          // grep not available
        }

        if (!grepCmd) {
          throw new Error('grep is not available on this system. Cannot perform content search.');
        }

        // Build the grep command
        // grep -r for recursive, -l for files-with-matches, -E for extended regex
        let cmd: string;
        if (include) {
          // Use find + grep for file filtering
          cmd = `find "${searchPath}" -type f -name "${include}" ! -path "*/node_modules/*" ! -path "*/.git/*" -exec grep -l -E "${pattern}" {} +`;
        } else {
          cmd = `grep -r -l -E "${pattern}" "${searchPath}" --include="*" 2>/dev/null | grep -v node_modules | grep -v ".git/"`;
        }

        try {
          const { stdout } = await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 });
          const files = stdout
            .trim()
            .split('\n')
            .filter((f) => f);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    pattern,
                    searchPath,
                    include: include || 'all files',
                    matches: files.length,
                    files: files.slice(0, 100),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error: any) {
          // Exit code 1 means no matches found (normal for grep)
          if (error.code === 1 || error.message?.includes('exit code 1')) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      pattern,
                      searchPath,
                      include: include || 'all files',
                      matches: 0,
                      files: [],
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
          // Real error
          throw new Error(`grep search failed: ${error.message}`);
        }
      }

      case 'delete': {
        const path = args?.path as string;
        const recursive = (args?.recursive as boolean) || false;

        if (!path) throw new Error('path is required');
        if (!existsSync(path)) throw new Error(`Path not found: ${path}`);

        const stats = statSync(path);

        if (stats.isDirectory()) {
          if (!recursive) {
            throw new Error('Path is a directory - set recursive: true to delete');
          }
          rmSync(path, { recursive: true, force: true });
        } else {
          unlinkSync(path);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  path,
                  type: stats.isDirectory() ? 'directory' : 'file',
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'copy': {
        const source = args?.source as string;
        const destination = args?.destination as string;

        if (!source) throw new Error('source is required');
        if (!destination) throw new Error('destination is required');
        if (!existsSync(source)) throw new Error(`Source not found: ${source}`);

        // Create destination directory if needed
        const destDir = dirname(destination);
        if (!existsSync(destDir)) {
          mkdirSync(destDir, { recursive: true });
        }

        copyFileSync(source, destination);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  source,
                  destination,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'move': {
        const source = args?.source as string;
        const destination = args?.destination as string;

        if (!source) throw new Error('source is required');
        if (!destination) throw new Error('destination is required');
        if (!existsSync(source)) throw new Error(`Source not found: ${source}`);

        // Create destination directory if needed
        const destDir = dirname(destination);
        if (!existsSync(destDir)) {
          mkdirSync(destDir, { recursive: true });
        }

        renameSync(source, destination);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  source,
                  destination,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'mkdir': {
        const path = args?.path as string;
        const recursive = (args?.recursive as boolean) !== false; // default true

        if (!path) throw new Error('path is required');

        mkdirSync(path, { recursive });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  path,
                  recursive,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: false,
              error: error.message,
              tool: name,
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
});

// Helper function to escape regex special characters
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Teros Filesystem MCA server running');
}

main();
