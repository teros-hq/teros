/**
 * File digest for Netlify's file-based deploy API.
 *
 * Netlify deploys a static site by first declaring a digest of
 * `{ "<deploy-path>": "<sha1-hex>" }` for every file, then uploading only the
 * SHA1s the API reports as missing (`required`). The SHA1 is computed over the
 * raw file bytes; deploy paths use a leading slash + forward slashes and mirror
 * the directory layout (`/index.html`, `/css/app.css`).
 *
 * Content is addressed by SHA1: two files with identical bytes share one SHA1,
 * so a single upload satisfies all of them. `bySha1` keeps one representative
 * file per SHA1 for the upload step.
 */

import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { PathJail } from './path-jail';

/** Hard caps — generous for static sites, but bound memory/abuse. */
export const MAX_FILES = 2000;
export const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB per file
export const MAX_TOTAL_SIZE = 100 * 1024 * 1024; // 100 MB total

/** Per-deploy caps. Injectable so the cap-enforcement paths are unit-testable. */
export interface DeployLimits {
  maxFiles: number;
  maxFileSize: number;
  maxTotalSize: number;
}

export const DEFAULT_LIMITS: DeployLimits = {
  maxFiles: MAX_FILES,
  maxFileSize: MAX_FILE_SIZE,
  maxTotalSize: MAX_TOTAL_SIZE,
};

/**
 * Read a file WITHOUT following a final-component symlink (`O_NOFOLLOW`).
 *
 * Closes a TOCTOU window: the walk validates each entry with `realpathSync`
 * (via `jail.assertInside`) and only collects regular files, but an attacker
 * could swap a just-validated regular file for a symlink before we read it.
 * `O_NOFOLLOW` makes `open` fail with `ELOOP` if the path is now a symlink, so
 * a swapped link can never exfiltrate its target's bytes into a public deploy.
 */
export async function readFileNoFollow(absPath: string): Promise<Buffer> {
  const handle = await open(absPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** Directory/file names that are never part of a static deploy. */
const SKIP_NAMES = new Set(['.git', 'node_modules', '.DS_Store']);

export interface DeployFile {
  /** Absolute path on disk (inside the jail). */
  absPath: string;
  /** Deploy path: leading slash, forward slashes (e.g. "/css/app.css"). */
  deployPath: string;
  /** Lowercase hex SHA1 of the file contents. */
  sha1: string;
  /** Size in bytes. */
  size: number;
}

export interface Digest {
  /** `{ deployPath: sha1 }` — the body of POST /sites/{id}/deploys `files`. */
  files: Record<string, string>;
  /** Every collected file. */
  list: DeployFile[];
  /** sha1 -> first file with that content (content-addressed dedup). */
  bySha1: Map<string, DeployFile>;
  /** Sum of all file sizes. */
  totalSize: number;
}

/** Lowercase hex SHA1 of a buffer. */
export function sha1Hex(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Normalize a path relative to `rootDir` into a Netlify deploy path. */
export function toDeployPath(rootDir: string, absPath: string): string {
  const rel = relative(rootDir, absPath);
  return `/${rel.split(sep).join('/')}`;
}

/**
 * Recursively collect deployable files under `rootDir`, reading each (symlink-safe)
 * to compute its SHA1 and enforcing the size/count caps DURING the walk — we stop
 * as soon as a cap is crossed instead of materialising the whole tree first, so a
 * hostile/huge directory bounds memory and work early.
 *
 * Every entry is jail-checked (`realpathSync` via `assertInside`) so a symlink
 * pointing outside the workspace fails loudly; directories in SKIP_NAMES and
 * non-regular files are dropped.
 *
 * @throws Error `[TOO_MANY_FILES]` / `[TOO_LARGE]` when the caps are exceeded.
 * @throws Error `[PATH_ESCAPE]` when an entry resolves outside the jail.
 */
export async function walkDir(
  rootDir: string,
  jail: PathJail,
  limits: DeployLimits = DEFAULT_LIMITS,
): Promise<DeployFile[]> {
  const out: DeployFile[] = [];
  let totalSize = 0;

  /** Read one regular file, enforce the caps, and append it to `out`. */
  async function collectFile(abs: string): Promise<void> {
    // Count cap BEFORE reading the offending file — don't accumulate the tree.
    if (out.length >= limits.maxFiles) {
      throw new Error(`[TOO_MANY_FILES] deploy exceeds ${limits.maxFiles} files`);
    }
    const bytes = await readFileNoFollow(abs);
    if (bytes.byteLength > limits.maxFileSize) {
      throw new Error(
        `[TOO_LARGE] file exceeds ${limits.maxFileSize} bytes: ${toDeployPath(rootDir, abs)}`,
      );
    }
    totalSize += bytes.byteLength;
    if (totalSize > limits.maxTotalSize) {
      throw new Error(`[TOO_LARGE] total deploy size exceeds ${limits.maxTotalSize} bytes`);
    }
    out.push({
      absPath: abs,
      deployPath: toDeployPath(rootDir, abs),
      sha1: sha1Hex(bytes),
      size: bytes.byteLength,
    });
  }

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      // Fail-closed: realpath the entry and assert it is still inside the jail.
      jail.assertInside(abs);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) await collectFile(abs);
    }
  }

  await walk(rootDir);
  return out;
}

/** Build the full digest (files map + dedup index) for a directory. */
export async function buildDigest(
  rootDir: string,
  jail: PathJail,
  limits: DeployLimits = DEFAULT_LIMITS,
): Promise<Digest> {
  const list = await walkDir(rootDir, jail, limits);
  const files: Record<string, string> = {};
  const bySha1 = new Map<string, DeployFile>();
  let totalSize = 0;

  for (const file of list) {
    files[file.deployPath] = file.sha1;
    if (!bySha1.has(file.sha1)) bySha1.set(file.sha1, file);
    totalSize += file.size;
  }

  return { files, list, bySha1, totalSize };
}
