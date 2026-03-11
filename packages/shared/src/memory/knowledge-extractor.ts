/**
 * Knowledge Extractor
 * 
 * Automatically extracts knowledge from conversations
 * Runs after saving important conversations (importance >= 0.6)
 */

import { saveKnowledge } from './knowledge.js';
import { logger } from './logger.js';

export interface ExtractedKnowledge {
  fact: string;
  category: string;
  confidence: number;
}

export interface ExtractionResult {
  extracted: ExtractedKnowledge[];
  count: number;
}

/**
 * Extract knowledge from a conversation
 */
export async function extractKnowledgeFromConversation(
  agentId: string,
  userMessage: string,
  assistantResponse: string,
  context?: {
    userId?: string;
    channelId?: string;
  }
): Promise<ExtractionResult> {
  const extracted: ExtractedKnowledge[] = [];
  const combined = `${userMessage}\n${assistantResponse}`;

  // 1. Detect user preferences
  const preferences = detectPreferences(combined);
  for (const pref of preferences) {
    const id = await saveKnowledge(agentId, pref.fact, 'auto-extract', pref.category, {
      userId: context?.userId,
      confidence: pref.confidence,
    });
    extracted.push(pref);
    logger.debug(`[KnowledgeExtractor] Saved preference: ${pref.fact.substring(0, 50)}...`);
  }

  // 2. Detect project data
  const projectData = detectProjectData(combined);
  for (const data of projectData) {
    const id = await saveKnowledge(agentId, data.fact, 'auto-extract', data.category, {
      userId: context?.userId,
      confidence: data.confidence,
    });
    extracted.push(data);
    logger.debug(`[KnowledgeExtractor] Saved project data: ${data.fact.substring(0, 50)}...`);
  }

  // 3. Detect useful commands
  const commands = extractCommands(combined);
  for (const cmd of commands) {
    const id = await saveKnowledge(agentId, cmd.fact, 'auto-extract', cmd.category, {
      userId: context?.userId,
      confidence: cmd.confidence,
    });
    extracted.push(cmd);
    logger.debug(`[KnowledgeExtractor] Saved command: ${cmd.fact.substring(0, 50)}...`);
  }

  // 4. Detect workflows
  const workflows = detectWorkflows(combined);
  for (const wf of workflows) {
    const id = await saveKnowledge(agentId, wf.fact, 'auto-extract', wf.category, {
      userId: context?.userId,
      confidence: wf.confidence,
    });
    extracted.push(wf);
    logger.debug(`[KnowledgeExtractor] Saved workflow: ${wf.fact.substring(0, 50)}...`);
  }

  return {
    extracted,
    count: extracted.length,
  };
}

/**
 * Detect user preferences
 */
function detectPreferences(text: string): ExtractedKnowledge[] {
  const preferences: ExtractedKnowledge[] = [];
  const lowerText = text.toLowerCase();

  // Pattern: "prefiero X", "me gusta X", "I prefer X"
  const preferencePatterns = [
    /(?:prefiero|me gusta|i prefer|i like)\s+([^.\n]+)/gi,
    /(?:my preference is|mi preferencia es)\s+([^.\n]+)/gi,
  ];

  for (const pattern of preferencePatterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      if (match[1] && match[1].length > 5) {
        preferences.push({
          fact: `User preference: ${match[1].trim()}`,
          category: 'user_preferences',
          confidence: 0.7,
        });
      }
    }
  }

  return preferences;
}

/**
 * Detect project data (paths, configurations, etc.)
 */
function detectProjectData(text: string): ExtractedKnowledge[] {
  const projectData: ExtractedKnowledge[] = [];

  // Pattern: file paths
  const pathPattern = /(?:project|code|located|path).*?(\/[a-zA-Z0-9/_.-]+)/gi;
  const matches = text.matchAll(pathPattern);
  for (const match of matches) {
    if (match[1] && match[1].length > 5) {
      projectData.push({
        fact: `Project path: ${match[1]}`,
        category: 'project_data',
        confidence: 0.8,
      });
    }
  }

  // Pattern: configuration values
  const configPattern = /(?:puerto|port|url|endpoint).*?(?:es|is)\s+([a-zA-Z0-9:/.@-]+)/gi;
  const configMatches = text.matchAll(configPattern);
  for (const match of configMatches) {
    if (match[1] && match[1].length > 3) {
      projectData.push({
        fact: `Configuration: ${match[0].trim()}`,
        category: 'project_data',
        confidence: 0.6,
      });
    }
  }

  return projectData;
}

/**
 * Extract useful commands
 */
function extractCommands(text: string): ExtractedKnowledge[] {
  const commands: ExtractedKnowledge[] = [];

  // Pattern: code blocks with shell commands
  const codeBlockPattern = /```(?:bash|sh|shell)?\n([\s\S]+?)```/g;
  const matches = text.matchAll(codeBlockPattern);
  
  for (const match of matches) {
    const code = match[1].trim();
    // Filter out very short or very long commands
    if (code.length > 10 && code.length < 200) {
      // Check if it looks like a useful command (contains common CLI tools)
      if (/(?:git|docker|npm|yarn|bun|pm2|curl|wget|ssh|rsync|cd|mkdir|cp|mv|rm)/i.test(code)) {
        commands.push({
          fact: `Useful command: ${code}`,
          category: 'commands',
          confidence: 0.8,
        });
      }
    }
  }

  // Pattern: inline commands
  const inlinePattern = /(?:ejecuta|run|usa|use|comando|command):\s*`([^`]+)`/gi;
  const inlineMatches = text.matchAll(inlinePattern);
  for (const match of inlineMatches) {
    if (match[1] && match[1].length > 5) {
      commands.push({
        fact: `Command: ${match[1]}`,
        category: 'commands',
        confidence: 0.7,
      });
    }
  }

  return commands;
}

/**
 * Detect workflows (multi-step processes)
 */
function detectWorkflows(text: string): ExtractedKnowledge[] {
  const workflows: ExtractedKnowledge[] = [];

  // Pattern: numbered lists (workflows often appear as steps)
  const numberedListPattern = /(?:pasos|steps|proceso|process|workflow)[\s\S]*?((?:\d+\.\s+[^\n]+\n?)+)/gi;
  const matches = text.matchAll(numberedListPattern);
  
  for (const match of matches) {
    if (match[1] && match[1].split('\n').length >= 2) {
      workflows.push({
        fact: `Workflow: ${match[0].trim()}`,
        category: 'workflows',
        confidence: 0.8,
      });
    }
  }

  return workflows;
}
