/**
 * memory actions — mca.teros.memory, APIfied.
 *
 * Agent memory lives in Qdrant (one set of collections per agent, embedded
 * with OpenAI). The MCA used to hold the Qdrant client AND the OpenAI key
 * itself (system secrets pushed into the container); it is now a thin client
 * and every tool forwards to a named action here. The backend executes the
 * action with the SAME `@teros/shared/memory` library the MCA used, so result
 * shapes are byte-identical (McaMemoryHooks parses `context-for-query` and
 * `save-conversation` outputs) — datastore-isolation P1b.
 *
 * Tenancy model — identical for every action except `ping`:
 *   - Memory is PER-AGENT. The caller names the agent in the body
 *     (`agentId`, taken by the MCA from its execution context), but the body
 *     is never trusted for scope on its own: `requireAgent` verifies, against
 *     the verified token's `appId`, that
 *       1. the app exists, is a `mca.teros.memory` installation and is not
 *          disabled,
 *       2. an `agent_app_access` row links that agent to that app (the same
 *          authority McaToolExecutor re-checks before every tool call), and
 *       3. the agent exists.
 *     Any failure is a generic 403 (which check failed is not revealed).
 *     `agents.workspaceId` is deliberately NOT compared with `apps.ownerId`:
 *     superagents have no workspaceId (types/database.ts) and the
 *     agent_app_access row is the authoritative link.
 *   - `agentId` must also match the platform's id format. `getAgentCollection`
 *     in the shared lib normalizes the id (strips a leading `agent_`, replaces
 *     unsafe chars with `_`), so loosely-shaped ids could collide onto one
 *     collection; the strict format makes the mapping injective.
 *   - `channelId` is a filter INSIDE the agent's own memory, not a security
 *     boundary, so it may come from the body.
 *
 * Attribution — known limitation (same as workflows): `ctx.userId` is the
 * workspace OWNER (the callback token identifies the container, which is
 * per-app, not the end user who triggered the tool). The `userId` stored on
 * conversation / knowledge points therefore records the owner. The direct-MCA
 * version stored `execution.userId`; per-end-user attribution needs a
 * per-request identity on the callback, which the token does not carry today.
 *
 * Credentials: read lazily from `.secrets/mcas/mca.teros.memory/credentials.json`
 * (`qdrantUrl`, `qdrantApiKey`, `openaiApiKey`) through the SecretsManager —
 * the same file the container used to receive as system secrets. The Qdrant
 * and OpenAI clients are process-global singletons in the shared lib, so they
 * are initialized once per backend process.
 */

import type { Db } from 'mongodb';
import { z, type ZodTypeAny } from 'zod';
import { formatContextForPrompt, getRelevantContext } from '@teros/shared/memory/context';
import { getRecentConversations, saveConversation, searchConversations } from '@teros/shared/memory/conversation';
import { initializeOpenAI } from '@teros/shared/memory/embeddings';
import { calculateImportance } from '@teros/shared/memory/importance';
import { getKnowledgeByCategory, saveKnowledge, searchKnowledge } from '@teros/shared/memory/knowledge';
import { getAgentMemoryStats, initializeQdrant } from '@teros/shared/memory/qdrant-client';
import { getMcaActionDeps, McaActionError, type McaActionCapability, type McaActionCtx } from './index';

const MCA_ID = 'mca.teros.memory';

// =============================================================================
// Errors
// =============================================================================

function fail(code: string, message: string, suggestion?: string, status = 400): never {
  throw new McaActionError(code, message, status, suggestion);
}

const FORBIDDEN_MSG = 'memory actions require an agent with access to this memory app';

function forbidden(): never {
  return fail('FORBIDDEN', FORBIDDEN_MSG, undefined, 403);
}

// =============================================================================
// Lazy datastore initialization
// =============================================================================

interface MemoryCredentials {
  qdrantUrl?: unknown;
  qdrantApiKey?: unknown;
  openaiApiKey?: unknown;
}

let memoryInitialized = false;

/**
 * Initialize the shared memory lib's Qdrant + OpenAI singletons once, from the
 * MCA's credentials file. Missing SecretsManager or credentials → 503
 * UNAVAILABLE (the action is retried on the next call, nothing is cached).
 */
