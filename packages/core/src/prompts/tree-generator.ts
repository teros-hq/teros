/**
 * Project Tree Generator
 *
 * Generates a hierarchical tree view of files in a directory
 * Similar to Alice's Ripgrep.tree() but using Bun's native utilities
 */

import { readdir } from 'fs/promises';
import { join } from 'path';

interface TreeNode {
  path: string[];
  children: TreeNode[];
}

export interface TreeOptions {
  cwd: string;
  limit?: number;
  excludePatterns?: string[];
}

const DEFAULT_EXCLUDE = [
  '.git',
  'node_modules',
  '.bun',
  'dist',
  'build',
  '.opencode',
  '.next',
  '.turbo',
  'coverage',
  '.vscode',
  '.idea',
];

export async function generateProjectTree(options: TreeOptions): Promise<string> {
  const { cwd, limit = 200, excludePatterns = DEFAULT_EXCLUDE } = options;

  // Get all files recursively
  const files = await getAllFiles(cwd, cwd, excludePatterns);

  // Build tree structure
  const root: TreeNode = {
    path: [],
    children: [],
  };

  for (const file of files) {
    const parts = file.split('/');
    getPath(root, parts, true);
  }

  // Sort tree
  sortTree(root);

  // Limit and render tree
  const limitedRoot = limitTree(root, limit);
  return renderTree(limitedRoot);
}

async function getAllFiles(
  basePath: string,
  currentPath: string,
  excludePatterns: string[],
): Promise<string[]> {
  const files: string[] = [];

  try {
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      // Skip excluded patterns
      if (excludePatterns.includes(entry.name)) {
        continue;
      }

      const fullPath = join(currentPath, entry.name);
      const relativePath = fullPath.substring(basePath.length + 1);

      if (entry.isDirectory()) {
        // Recurse into directory
        const subFiles = await getAllFiles(basePath, fullPath, excludePatterns);
        files.push(...subFiles);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  } catch (error) {
    // Ignore permission errors and continue
  }

  return files;
}

function getPath(node: TreeNode, parts: string[], create: boolean): TreeNode | undefined {
  if (parts.length === 0) return node;
  let current = node;
  for (const part of parts) {
    let existing = current.children.find((x) => x.path.at(-1) === part);
    if (!existing) {
      if (!create) return undefined;
      existing = {
        path: current.path.concat(part),
        children: [],
      };
      current.children.push(existing);
    }
    current = existing;
  }
  return current;
}

function sortTree(node: TreeNode) {
  node.children.sort((a, b) => {
    // Directories first
    if (!a.children.length && b.children.length) return 1;
    if (!b.children.length && a.children.length) return -1;
    // Then alphabetically
    return a.path.at(-1)!.localeCompare(b.path.at(-1)!);
  });
  for (const child of node.children) {
    sortTree(child);
  }
}

function limitTree(root: TreeNode, limit: number): TreeNode {
  const result: TreeNode = {
    path: [],
    children: [],
  };

  let current = [root];
  let processed = 0;

  while (current.length > 0 && processed < limit) {
    const next: TreeNode[] = [];
    for (const node of current) {
      if (node.children.length) next.push(...node.children);
    }

    const max = Math.max(...current.map((x) => x.children.length));
    for (let i = 0; i < max && processed < limit; i++) {
      for (const node of current) {
        const child = node.children[i];
        if (!child) continue;
        getPath(result, child.path, true);
        processed++;
        if (processed >= limit) break;
      }
    }

    if (processed >= limit) {
      // Add truncation markers
      for (const node of [...current, ...next]) {
        const compare = getPath(result, node.path, false);
        if (!compare) continue;
        if (compare?.children.length !== node.children.length) {
          const diff = node.children.length - compare.children.length;
          compare.children.push({
            path: compare.path.concat(`[${diff} truncated]`),
            children: [],
          });
        }
      }
      break;
    }
    current = next;
  }

  return result;
}

function renderTree(root: TreeNode): string {
  const lines: string[] = [];

  function render(node: TreeNode, depth: number) {
    const indent = '\t'.repeat(depth);
    lines.push(indent + node.path.at(-1) + (node.children.length ? '/' : ''));
    for (const child of node.children) {
      render(child, depth + 1);
    }
  }

  root.children.map((x: TreeNode) => render(x, 0));
  return lines.join('\n');
}
