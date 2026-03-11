import { saveConversation, saveKnowledge, saveTask } from './index.js';
import type { ConversationMemory } from './types.js';
import { logger } from './logger.js';

export interface ProcessingResult {
  conversation_saved: boolean;
  knowledge_extracted: number;
  tasks_extracted: number;
  processing_time_ms: number;
}

export interface KnowledgeItem {
  fact: string;
  confidence: number;
}

export interface ProcessConversationOptions {
  agentId: string;        // Required: which agent owns this memory
  context?: string;
  sessionId?: string;
  userId?: string;
  channelId?: string;
}

/**
 * Process a conversation and extract knowledge/tasks
 * Each agent has isolated memory collections
 */
export async function processConversation(
  userMessage: string,
  assistantResponse: string,
  options: ProcessConversationOptions
): Promise<ProcessingResult> {
  const { agentId, context, sessionId, userId, channelId } = options;
  
  if (!agentId) {
    throw new Error('agentId is required for processConversation');
  }

  const startTime = Date.now();
  const result: ProcessingResult = {
    conversation_saved: false,
    knowledge_extracted: 0,
    tasks_extracted: 0,
    processing_time_ms: 0,
  };

  try {
    const importance = calculateImportance(userMessage, assistantResponse);
    const conversationId = await saveConversation(userMessage, assistantResponse, {
      agentId,
      importance,
      userId,
      sessionId,
      channelId,
      deduplicationThreshold: 0.95,
      deduplicationWindowHours: 24,
    });
    
    if (conversationId === null) {
      logger.debug(`⏭️ [${agentId}] Conversation skipped due to deduplication`);
      result.conversation_saved = false;
      result.processing_time_ms = Date.now() - startTime;
      return result;
    }
    
    result.conversation_saved = true;

    if (importance >= 0.6) {
      const combined = `${userMessage}\n${assistantResponse}`;
      const conversationData: ConversationMemory = {
        id: conversationId,
        timestamp: new Date().toISOString(),
        user_message: userMessage,
        assistant_response: assistantResponse,
        importance,
        agentId,
        userId,
        sessionId,
        channelId,
      };

      const knowledgePromises: Promise<string>[] = [];

      const preferences = detectPreferences(combined);
      for (const pref of preferences) {
        knowledgePromises.push(
          saveKnowledge(agentId, pref.fact, `conversation:${conversationId}`, 'user_preferences', { confidence: pref.confidence, userId })
        );
      }

      const projectData = detectProjectData(combined);
      for (const data of projectData) {
        knowledgePromises.push(
          saveKnowledge(agentId, data.fact, `conversation:${conversationId}`, 'project_data', { confidence: data.confidence, userId })
        );
      }

      const commands = extractCommands(combined);
      for (const cmd of commands) {
        knowledgePromises.push(
          saveKnowledge(agentId, cmd.fact, `conversation:${conversationId}`, 'commands', { confidence: cmd.confidence, userId })
        );
      }

      const workflows = detectWorkflows(combined);
      for (const wf of workflows) {
        knowledgePromises.push(
          saveKnowledge(agentId, wf.fact, `conversation:${conversationId}`, 'workflows', { confidence: wf.confidence, userId })
        );
      }

      await Promise.all(knowledgePromises);
      result.knowledge_extracted = knowledgePromises.length;

      const taskExtracted = await extractTaskIfNeeded(agentId, conversationData, userId);
      if (taskExtracted) {
        result.tasks_extracted = 1;
      }
    }
    
    result.processing_time_ms = Date.now() - startTime;
    return result;
  } catch (error) {
    logger.error({ err: error, msg: `[${agentId}] Error processing conversation` });
    throw error;
  }
}

export function calculateImportance(userMsg: string, assistantMsg: string): number {
  let score = 0.5;

  if (userMsg.length + assistantMsg.length > 200) score += 0.2;

  if (assistantMsg.includes('```')) score += 0.3;

  if (assistantMsg.match(/git|npm|bun|docker|yarn|cd|mkdir|cp|mv/i)) score += 0.2;

  if (userMsg.match(/^(hi|hello|thanks|bye|ok|got it|understood)$/i)) score -= 0.2;

  if (assistantMsg.includes('✅') || assistantMsg.includes('completed')) score += 0.1;

  if (userMsg.match(/how|what|why|explain|help/i)) score += 0.1;

  return Math.max(0.1, Math.min(1.0, score));
}

