import type { ToolConfig } from '@teros/mca-sdk';
import { GUIDE_TOPICS } from '../content/topics';

/**
 * Valid topic ids, derived from the content so the tool surface can never drift
 * from what actually exists. Used as the `topic` enum AND for fail-loud
 * validation in the handler.
 */
export const TOPIC_IDS: string[] = GUIDE_TOPICS.map((t) => t.id);

const TOPIC_BY_ID = new Map(GUIDE_TOPICS.map((t) => [t.id, t] as const));

export interface GetGuideSectionOutput {
  id: string;
  title: string;
  summary: string;
  /** Agent-oriented markdown for this section. Read it and explain it to the user in their language. */
  body: string;
  related: string[];
}

export const getGuideSection: ToolConfig<{ topic?: string }, unknown> = {
  description:
    'Get one Teros platform-guide section by topic id (from list-guide-topics). Use this to answer how-to questions about Teros instead of guessing — Teros specifics are not in your training data. Returns {id,title,summary,body(markdown),related}. Read the body and walk the user through the real steps in their own language; do not paste it verbatim.',
  parameters: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'Topic id to fetch. Must be one of the ids returned by `list-guide-topics`.',
        enum: TOPIC_IDS,
      },
    },
    required: ['topic'],
  },
  annotations: {
    version: '1.0.0',
    stability: 'stable',
    readOnlyHint: true,
    idempotentHint: true,
  },
  // Returns the data object directly (the agent reads the serialized text
  // content; no `{content, structuredContent}` wrapper — see list-topics.ts).
  handler: async (args): Promise<GetGuideSectionOutput> => {
    const topic = String(args?.topic ?? '').trim();
    if (!topic) {
      throw new Error(`topic is required — must be one of: ${TOPIC_IDS.join(', ')}`);
    }
    const found = TOPIC_BY_ID.get(topic);
    if (!found) {
      throw new Error(`Unknown guide topic "${topic}". Valid topics: ${TOPIC_IDS.join(', ')}`);
    }
    return {
      id: found.id,
      title: found.title,
      summary: found.summary,
      body: found.body,
      related: found.related ?? [],
    };
  },
};
