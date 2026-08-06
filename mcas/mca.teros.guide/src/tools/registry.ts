import type { ToolConfig } from '@teros/mca-sdk';
import { getGuideSection } from './get-section';
import { healthCheck } from './health-check';
import { listGuideTopics } from './list-topics';
import { searchGuide } from './search-guide';

/**
 * Single source of truth for the tool surface. Consumed by both `index.ts`
 * (server registration) and the registry-sync test (tools.json ↔ TOOLS). The
 * agent reads `tools.json`, NOT this TS — the test guarantees they never drift
 * (MCA-RUNBOOK criterion 3).
 */
export interface RegisteredTool {
  name: string;
  description: string;
  // biome-ignore lint/suspicious/noExplicitAny: JSON Schema shape varies per tool
  inputSchema: ToolConfig<any, any>['parameters'];
  // biome-ignore lint/suspicious/noExplicitAny: each tool has its own arg/result types
  config: ToolConfig<any, any>;
}

// biome-ignore lint/suspicious/noExplicitAny: erase the per-tool generics for the registry
function reg(name: string, config: ToolConfig<any, any>): RegisteredTool {
  return { name, description: config.description, inputSchema: config.parameters, config };
}

export const TOOLS: RegisteredTool[] = [
  reg('-health-check', healthCheck),
  reg('list-guide-topics', listGuideTopics),
  reg('search-guide', searchGuide),
  reg('get-guide-section', getGuideSection),
];