export function detectPreferences(text: string): KnowledgeItem[] {
  const patterns = [
    { regex: /prefer[s]?\s+(?:to use\s+)?(\w+)/gi, template: 'Prefers using $1', confidence: 0.9 },
    { regex: /(?:i\s+)?like[s]?\s+([\w\s]+?)(?:\.|,|$)/gi, template: 'Likes $1', confidence: 0.8 },
    { regex: /(?:i\s+)?(?:don't|do not)\s+like\s+([\w\s]+?)(?:\.|,|$)/gi, template: 'Dislikes $1', confidence: 0.9 },
    { regex: /always\s+use[s]?\s+([\w\s]+?)(?:\.|,|$)/gi, template: 'Always uses $1', confidence: 0.9 },
    { regex: /(?:my\s+)?favorite\s+(\w+)\s+is\s+([\w\s]+?)(?:\.|,|$)/gi, template: 'Favorite $1: $2', confidence: 0.9 },
  ];

  const results: KnowledgeItem[] = [];
  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern.regex)];
    for (const match of matches) {
      let fact = pattern.template;
      for (let i = 1; i < match.length; i++) {
        fact = fact.replace(`$${i}`, match[i].trim());
      }
      results.push({ fact, confidence: pattern.confidence });
    }
  }

  return results;
}

export function detectProjectData(text: string): KnowledgeItem[] {
  const patterns = [
    { regex: /(?:the\s+)?project\s+([\w-]+)\s+uses?\s+([\w\s]+?)(?:\.|,|$)/gi, template: 'Project $1 uses $2', confidence: 0.9 },
    { regex: /(?:we are|we're)\s+using\s+([\w\s]+?)(?:\.|,|$)/gi, template: 'Project uses $1', confidence: 0.8 },
    { regex: /database\s+([\w\s]+?)(?:\.|,|$)/gi, template: 'Database: $1', confidence: 0.9 },
    { regex: /runtime(?:\s+is)?\s+([\w\s]+?)(?:\.|,|$)/gi, template: 'Runtime: $1', confidence: 0.9 },
    { regex: /framework\s+([\w\s]+?)(?:\.|,|$)/gi, template: 'Framework: $1', confidence: 0.9 },
  ];

  const results: KnowledgeItem[] = [];
  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern.regex)];
    for (const match of matches) {
      let fact = pattern.template;
      for (let i = 1; i < match.length; i++) {
        fact = fact.replace(`$${i}`, match[i].trim());
      }
      results.push({ fact, confidence: pattern.confidence });
    }
  }

  return results;
}

export function extractCommands(text: string): KnowledgeItem[] {
  const results: KnowledgeItem[] = [];

  const codeBlocks = text.match(/```(?:bash|sh)?\n([\s\S]*?)```/g) || [];

  for (const block of codeBlocks) {
    const commands = block
      .replace(/```(?:bash|sh)?\n/, '')
      .replace(/```/, '')
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('#'));

    for (const cmd of commands) {
      const trimmed = cmd.trim();
      if (trimmed.length > 5 && trimmed.length < 200) {
        results.push({
          fact: `Useful command: ${trimmed}`,
          confidence: 0.8,
        });
      }
    }
  }

  return results;
}

