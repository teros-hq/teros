/**
 * Default Agent Service
 *
 * Creates a default agent (Iria) for new users who have no agents.
 * This ensures every user has at least one agent to start with.
 */

import { generateAgentId } from '@teros/core';
import type { Collection, Db } from 'mongodb';

interface Agent {
  agentId: string;
  coreId: string;
  ownerId: string;
  name: string;
  fullName: string;
  role: string;
  intro: string;
  avatarUrl?: string;
  status: string;
  context?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface AgentCore {
  coreId: string;
  name: string;
  fullName: string;
  avatarUrl?: string;
}

// Default agent configuration
const DEFAULT_AGENT_CORE_ID = 'iria';
const DEFAULT_AGENT_CONFIG = {
  name: 'Iria',
  fullName: 'Iria Devon',
  role: 'Personal Assistant',
  intro: `Hi! I'm Iria, your personal AI assistant. I'm here to help you with software development, project management, research, and everyday tasks.

I can assist you with:
- Writing and reviewing code
- Managing projects and tasks
- Researching topics and answering questions
- Drafting emails and documents
- And much more!

Feel free to ask me anything. I'm here to help!`,
  responseStyle: 'friendly',
};

export class DefaultAgentService {
  private agents: Collection<Agent>;
  private agentCores: Collection<AgentCore>;

  constructor(private db: Db) {
    this.agents = db.collection<Agent>('agents');
    this.agentCores = db.collection<AgentCore>('agent_cores');
  }

  /**
   * Create a default agent for a user if they have no agents.
   * This is called after user registration/creation.
   *
   * @param userId - The user ID to create the agent for
   * @returns The created agent or null if user already has agents
   */
  async createDefaultAgentIfNeeded(userId: string): Promise<Agent | null> {
    // Check if user already has any agents
    const existingAgentCount = await this.agents.countDocuments({
      ownerId: userId,
      status: 'active',
    });

    if (existingAgentCount > 0) {
      console.log(
        `[DefaultAgentService] User ${userId} already has ${existingAgentCount} agent(s), skipping default agent creation`,
      );
      return null;
    }

    // Verify the default core exists
    const core = await this.agentCores.findOne({ coreId: DEFAULT_AGENT_CORE_ID });
    if (!core) {
      console.error(
        `[DefaultAgentService] Default agent core '${DEFAULT_AGENT_CORE_ID}' not found!`,
      );
      return null;
    }

    // Create the default agent
    const now = new Date().toISOString();
    const newAgent: Agent = {
      agentId: generateAgentId(),
      coreId: DEFAULT_AGENT_CORE_ID,
      ownerId: userId,
      name: DEFAULT_AGENT_CONFIG.name,
      fullName: DEFAULT_AGENT_CONFIG.fullName,
      role: DEFAULT_AGENT_CONFIG.role,
      intro: DEFAULT_AGENT_CONFIG.intro,
      avatarUrl: core.avatarUrl,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    await this.agents.insertOne(newAgent);
    console.log(
      `[DefaultAgentService] Created default agent ${newAgent.agentId} (${newAgent.fullName}) for user ${userId}`,
    );

    return newAgent;
  }
}

// Singleton instance
let defaultAgentServiceInstance: DefaultAgentService | null = null;

export function initDefaultAgentService(db: Db): DefaultAgentService {
  defaultAgentServiceInstance = new DefaultAgentService(db);
  return defaultAgentServiceInstance;
}

export function getDefaultAgentService(): DefaultAgentService {
  if (!defaultAgentServiceInstance) {
    throw new Error('DefaultAgentService not initialized. Call initDefaultAgentService(db) first.');
  }
  return defaultAgentServiceInstance;
}
