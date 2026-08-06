import { applyPatch, createPatch, parsePatch } from 'diff';

export function buildInlineDiff(
  filePath: string,
  before: string,
  after: string,
  contextLines = 3,
): string {
  return createPatch(filePath, before, after, undefined, undefined, { context: contextLines });
}

export interface ApplyPatchResult {
  success: boolean;
  content?: string;
  hunksApplied: number;
  hunksFailed: number;
  error?: string;
}

export function tryApplyPatch(
  source: string,
  unifiedDiff: string,
  fuzzFactor = 2,
): ApplyPatchResult {
  let parsed;
  try {
    parsed = parsePatch(unifiedDiff);
  } catch (err) {
    return {
      success: false,
      hunksApplied: 0,
      hunksFailed: 0,
      error: err instanceof Error ? err.message : 'Unable to parse unified diff',
    };
  }

  let totalHunks = 0;
  for (const p of parsed) totalHunks += p.hunks.length;

  const applied = applyPatch(source, unifiedDiff, { fuzzFactor });
  if (applied === false) {
    return {
      success: false,
      hunksApplied: 0,
      hunksFailed: totalHunks,
      error: `All ${totalHunks} hunks failed to apply (fuzzFactor=${fuzzFactor})`,
    };
  }
  return { success: true, content: applied, hunksApplied: totalHunks, hunksFailed: 0 };
}
