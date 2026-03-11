/**
 * Memory Context Builder
 *
 * Builds context from memory service for inclusion in system prompt
 * Provides relevant past conversations and knowledge
 */

// Disabled: Qdrant not used in teros-v2
// import type { QdrantMemoryService } from '../memory/QdrantMemoryService'
type QdrantMemoryService = any; // Stub type

export interface MemoryContextOptions {
  userId: string;
  currentMessage?: string;
  limit?: number;
  includeStats?: boolean;
}

/**
 * Build memory context section for system prompt
 *
 * This adds relevant past conversations and knowledge to help the agent
 * maintain context across sessions.
 */
export async function buildMemoryContext(
  memoryService: QdrantMemoryService | undefined,
  options: MemoryContextOptions,
): Promise<string | null> {
  if (!memoryService) return null;

  try {
    const sections: string[] = [];

    // Add memory statistics if requested
    if (options.includeStats) {
      const stats = await memoryService.getUserStats(options.userId);
      sections.push(buildStatsSection(stats));
    }

    // TODO: Add relevant past conversations search
    // This would require implementing search in QdrantMemoryService
    // For now, we'll just include stats

    if (sections.length === 0) return null;

    return ['# Memory Context', '', ...sections].join('\n');
  } catch (error) {
    console.warn('Failed to build memory context:', error);
    return null;
  }
}

function buildStatsSection(stats: any): string {
  const lines: string[] = [];

  lines.push('## Recent Activity');

  if (stats.conversations) {
    lines.push(`- Conversations: ${stats.conversations.total} total`);
    if (stats.conversations.last24h > 0) {
      lines.push(`  - Last 24h: ${stats.conversations.last24h}`);
    }
    if (stats.conversations.last7days > 0) {
      lines.push(`  - Last 7 days: ${stats.conversations.last7days}`);
    }
  }

  if (stats.knowledge && stats.knowledge.total > 0) {
    lines.push(`- Knowledge items: ${stats.knowledge.total}`);
    if (stats.knowledge.categories) {
      lines.push(`  - Categories: ${Object.keys(stats.knowledge.categories).length}`);
    }
  }

  if (stats.tasks && stats.tasks.total > 0) {
    lines.push(`- Tasks: ${stats.tasks.total}`);
    if (stats.tasks.pending > 0) {
      lines.push(`  - Pending: ${stats.tasks.pending}`);
    }
  }

  return lines.join('\n');
}
