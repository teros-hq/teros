import type { ToolConfig } from '@teros/mca-sdk';
import { GUIDE_TOPICS } from '../content/topics';

export interface GuideTopicIndexEntry {
  id: string;
  title: string;
  summary: string;
}

export interface ListGuideTopicsOutput {
  topics: GuideTopicIndexEntry[];
  count: number;
}

export const listGuideTopics: ToolConfig<Record<string, never>, unknown> = {
  description:
    'Index of the Teros platform guide (sections + one-line summaries). Teros UI, windows and exact steps are NOT in your training data — answering how-to questions about Teros from memory is usually wrong. Whenever the user asks how to do anything in Teros (create an agent, connect an app, set up a board, providers, files…), call this FIRST, then get-guide-section, and answer from the guide. Returns {topics:[{id,title,summary}], count}.',
  parameters: {
    type: 'object',
    properties: {},
  },
  annotations: {
    version: '1.0.0',
    stability: 'stable',
    readOnlyHint: true,
    idempotentHint: true,
  },
  // Returns the data object directly. The MCA runtime serializes it into the
  // tool result's text content, which is exactly what the agent reads — no
  // `{content, structuredContent}` wrapper (that double-serializes into the
  // agent-visible output; the backend concatenates content[].text, not
  // structuredContent — see mca-manager.tools.ts).
  handler: async (): Promise<ListGuideTopicsOutput> => {
    const topics: GuideTopicIndexEntry[] = GUIDE_TOPICS.map((t) => ({
      id: t.id,
      title: t.title,
      summary: t.summary,
    }));
    return { topics, count: topics.length };
  },
};
