/**
 * Default Agent Service
 *
 * Owns the onboarding policy: create a default agent (Iria) for new users who
 * have none. The actual creation + app provisioning is delegated to
 * AgentProvisioningService so onboarding and agent.create share one code path.
 *
 * Iria is a global/personal agent (no workspace), so the provisioning service
 * resolves it to the 'super-agent' core. The user never picks a core.
 */

import type { Collection, Db } from 'mongodb';
import type { AgentInstance } from '../types/database';
import type { AgentProvisioningService } from '../services/agent-provisioning-service';

const DEFAULT_AGENT_PROFILE = {
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
};

export class DefaultAgentService {
  private agents: Collection<AgentInstance>;
  private provisioningService?: AgentProvisioningService;

  constructor(private db: Db) {
    this.agents = db.collection<AgentInstance>('agents');
  }

  /**
   * Late-bind the provisioning service after the DI container is ready
   * (AgentProvisioningService depends on McaService, built later).
   */
  setProvisioningService(provisioningService: AgentProvisioningService): void {
    this.provisioningService = provisioningService;
  }

  /**
   * Create a default agent for a user if they have no agents.
   * Called after user registration/creation.
   *
   * @returns The created agent or null if the user already has agents
   */
  async createDefaultAgentIfNeeded(userId: string): Promise<AgentInstance | null> {
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

    if (!this.provisioningService) {
      throw new Error(
        'DefaultAgentService: provisioning service not bound. Call setProvisioningService() at startup.',
      );
    }

    // Global agent (no workspace) → 'super-agent' core, resolved server-side.
    const agent = await this.provisioningService.createAgentFromCore({
      ownerId: userId,
      workspaceId: undefined,
      profile: DEFAULT_AGENT_PROFILE,
    });

    console.log(
      `[DefaultAgentService] Created default agent ${agent.agentId} (${agent.fullName}) for user ${userId}`,
    );

    return agent;
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
