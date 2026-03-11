/**
 * Context Retrieval for Memory System
 * 
 * Provides automatic context injection before agent responses
 */

import { searchConversations } from './conversation.js';
import { searchKnowledge } from './knowledge.js';
import { searchTasks } from './tasks.js';
import { logger } from './logger.js';

export interface RelevantContext {
  conversations: Array<{
    userMessage: string;
    assistantResponse: string;
    score: number;
    timestamp: string;
  }>;
  knowledge: Array<{
    fact: string;
    category: string;
    confidence: number;
    score: number;
  }>;
  tasks: Array<{
    description: string;
    outcome: string;
    filesModified: string[];
    commandsRun: string[];
    score: number;
  }>;
}

export interface ContextLimits {
  conversationLimit?: number;
  knowledgeLimit?: number;
  taskLimit?: number;
  minRelevanceScore?: number;
}

const DEFAULT_LIMITS: Required<ContextLimits> = {
  conversationLimit: 1,
  knowledgeLimit: 3,
  taskLimit: 2,
  minRelevanceScore: 0.3,
};

/**
 * Get relevant context for a user query
 * Searches across conversations, knowledge, and tasks
 */
export async function getRelevantContext(
  agentId: string,
  query: string,
  limits: ContextLimits = {}
): Promise<RelevantContext> {
  const config = { ...DEFAULT_LIMITS, ...limits };

  logger.debug(`[Context] Searching for: "${query.substring(0, 50)}..."`);

  // Search in parallel
  const [conversationResults, knowledgeResults, taskResults] = await Promise.all([
    searchConversations(agentId, query, config.conversationLimit),
    searchKnowledge(agentId, query, config.knowledgeLimit, undefined),
    searchTasks(agentId, query, config.taskLimit),
  ]);

  // Filter by minimum relevance score
  const conversations = conversationResults
    .filter((r) => r.score >= config.minRelevanceScore)
    .map((r) => ({
      userMessage: String(r.payload.user_message || ''),
      assistantResponse: String(r.payload.assistant_response || ''),
      score: r.score,
      timestamp: r.payload.timestamp,
    }));

  const knowledge = knowledgeResults
    .filter((r) => r.score >= config.minRelevanceScore)
    .map((r) => ({
      fact: r.payload.fact,
      category: r.payload.category,
      confidence: r.payload.confidence,
      score: r.score,
    }));

  const tasks = taskResults
    .filter((r) => r.score >= config.minRelevanceScore)
    .map((r) => ({
      description: r.payload.description,
      outcome: r.payload.outcome,
      filesModified: (r.payload.files_modified as string[]) || [],
      commandsRun: (r.payload.commands_run as string[]) || [],
      score: r.score,
    }));

  // Log relevance scores
  if (conversations.length > 0) {
    const scores = conversations.map((c) => c.score.toFixed(2)).join(', ');
    logger.debug(`  💬 Conversations (${conversations.length}): ${scores}`);
  }
  if (knowledge.length > 0) {
    const scores = knowledge.map((k) => k.score.toFixed(2)).join(', ');
    logger.debug(`  📚 Knowledge (${knowledge.length}): ${scores}`);
  }
  if (tasks.length > 0) {
    const scores = tasks.map((t) => t.score.toFixed(2)).join(', ');
    logger.debug(`  ✅ Tasks (${tasks.length}): ${scores}`);
  }

  // Calculate average relevance
  const allScores = [
    ...conversations.map((c) => c.score),
    ...knowledge.map((k) => k.score),
    ...tasks.map((t) => t.score),
  ];
  const avgScore = allScores.length > 0 ? allScores.reduce((a, b) => a + b, 0) / allScores.length : 0;
  logger.debug(`  📊 Average relevance: ${avgScore.toFixed(2)}`);

  if (avgScore < config.minRelevanceScore) {
    logger.debug('  ⚠️ Low relevance context, filtering out');
  }

  return { conversations, knowledge, tasks };
}

/**
 * Format context for injection into LLM prompt
 */
export function formatContextForPrompt(context: RelevantContext): string {
  const sections: string[] = [];

  // Add conversations
  if (context.conversations.length > 0) {
    sections.push('## 💬 Relevant Past Conversations\n');
    context.conversations.forEach((conv, i) => {
      sections.push(`### Conversation ${i + 1} (relevance: ${(conv.score * 100).toFixed(0)}%)`);
      sections.push(`**User:** ${conv.userMessage}`);
      sections.push(`**Assistant:** ${conv.assistantResponse}`);
      sections.push(''); // Empty line
    });
  }

  // Add knowledge
  if (context.knowledge.length > 0) {
    sections.push('## 📚 Relevant Knowledge\n');
    context.knowledge.forEach((k, i) => {
      sections.push(
        `${i + 1}. [${k.category}] ${k.fact} (confidence: ${(k.confidence * 100).toFixed(0)}%, relevance: ${(k.score * 100).toFixed(0)}%)`
      );
    });
    sections.push(''); // Empty line
  }

  // Add tasks
  if (context.tasks.length > 0) {
    sections.push('## ✅ Relevant Past Tasks\n');
    context.tasks.forEach((task, i) => {
      sections.push(`### Task ${i + 1} (${task.outcome})`);
      sections.push(`**Description:** ${task.description}`);
      if (task.filesModified.length > 0) {
        sections.push(`**Files:** ${task.filesModified.join(', ')}`);
      }
      if (task.commandsRun.length > 0) {
        sections.push(`**Commands:** ${task.commandsRun.join(', ')}`);
      }
      sections.push(''); // Empty line
    });
  }

  if (sections.length === 0) {
    return '';
  }

  // Wrap in context block
  const formatted = [
    '---',
    '# 🧠 MEMORY CONTEXT',
    '',
    'The following information was automatically retrieved from your memory based on the current query:',
    '',
    ...sections,
    '---',
    '',
  ].join('\n');

  logger.debug(`  📏 Context length: ${formatted.length} chars`);

  return formatted;
}
