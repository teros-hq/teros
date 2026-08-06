/**
 * Agent fixtures — canonical test data for agents, cores, and models.
 *
 * These are the same records that TestServer.seedAgents() inserts.
 * Import them directly when you need to assert against known field values
 * without spinning up a full server.
 */

export const TEST_MODEL = {
  modelId: 'model:claude-sonnet',
  provider: 'anthropic',
  name: 'Claude 3.5 Sonnet',
  description: 'Test model',
  modelString: 'claude-3-5-sonnet-20241022',
  capabilities: {
    streaming: true,
    tools: true,
    vision: false,
    thinking: true,
  },
  context: {
    maxTokens: 200000,
    maxOutputTokens: 8192,
  },
  defaults: {
    temperature: 0.7,
    maxTokens: 4096,
  },
  reservations: {
    systemPrompt: 2000,
    memory: 1000,
    tools: 1000,
  },
  pricing: {
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
  },
};

// The two internal cores of the consolidated model (matches production: agents
// are mapped by scope, never to a custom/legacy core). Modern AgentCore shape.
const BASE_CORE = {
  version: 'v1.0',
  modelId: 'model:claude-sonnet',
  systemPrompt: 'You are a helpful AI assistant for testing.',
  personality: ['Direct', 'Efficient'],
  capabilities: ['Testing'],
  defaultApps: [] as string[],
  avatarUrl: 'iria.png',
  modelOverrides: { temperature: 0.7 },
  status: 'active',
};

export const AGENT_CORE = {
  coreId: 'agent',
  coreType: 'agent',
  name: 'Agent',
  fullName: 'Teros Agent',
  ...BASE_CORE,
};

export const SUPER_AGENT_CORE = {
  coreId: 'super-agent',
  coreType: 'super-agent',
  name: 'Super Agent',
  fullName: 'Teros Super Agent',
  ...BASE_CORE,
};

export const ALL_CORES = [AGENT_CORE, SUPER_AGENT_CORE];

// Back-compat alias for the makeCore factory (defaults to the super-agent core).
export const TEST_CORE = SUPER_AGENT_CORE;

export const AGENT_IRIA = {
  agentId: 'agent:iria',
  coreId: 'super-agent',
  name: 'Iria',
  fullName: 'Iria Devon',
  role: 'AI Assistant',
  intro: 'I am Iria, your AI assistant.',
  avatarUrl: 'iria.png',
  status: 'active',
  customization: {
    personalityTweaks: ['helpful', 'friendly'],
    additionalCapabilities: ['tools'],
    responseStyle: 'conversational',
  },
};

export const AGENT_TEST = {
  agentId: 'agent:test',
  coreId: 'super-agent',
  name: 'Test',
  fullName: 'Test Agent',
  role: 'Test Assistant',
  intro: 'I am a test agent.',
  avatarUrl: 'test.png',
  status: 'active',
  customization: {
    personalityTweaks: ['helpful'],
    responseStyle: 'concise',
  },
};

export const ALL_AGENTS = [AGENT_IRIA, AGENT_TEST];
