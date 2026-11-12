import type { ToolConfig } from '@teros/mca-sdk';
import { buildIgnoreFilter } from '../lib/ignore';
import { LIMITS } from '../lib/limits';
import { defaultRootPath, getFsRole, getDefaultGuard, toUserPath } from '../lib/path-safety';
import { wrap } from '../lib/structured';

interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  mtime?: string;
  children?: TreeNode[];
}

export const treeView: ToolConfig = {
  description:
    'Return a hierarchical JSON tree of a directory up to `depth` levels. Files have size and mtime; directories have children. Honors `ignore` patterns and `respectGitignore`. Capped by maxNodes to prevent runaway output. Use `list-files` for flat pagination or `find-files` for pattern match.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Root directory (default: `/workspace`, the volume root)' },
      depth: {
        type: 'number',
        description: `Max depth to descend (default 3, max ${LIMITS.MAX_TREE_DEPTH})`,
      },
      ignore: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extra ignore patterns (gitignore syntax)',
      },
      respectGitignore: { type: 'boolean' },
      maxNodes: {
        type: 'number',
        description: 'Hard cap on total nodes (default 500)',
      },
    },
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true },
  handler: async (args, ctx) => {
    const guard = getDefaultGuard();
    const rawPath = (args.path as string | undefined) ?? defaultRootPath();
    const dirPath = guard.resolve(rawPath);

    const statResult = await ctx.volume.stat(dirPath);
    if (!statResult) {
      throw new Error(`Path not found: ${rawPath}`);
    }
    if (!statResult.isDirectory) {
      throw new Error(`Path is not a directory: ${rawPath}`);
    }

    const depth = Math.min(
      typeof args.depth === 'number' ? Math.max(0, args.depth) : 3,
      LIMITS.MAX_TREE_DEPTH,
    );
    const maxNodes = typeof args.maxNodes === 'number' ? Math.max(1, args.maxNodes) : 500;

    // Read .gitignore if respectGitignore is requested
    let gitignoreContent: string | undefined;
    if (Boolean(args.respectGitignore)) {
      const giData = await ctx.volume.read('/.gitignore');
      if (giData) {
        gitignoreContent = Buffer.from(giData, 'base64').toString('utf-8');
      }
    }

    const filter = buildIgnoreFilter({
      userPatterns: Array.isArray(args.ignore) ? (args.ignore as string[]) : undefined,
      respectGitignore: Boolean(args.respectGitignore),
      gitignoreContent,
    });

    let nodeCount = 0;
    let truncated = false;

    async function build(dir: string, currentDepth: number): Promise<TreeNode[]> {
      if (currentDepth > depth) return [];
      const children: TreeNode[] = [];
      let entries;
      try {
        entries = await ctx.volume.list(dir);
      } catch {
        return [];
      }
      entries.sort((a, b) => {
        const aDir = a.type === 'directory';
        const bDir = b.type === 'directory';
        if (aDir !== bDir) return aDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      for (const entry of entries) {
        if (nodeCount >= maxNodes) {
          truncated = true;
          break;
        }
        const fullPath = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;
        const rel = fullPath.slice(1);
        if (filter.ignores(rel)) continue;
        if (entry.type === 'directory') {
          nodeCount++;
          children.push({
            name: entry.name,
            path: toUserPath(fullPath),
            type: 'directory',
            children: await build(fullPath, currentDepth + 1),
          });
        } else {
          nodeCount++;
          children.push({
            name: entry.name,
            path: toUserPath(fullPath),
            type: 'file',
            size: entry.size ?? 0,
          });
        }
      }
      return children;
    }

    const rootName = dirPath === '/' ? (getFsRole() === 'admin' ? '/' : 'workspace') : dirPath.split('/').pop() || dirPath;
    const root: TreeNode = {
      name: rootName,
      path: toUserPath(dirPath),
      type: 'directory',
      children: await build(dirPath, 1),
    };

    return wrap({
      root: toUserPath(dirPath),
      depth,
      totalNodes: nodeCount,
      truncated,
      tree: root,
    });
  },
};
