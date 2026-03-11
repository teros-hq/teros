/**
 * Prompt Module
 *
 * Exports utilities to build prompts optimized for caching:
 * - PromptBuilder: Builds structured prompts with cache breakpoints
 * - SystemPromptBuilder: Legacy system prompt builder
 * - PromptAnalyzer: Analyzes token usage breakdown
 */

export {
  type PromptAnalysis,
  PromptAnalyzer,
  type PromptComponents as AnalyzerPromptComponents,
  promptAnalyzer,
  type TokenBreakdown as AnalyzerTokenBreakdown,
} from './PromptAnalyzer';
export {
  type BuiltPrompt,
  buildPrompt,
  PromptBuilder,
  type PromptBuilderConfig,
  type PromptComponents,
  totalFromBreakdown,
} from './PromptBuilder';
export { type AgentConfig, type EnvironmentInfo, SystemPromptBuilder } from './SystemPromptBuilder';

import { type AgentConfig, type EnvironmentInfo, SystemPromptBuilder } from './SystemPromptBuilder';

/**
 * Build system prompt from agent config and environment
 *
 * This is the main entry point for generating system prompts.
 */
export async function buildSystemPrompt(
  agentConfig: AgentConfig,
  env: EnvironmentInfo,
  basePromptPath?: string,
): Promise<string> {
  const builder = new SystemPromptBuilder(basePromptPath);
  return builder.build(agentConfig, env);
}
