/**
 * Consolidate multiple chunk results into a single markdown document
 */

export interface ChunkResult {
  chunkIndex: number;
  startPage: number;
  endPage: number;
  markdown: string;
  tokensUsed: { input: number; output: number };
}

/**
 * Merge markdown results from multiple chunks
 * Adds page separators and handles section continuations
 */
export function consolidateChunks(chunks: ChunkResult[]): string {
  if (chunks.length === 0) return '';
  if (chunks.length === 1) return chunks[0].markdown;

  // Sort chunks by page order (just in case)
  const sortedChunks = [...chunks].sort((a, b) => a.startPage - b.startPage);

  let consolidated = '';

  sortedChunks.forEach((chunk, index) => {
    // Add chunk separator (except for first chunk)
    if (index > 0) {
      consolidated += '\n\n---\n\n';
      consolidated += `<!-- Pages ${chunk.startPage}-${chunk.endPage} -->\n\n`;
    } else {
      consolidated += `<!-- Pages ${chunk.startPage}-${chunk.endPage} -->\n\n`;
    }

    // Add chunk content
    consolidated += chunk.markdown.trim();
  });

  return consolidated;
}

/**
 * Calculate total token usage across chunks
 */
export function calculateTotalTokens(chunks: ChunkResult[]): { input: number; output: number } {
  return chunks.reduce(
    (acc, chunk) => ({
      input: acc.input + chunk.tokensUsed.input,
      output: acc.output + chunk.tokensUsed.output,
    }),
    { input: 0, output: 0 },
  );
}