export function detectWorkflows(text: string): KnowledgeItem[] {
  const patterns = [
    {
      regex: /before\s+(commit|push|deploy|merge)\s+(?:I should|you should|always)\s+([\w\s]+?)(?:\.|,|to|$)/gi,
      template: 'Before $1: $2',
      confidence: 0.9,
    },
    { regex: /workflow:\s*(.+?)(?:\.|,|$)/gi, template: 'Workflow: $1', confidence: 0.9 },
    { regex: /process:\s*(.+?)(?:\.|,|$)/gi, template: 'Process: $1', confidence: 0.8 },
    {
      regex: /steps?\s+(?:to|for)\s+([\w\s]+?):\s*(.+?)(?:\.|$)/gi,
      template: 'Steps for $1: $2',
      confidence: 0.8,
    },
  ];

  const results: KnowledgeItem[] = [];
  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern.regex)];
    for (const match of matches) {
      let fact = pattern.template;
      for (let i = 1; i < match.length; i++) {
        fact = fact.replace(`$${i}`, match[i].trim());
      }
      if (fact.length < 500) {
        results.push({ fact, confidence: pattern.confidence });
      }
    }
  }

  return results;
}

async function extractTaskIfNeeded(
  agentId: string,
  conversation: ConversationMemory,
  userId?: string
): Promise<boolean> {
  const response = conversation.assistant_response;

  const actionIndicators = [
    'created',
    'modified',
    'added',
    'completed',
    'implemented',
    '✅',
    'deployed',
    'updated',
    'configured',
  ];

  if (!actionIndicators.some((ind) => response.toLowerCase().includes(ind))) {
    return false;
  }

  const filesModified = extractFiles(response);
  const commandsRun = extractCommandsFromResponse(response);

  const outcome = determineOutcome(response);

  if (filesModified.length > 0 || commandsRun.length > 0) {
    await saveTask(agentId, conversation.user_message, filesModified, commandsRun, outcome, {
      lessonsLearned: extractLessons(response),
      userId,
    });
    return true;
  }

  return false;
}

function extractFiles(text: string): string[] {
  const patterns = [
    /(?:created|modified|edited|updated)\s+(?:file\s+)?([^\s,]+\.(?:ts|js|json|md|yml|yaml|toml|conf|html|css|tsx|jsx))/gi,
    /file\s+([^\s,]+\.(?:ts|js|json|md|yml|yaml|toml|conf|html|css|tsx|jsx))/gi,
    /`([^\s,`]+\.(?:ts|js|json|md|yml|yaml|toml|conf|html|css|tsx|jsx))`/gi,
    /(?:en|file)\s+([/\w-]+\.(?:ts|js|json|md|yml|yaml|toml|conf|html|css|tsx|jsx))/gi,
  ];

  const files = new Set<string>();
  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches) {
      files.add(match[1]);
    }
  }

  return Array.from(files).slice(0, 20);
}

function extractCommandsFromResponse(text: string): string[] {
  const commands = new Set<string>();

  const codeBlocks = text.match(/```(?:bash|sh)?\n([\s\S]*?)```/g) || [];

  for (const block of codeBlocks) {
    const lines = block
      .replace(/```(?:bash|sh)?\n/, '')
      .replace(/```/, '')
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('#'));

    lines.forEach((cmd) => {
      const trimmed = cmd.trim();
      if (trimmed.length > 0 && trimmed.length < 200) {
        commands.add(trimmed);
      }
    });
  }

  return Array.from(commands).slice(0, 10);
}

function determineOutcome(text: string): 'success' | 'failure' | 'partial' {
  const successIndicators = ['✅', 'completed', 'successfully', 'working', 'deployed', 'success'];
  const failureIndicators = ['❌', 'error', 'failed', 'not working', 'problem', 'issue'];

  const hasSuccess = successIndicators.some((ind) => text.toLowerCase().includes(ind));
  const hasFailure = failureIndicators.some((ind) => text.toLowerCase().includes(ind));

  if (hasSuccess && !hasFailure) return 'success';
  if (hasFailure && !hasSuccess) return 'failure';
  if (hasSuccess && hasFailure) return 'partial';

  return 'success';
}

function extractLessons(text: string): string | undefined {
  const patterns = [
    /(?:learned that|lesson:|important:|note:)\s*(.+?)(?:\.|$)/gi,
    /(?:keep in mind|remember|important)\s+that\s+(.+?)(?:\.|$)/gi,
    /(?:lesson learned|takeaway):\s*(.+?)(?:\.|$)/gi,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const lesson = match[1].trim();
      if (lesson.length > 10 && lesson.length < 500) {
        return lesson;
      }
    }
  }

  return undefined;
}
