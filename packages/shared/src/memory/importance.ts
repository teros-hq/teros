/**
 * Importance Scoring System
 * 
 * Calculates importance scores (0.0 - 1.0) for conversations to determine:
 * - Which conversations to prioritize in context retrieval
 * - Which conversations to keep long-term vs delete
 * - Quality of stored memories
 */

export interface ImportanceFactors {
  userMessage: string;
  assistantResponse: string;
  filesModified?: string[];
  commandsRun?: string[];
}

/**
 * Calculate importance score for a conversation
 * 
 * Score ranges:
 * - 0.0 - 0.3: Low importance (trivial conversations, will be cleaned up quickly)
 * - 0.3 - 0.7: Medium importance (normal conversations, kept for 90 days)
 * - 0.7 - 1.0: High importance (valuable conversations, kept indefinitely)
 * 
 * @param factors - Conversation factors to calculate importance
 * @returns Importance score between 0.1 and 1.0
 */
export function calculateImportance(factors: ImportanceFactors): number {
  const {
    userMessage,
    filesModified = [],
    commandsRun = [],
  } = factors;

  let score = 0.3; // Base score for any conversation

  // +0.3 if files were modified (concrete action taken)
  if (filesModified.length > 0) {
    score += 0.3;
  }

  // +0.2 if commands were executed (action performed)
  if (commandsRun.length > 0) {
    score += 0.2;
  }

  // +0.2 if message is long (substantial conversation)
  if (userMessage.length > 200) {
    score += 0.2;
  }

  // +0.2 if contains critical keywords
  const criticalKeywords = [
    'important',
    'critical',
    'urgent',
    'error',
    'bug',
    'fix',
    'production',
    'deploy',
  ];

  const messageLower = userMessage.toLowerCase();
  if (criticalKeywords.some((keyword) => messageLower.includes(keyword))) {
    score += 0.2;
  }

  // -0.3 if it's a trivial message
  const trivialMessages = [
    'ping',
    'hola',
    'hi',
    'hey',
    'ok',
    'vale',
    'gracias',
    'thanks',
    'test',
    'prueba',
  ];

  const trimmedMessage = messageLower.trim();
  if (trivialMessages.includes(trimmedMessage)) {
    score -= 0.3;
  }

  // Ensure score is between 0.1 and 1.0
  return Math.max(0.1, Math.min(1.0, score));
}

/**
 * Categorize importance score into human-readable levels
 */
export function getImportanceLevel(score: number): 'low' | 'medium' | 'high' {
  if (score < 0.3) return 'low';
  if (score < 0.7) return 'medium';
  return 'high';
}

/**
 * Get recommended retention time in days based on importance
 */
export function getRetentionDays(score: number): number | null {
  if (score < 0.3) return 30; // Low importance: 30 days
  if (score < 0.7) return 90; // Medium importance: 90 days
  return null; // High importance: keep indefinitely
}

/**
 * Check if a conversation should be cleaned up based on age and importance
 */
export function shouldCleanup(
  importance: number,
  ageInDays: number
): boolean {
  const retentionDays = getRetentionDays(importance);
  if (retentionDays === null) return false; // Keep indefinitely
  return ageInDays > retentionDays;
}