function ensureMemoryInit(): void {
  if (memoryInitialized) return;
  const secretsManager = getMcaActionDeps().secretsManager;
  if (!secretsManager) {
    return fail('UNAVAILABLE', 'Memory backend is not configured (no secrets manager)', undefined, 503);
  }
  const creds = secretsManager.mca<MemoryCredentials>(MCA_ID);
  const qdrantUrl = typeof creds?.qdrantUrl === 'string' ? creds.qdrantUrl : '';
  const qdrantApiKey = typeof creds?.qdrantApiKey === 'string' ? creds.qdrantApiKey : '';
  const openaiApiKey = typeof creds?.openaiApiKey === 'string' ? creds.openaiApiKey : '';
  if (!qdrantUrl || !qdrantApiKey || !openaiApiKey) {
    return fail(
      'UNAVAILABLE',
      'Memory backend is not configured (qdrantUrl, qdrantApiKey and openaiApiKey are required)',
      undefined,
      503,
    );
  }
  initializeQdrant({ url: qdrantUrl, apiKey: qdrantApiKey });
  initializeOpenAI(openaiApiKey);
  memoryInitialized = true;
  console.log('[mca-actions/memory] Qdrant and OpenAI initialized');
}

// =============================================================================
// Input validation
// =============================================================================

function validateInput<T extends ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    const issue = parsed.error.errors[0];
    const path = issue.path.length > 0 ? issue.path.join('.') : '<input>';
    return fail(
      'INVALID_INPUT',
      `Invalid input at "${path}": ${issue.message}`,
      'Check the tool description for the expected shape.',
    );
  }
  return parsed.data;
}

/** Same 6-value enum the MCA tools declare in their parameter schemas. */
const KNOWLEDGE_CATEGORIES = [
  'user_preferences',
  'project_data',
  'commands',
  'coding_patterns',
  'tools',
  'workflows',
] as const;

const CategorySchema = z.enum(KNOWLEDGE_CATEGORIES);

/** Optional in-memory filter (the agent's own memory, not a tenancy boundary). */
const ChannelFilter = { channelId: z.string().min(1).optional() };

const SearchConversationsSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(5),
  ...ChannelFilter,
});

const RecentConversationsSchema = z.object({
  limit: z.number().int().min(1).max(100).default(10),
  ...ChannelFilter,
});

const ConversationFactorsSchema = z.object({
  userMessage: z.string().min(1),
  assistantResponse: z.string().min(1),
  filesModified: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
});

const SaveConversationSchema = ConversationFactorsSchema.extend(ChannelFilter);

const SaveKnowledgeSchema = z.object({
  content: z.string().min(1),
  category: CategorySchema,
  confidence: z.number().min(0).max(1).default(0.8),
});

const SearchKnowledgeSchema = z.object({
  query: z.string().min(1),
  category: CategorySchema.optional(),
  limit: z.number().int().min(1).max(50).default(5),
});

const KnowledgeByCategorySchema = z.object({ category: CategorySchema });

const ContextForQuerySchema = z.object({ query: z.string().min(1) });

// =============================================================================
// Tenancy
// =============================================================================

/**
 * Agent id format, derived from how ids are minted today:
 *   - `generateAgentId()` (packages/core/src/ids.ts): `agent_<hex16>`
 *   - seeded / legacy instances (types/database.ts AgentInstance doc comment,
 *     scripts/seed-agents.ts): `agent:<slug>` e.g. `agent:iria`
 * `getAgentCollection` maps `agent_H` → `H` and `agent:S` → `agent_S` → `S`,
 * so the two shapes are injective as long as a slug is never itself 16 hex
 * chars — that single overlap is rejected explicitly below.
 */
const AGENT_ID_RE = /^agent(?:_[0-9a-f]{16}|:[a-z0-9][a-z0-9-]{0,63})$/;
const HEX16_RE = /^[0-9a-f]{16}$/;

function isValidAgentId(value: unknown): value is string {
  if (typeof value !== 'string' || !AGENT_ID_RE.test(value)) return false;
  if (value.startsWith('agent:') && HEX16_RE.test(value.slice('agent:'.length))) return false;
  return true;
}

interface AgentScope {
  agentId: string;
  /** Workspace owner — used for attribution (see the header comment). */
  userId?: string;
}

/**
 * Resolve and authorize the agent whose memory the action touches. Fails
 * closed (403, generic message) on any missing link; see the header comment
 * for the exact checks. Nothing else from the body is trusted for scope.
 */
async function requireAgent(db: Db, ctx: McaActionCtx, body: Record<string, unknown>): Promise<AgentScope> {
  const agentId = body.agentId;
  if (!isValidAgentId(agentId)) return forbidden();
  if (!ctx.appId) return forbidden();

  const app = await db.collection('apps').findOne({ appId: ctx.appId, mcaId: MCA_ID });
  if (!app || app.status === 'disabled') return forbidden();

  const access = await db.collection('agent_app_access').findOne({ agentId, appId: ctx.appId });
  if (!access) return forbidden();

  const agent = await db.collection('agents').findOne({ agentId });
  if (!agent) return forbidden();

  return { agentId, userId: ctx.userId };
}

// =============================================================================
// Capability
// =============================================================================

export const memoryCapability: McaActionCapability = {
  mcaId: MCA_ID,
  actions: {
    /**
     * Liveness of the action channel. Touches no tenant data and does not
     * open the datastore, so a container's health check never flips to
     * not_ready over tenancy or credentials.
     */
    async ping() {
      return { ok: true };
    },

    /** Former memory-search-conversations. Scope: agent's conversations, optional channelId filter. */
    async 'search-conversations'(ctx, db, body) {
      const { agentId } = await requireAgent(db, ctx, body);
      const input = validateInput(SearchConversationsSchema, body);
      ensureMemoryInit();
      const results = await searchConversations(
        agentId,
        input.query,
        input.limit,
        input.channelId ? { channelId: input.channelId } : undefined,
      );
      return { success: true, results };
    },

    /** Former memory-get-recent-conversations. Scope: agent's conversations, optional channelId filter. */
    async 'recent-conversations'(ctx, db, body) {
      const { agentId } = await requireAgent(db, ctx, body);
      const input = validateInput(RecentConversationsSchema, body);
      ensureMemoryInit();
      const results = await getRecentConversations(
        agentId,
        input.limit,
        input.channelId ? { channelId: input.channelId } : undefined,
      );
      return { success: true, results };
    },

    /** Former memory-save-conversation. Scope: agent's conversations; userId = workspace owner. */
    async 'save-conversation'(ctx, db, body) {
      const { agentId, userId } = await requireAgent(db, ctx, body);
      const input = validateInput(SaveConversationSchema, body);
      ensureMemoryInit();
      const importance = calculateImportance({
        userMessage: input.userMessage,
        assistantResponse: input.assistantResponse,
        filesModified: input.filesModified,
        commandsRun: input.commandsRun,
      });
      await saveConversation(input.userMessage, input.assistantResponse, {
        agentId,
        importance,
        userId,
        channelId: input.channelId,
      });
      return {
        success: true,
        message: `Conversation saved with importance score: ${importance.toFixed(2)}`,
        importance,
      };
    },

    /** Former memory-save-knowledge. Scope: agent's knowledge; userId = workspace owner. */
    async 'save-knowledge'(ctx, db, body) {
      const { agentId, userId } = await requireAgent(db, ctx, body);
      const input = validateInput(SaveKnowledgeSchema, body);
      ensureMemoryInit();
      const id = await saveKnowledge(agentId, input.content, 'mca-tool', input.category, {
        confidence: input.confidence,
        userId,
      });
      return { success: true, message: 'Knowledge saved successfully', id };
    },

    /** Former memory-search-knowledge. Scope: agent's knowledge, optional category filter. */
    async 'search-knowledge'(ctx, db, body) {
      const { agentId } = await requireAgent(db, ctx, body);
      const input = validateInput(SearchKnowledgeSchema, body);
      ensureMemoryInit();
      const results = await searchKnowledge(agentId, input.query, input.limit, input.category);
      return { success: true, results };
    },

    /** Former memory-get-knowledge-by-category. Scope: agent's knowledge, one category. */
    async 'knowledge-by-category'(ctx, db, body) {
      const { agentId } = await requireAgent(db, ctx, body);
      const input = validateInput(KnowledgeByCategorySchema, body);
      ensureMemoryInit();
      const results = await getKnowledgeByCategory(agentId, input.category);
      return { success: true, results };
    },

    /**
     * Former memory-get-context-for-query. Scope: agent's conversations +
     * knowledge + tasks. The result shape is load-bearing: McaMemoryHooks
     * requires `success === true` and a string `context`.
     */
    async 'context-for-query'(ctx, db, body) {
      const { agentId } = await requireAgent(db, ctx, body);
      const input = validateInput(ContextForQuerySchema, body);
      ensureMemoryInit();
      const relevantContext = await getRelevantContext(agentId, input.query);
      const formattedContext = formatContextForPrompt(relevantContext);
      return { success: true, context: formattedContext || 'No relevant context found in memory' };
    },

    /** Former memory-stats. Scope: the agent's three collections (point counts). */
    async stats(ctx, db, body) {
      const { agentId } = await requireAgent(db, ctx, body);
      ensureMemoryInit();
      const stats = await getAgentMemoryStats(agentId);
      return { success: true, stats };
    },

    /**
     * Former memory-calculate-importance. Pure (no datastore), kept server-side
     * so the MCA has no dependency on @teros/shared. Scope: agent check only.
     */
    async 'calculate-importance'(ctx, db, body) {
      await requireAgent(db, ctx, body);
      const input = validateInput(ConversationFactorsSchema, body);
      const importance = calculateImportance({
        userMessage: input.userMessage,
        assistantResponse: input.assistantResponse,
        filesModified: input.filesModified,
        commandsRun: input.commandsRun,
      });
      return {
        success: true,
        importance,
        breakdown: {
          messageLength: input.userMessage.length,
          responseLength: input.assistantResponse.length,
          filesModified: input.filesModified.length,
          commandsRun: input.commandsRun.length,
        },
      };
    },
  },
};
