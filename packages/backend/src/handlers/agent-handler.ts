/**
 * Agent Handler
 * Handles agent-related operations
 */

import { generateAgentId, LLMClientFactory } from '@teros/core';
import type { Collection, Db } from 'mongodb';
import type { WebSocket } from 'ws';
import { config } from '../config';
import type { ProviderService } from '../services/provider-service';

interface Agent {
  agentId: string;
  coreId: string;
  ownerId: string;
  workspaceId?: string;
  name: string;
  fullName: string;
  role: string;
  intro: string;
  avatarUrl?: string;
  maxSteps?: number;
  context?: string;
  availableProviders?: string[];
  selectedProviderId?: string | null;
  selectedModelId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface AgentCore {
  coreId: string;
  name: string;
  fullName: string;
  systemPrompt: string;
  personality: string[];
  capabilities: string[];
  avatarUrl: string;
}

interface CreateAgentData {
  coreId: string;
  name: string;
  fullName: string;
  role: string;
  intro: string;
  avatarUrl?: string;
  workspaceId?: string;
  context?: string;
}

interface UpdateAgentData {
  agentId: string;
  name?: string;
  fullName?: string;
  role?: string;
  intro?: string;
  avatarUrl?: string;
  maxSteps?: number;
  context?: string;
  availableProviders?: string[];
  selectedProviderId?: string | null;
  selectedModelId?: string | null;
}

interface GenerateProfileData {
  coreId: string;
  excludeNames?: string[];
}

interface GeneratedProfile {
  name: string;
  fullName: string;
  role: string;
  intro: string;
  responseStyle: string;
}

interface WorkspaceService {
  canAccess(workspaceId: string, userId: string): Promise<boolean>;
  canWrite(workspaceId: string, userId: string): Promise<boolean>;
  getWorkspace(workspaceId: string): Promise<any>;
}

const SYSTEM_USER_ID = 'system';

export class AgentHandler {
  private agents: Collection<Agent>;
  private agentCores: Collection<AgentCore>;
  private workspaceService?: WorkspaceService;

  constructor(
    private db: Db,
    private providerService: ProviderService,
    workspaceService?: WorkspaceService,
  ) {
    this.agents = db.collection<Agent>('agents');
    this.agentCores = db.collection<AgentCore>('agent_cores');
    this.workspaceService = workspaceService;
  }

  /**
   * Build full avatar URL from filename
   * DB stores only filename (e.g., "alice-avatar.jpg")
   */
  private buildAvatarUrl(avatarFilename?: string): string | undefined {
    if (!avatarFilename) return undefined;
    return `${config.static.baseUrl}/${avatarFilename}`;
  }

  /**
   * Handle list_agents request
   * Returns user-facing agent instances (not cores)
   * Falls back to core's avatar if instance doesn't have one
   *
   * @param workspaceId - If provided, list agents for that workspace. If null/undefined, list user's global agents.
   */
  async handleListAgents(ws: WebSocket, userId: string, message?: any): Promise<void> {
    const workspaceId = message?.workspaceId;

    // If workspace specified, verify access
    if (workspaceId) {
      if (!this.workspaceService) {
        this.sendError(ws, 'WORKSPACE_NOT_CONFIGURED', 'Workspace service not available');
        return;
      }
      if (!(await this.workspaceService.canAccess(workspaceId, userId))) {
        this.sendError(ws, 'ACCESS_DENIED', 'You do not have access to this workspace');
        return;
      }
      console.log(`[AgentHandler] Listing agents for workspace: ${workspaceId}`);
    } else {
      console.log(`[AgentHandler] Listing global agents for user: ${userId}`);
    }

    // Build query based on scope
    const query: any = {};
    if (workspaceId) {
      // Workspace agents: belong to workspace, owned by any user with access
      query.workspaceId = workspaceId;
    } else {
      // Global agents: owned by user, no workspace
      query.ownerId = userId;
      query.workspaceId = null;
    }

    const agents = await this.agents.find(query).toArray();
    console.log(`[AgentHandler] Found ${agents.length} agents`);

    // Get all cores for avatar fallback
    const cores = await this.agentCores.find({}).toArray();
    const coreMap = new Map(cores.map((c) => [c.coreId, c]));

    this.sendResponse(ws, {
      type: 'agents_list',
      workspaceId,
      agents: agents.map((a: any) => {
        // Fallback to core's avatar if instance doesn't have one
        const core = coreMap.get(a.coreId);
        const avatarUrl = a.avatarUrl || core?.avatarUrl;

        return {
          agentId: a.agentId,
          name: a.name,
          fullName: a.fullName,
          role: a.role,
          intro: a.intro,
          context: a.context || '',
          maxSteps: a.maxSteps,
          avatarUrl: this.buildAvatarUrl(avatarUrl),
          coreId: a.coreId,
          workspaceId: a.workspaceId,
          availableProviders: a.availableProviders || [],
          selectedProviderId: a.selectedProviderId || null,
          selectedModelId: a.selectedModelId || null,
        };
      }),
    });
  }

  /**
   * Handle create_agent request
   * Creates a new agent instance for the user or workspace
   * Validates that the coreId exists
   *
   * @param workspaceId - If provided, creates agent in workspace (requires write access)
   */
  async handleCreateAgent(
    ws: WebSocket,
    userId: string,
    message: { data: CreateAgentData },
  ): Promise<void> {
    console.log(`[AgentHandler] Creating agent for user: ${userId}`, message.data);

    const { coreId, name, fullName, role, intro, avatarUrl, workspaceId, context } =
      message.data;

    // Validate required fields
    if (!coreId || !name || !fullName || !role || !intro) {
      this.sendError(
        ws,
        'INVALID_REQUEST',
        'Missing required fields: coreId, name, fullName, role, intro',
      );
      return;
    }

    // If workspace specified, verify write access
    if (workspaceId) {
      if (!this.workspaceService) {
        this.sendError(ws, 'WORKSPACE_NOT_CONFIGURED', 'Workspace service not available');
        return;
      }
      if (!(await this.workspaceService.canWrite(workspaceId, userId))) {
        this.sendError(ws, 'ACCESS_DENIED', 'You do not have write access to this workspace');
        return;
      }
      // Verify workspace exists
      const workspace = await this.workspaceService.getWorkspace(workspaceId);
      if (!workspace) {
        this.sendError(ws, 'WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' not found`);
        return;
      }
    }

    // Validate core exists
    const core = await this.agentCores.findOne({ coreId });
    if (!core) {
      this.sendError(ws, 'CORE_NOT_FOUND', `Agent core '${coreId}' not found`);
      return;
    }

    // Generate unique agent ID
    const agentId = generateAgentId();

    // Create the agent
    const now = new Date().toISOString();
    const newAgent: Agent = {
      agentId,
      coreId,
      ownerId: userId,
      workspaceId, // undefined for global agents, set for workspace agents
      name,
      fullName,
      role,
      intro,
      avatarUrl: avatarUrl || core.avatarUrl,
      context,
      createdAt: now,
      updatedAt: now,
    };

    await this.agents.insertOne(newAgent);
    console.log(
      `[AgentHandler] Created agent: ${agentId} for user ${userId}${workspaceId ? ` in workspace ${workspaceId}` : ' (global)'}`,
    );

    // Return the created agent with full avatar URL
    this.sendResponse(ws, {
      type: 'agent_created',
      agent: {
        agentId: newAgent.agentId,
        name: newAgent.name,
        fullName: newAgent.fullName,
        role: newAgent.role,
        intro: newAgent.intro,
        avatarUrl: this.buildAvatarUrl(newAgent.avatarUrl),
        coreId: newAgent.coreId,
        workspaceId: newAgent.workspaceId,
      },
    });
  }

  /**
   * Handle generate_agent_profile request
   * Generates a unique agent profile using LLM based on the core's characteristics
   * Excludes names that are already in use by the user's agents
   */
  async handleGenerateAgentProfile(
    ws: WebSocket,
    userId: string,
    message: { data: GenerateProfileData },
  ): Promise<void> {
    console.log(`[AgentHandler] Generating agent profile for user: ${userId}`, message.data);

    const { coreId, excludeNames = [] } = message.data;

    // Validate core exists and get its details
    const core = await this.agentCores.findOne({ coreId });
    if (!core) {
      this.sendError(ws, 'CORE_NOT_FOUND', `Agent core '${coreId}' not found`);
      return;
    }

    // Get existing agent names for this user to exclude
    const existingAgents = await this.agents
      .find({
        ownerId: userId,
      })
      .toArray();
    const existingNames = existingAgents.map((a) => a.name);
    const allExcludedNames = [...new Set([...excludeNames, ...existingNames])];

    try {
      // Get system user's provider for generation
      const providers = await this.providerService.listUserProviders(SYSTEM_USER_ID);
      if (providers.length === 0) {
        throw new Error('No provider configured for system user. Run: npm run init:system-provider');
      }

      const provider = providers.find((p) => p.status === 'active') || providers[0];

      // Prefer Sonnet model, fallback to first available
      const preferredModel = provider.models.find((m) => m.modelId.includes('sonnet'));
      const modelToUse = preferredModel || provider.models[0];

      if (!modelToUse) {
        throw new Error('No models available in system provider');
      }

      // Get decrypted secrets
      const secrets = await this.providerService.getProviderSecrets(
        SYSTEM_USER_ID,
        provider.providerId,
      );

      if (!secrets || !secrets.apiKey) {
        throw new Error(`Failed to decrypt secrets for provider ${provider.providerId}`);
      }

      console.log(
        `[AgentHandler] Generating profile using ${modelToUse.modelId} (${provider.providerType})`,
      );

      // Create LLM client with system provider
      const llmClient = await LLMClientFactory.create({
        provider: provider.providerType as any,
        anthropic:
          provider.providerType === 'anthropic'
            ? {
                apiKey: secrets.apiKey,
                model: modelToUse.modelString,
                maxTokens: 1024,
              }
            : undefined,
        openai:
          provider.providerType === 'openai'
            ? {
                apiKey: secrets.apiKey,
                model: modelToUse.modelString,
                maxTokens: 1024,
              }
            : undefined,
      });

      const prompt = this.buildGenerationPrompt(core, allExcludedNames);

      // Use streamMessage but collect the full response
      let fullResponse = '';
      await llmClient.streamMessage({
        messages: [
          {
            info: { id: '1', sessionID: 'gen', role: 'user', time: { created: Date.now() } },
            parts: [
              {
                id: '1',
                sessionID: 'gen',
                messageID: '1',
                type: 'text',
                text: prompt,
                time: { start: Date.now(), end: Date.now() },
              },
            ],
          },
        ],
        systemPrompt:
          'You are a creative assistant that generates unique AI assistant personas. Always respond with valid JSON only, no markdown or extra text.',
        callbacks: {
          onText: (chunk) => {
            fullResponse += chunk;
          },
          onTextEnd: () => {},
          onToolCall: () => {},
        },
      });

      // Parse the JSON response
      const profile = this.parseGeneratedProfile(fullResponse);

      console.log(`[AgentHandler] Generated profile: ${profile.fullName}`);

      this.sendResponse(ws, {
        type: 'agent_profile_generated',
        profile,
      });
    } catch (error: any) {
      console.error(`[AgentHandler] Failed to generate profile:`, error);
      this.sendError(ws, 'GENERATION_FAILED', error.message || 'Failed to generate agent profile');
    }
  }

  /**
   * Build the prompt for generating an agent profile
   */
  private buildGenerationPrompt(core: AgentCore, excludeNames: string[]): string {
    const excludeList =
      excludeNames.length > 0
        ? `\n\nIMPORTANT: Do NOT use any of these names (they are already taken): ${excludeNames.join(', ')}`
        : '';

    return `Generate a unique AI assistant persona based on these characteristics:

Core Engine: ${core.name} (${core.fullName})
Personality traits: ${core.personality.join(', ')}
Capabilities: ${core.capabilities.join(', ')}
${excludeList}

Create a persona with:
1. A unique first name (feminine, professional, memorable - like Alice, Berta, Clara, Diana, Elena, Fiona, Grace, Helena, Iris, Julia)
2. A unique last name (nature/professional themed - like Evergreen, Thornwood, Westbrook, Ashford, Blackwood, Sterling, Rivers, Hartwell)
3. A specific role title (not just "Assistant" - be creative like "Technical Advisor", "Development Partner", "Research Analyst")
4. A detailed introduction (3-4 paragraphs) that:
   - Introduces the persona in first person
   - Describes their focus and approach
   - Lists primary responsibilities (3-4 items)
   - Lists secondary responsibilities (3-4 items)
5. A response style keyword (friendly, professional, collaborative, analytical, concise, etc.)

Respond with ONLY valid JSON in this exact format:
{
  "name": "FirstName",
  "fullName": "FirstName LastName", 
  "role": "Specific Role Title",
  "intro": "Full introduction text...",
  "responseStyle": "keyword"
}`;
  }

  /**
   * Parse the LLM response into a GeneratedProfile
   */
  private parseGeneratedProfile(response: string): GeneratedProfile {
    // Try to extract JSON from the response
    let jsonStr = response.trim();

    // Remove markdown code blocks if present
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.slice(7);
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.slice(3);
    }
    if (jsonStr.endsWith('```')) {
      jsonStr = jsonStr.slice(0, -3);
    }
    jsonStr = jsonStr.trim();

    try {
      const parsed = JSON.parse(jsonStr);

      // Validate required fields
      if (!parsed.name || !parsed.fullName || !parsed.role || !parsed.intro) {
        throw new Error('Missing required fields in generated profile');
      }

      return {
        name: parsed.name,
        fullName: parsed.fullName,
        role: parsed.role,
        intro: parsed.intro,
        responseStyle: parsed.responseStyle || 'friendly',
      };
    } catch (error) {
      console.error('[AgentHandler] Failed to parse generated profile:', response);
      throw new Error('Failed to parse generated profile from LLM response');
    }
  }

  /**
   * Handle update_agent request
   * Updates an existing agent instance owned by the user
   */
  async handleUpdateAgent(
    ws: WebSocket,
    userId: string,
    message: { data: UpdateAgentData },
  ): Promise<void> {
    console.log(`[AgentHandler] Updating agent for user: ${userId}`, message.data);

    const { agentId, name, fullName, role, intro, avatarUrl, maxSteps, context, availableProviders, selectedProviderId, selectedModelId } =
      message.data;

    // Validate agentId
    if (!agentId) {
      this.sendError(ws, 'INVALID_REQUEST', 'Missing required field: agentId');
      return;
    }

    // Find the agent and verify ownership
    const existingAgent = await this.agents.findOne({ agentId, ownerId: userId });
    if (!existingAgent) {
      this.sendError(ws, 'AGENT_NOT_FOUND', `Agent '${agentId}' not found or access denied`);
      return;
    }

    // Build update object with only provided fields
    const updateFields: Partial<Agent> = {
      updatedAt: new Date().toISOString(),
    };

    if (name !== undefined) updateFields.name = name;
    if (fullName !== undefined) updateFields.fullName = fullName;
    if (role !== undefined) updateFields.role = role;
    if (intro !== undefined) updateFields.intro = intro;
    if (avatarUrl !== undefined) updateFields.avatarUrl = avatarUrl;
    if (maxSteps !== undefined) updateFields.maxSteps = maxSteps;
    if (context !== undefined) updateFields.context = context;
    if (availableProviders !== undefined) updateFields.availableProviders = availableProviders;
    if (selectedProviderId !== undefined) updateFields.selectedProviderId = selectedProviderId;
    if (selectedModelId !== undefined) updateFields.selectedModelId = selectedModelId;

    // Update the agent
    await this.agents.updateOne({ agentId, ownerId: userId }, { $set: updateFields });

    // Get the updated agent
    const updatedAgent = await this.agents.findOne({ agentId });
    if (!updatedAgent) {
      this.sendError(ws, 'UPDATE_FAILED', 'Failed to retrieve updated agent');
      return;
    }

    console.log(`[AgentHandler] Updated agent: ${agentId} for user ${userId}`);

    // Get core for avatar fallback
    const core = await this.agentCores.findOne({ coreId: updatedAgent.coreId });
    const finalAvatarUrl = updatedAgent.avatarUrl || core?.avatarUrl;

    // Return the updated agent
    this.sendResponse(ws, {
      type: 'agent_updated',
      agent: {
        agentId: updatedAgent.agentId,
        name: updatedAgent.name,
        fullName: updatedAgent.fullName,
        role: updatedAgent.role,
        intro: updatedAgent.intro,
        avatarUrl: this.buildAvatarUrl(finalAvatarUrl),
        coreId: updatedAgent.coreId,
        maxSteps: updatedAgent.maxSteps,
        context: updatedAgent.context,
      },
    });
  }

  /**
   * Handle delete_agent request
   * Deletes an agent instance owned by the user
   */
  async handleDeleteAgent(
    ws: WebSocket,
    userId: string,
    message: { data: { agentId: string } },
  ): Promise<void> {
    console.log(`[AgentHandler] Deleting agent for user: ${userId}`, message.data);

    const { agentId } = message.data;

    if (!agentId) {
      this.sendError(ws, 'INVALID_REQUEST', 'Missing required field: agentId');
      return;
    }

    // Find the agent and verify ownership
    const existingAgent = await this.agents.findOne({ agentId, ownerId: userId });
    if (!existingAgent) {
      this.sendError(ws, 'AGENT_NOT_FOUND', `Agent '${agentId}' not found or access denied`);
      return;
    }

    // Delete the agent
    await this.agents.deleteOne({ agentId, ownerId: userId });

    console.log(`[AgentHandler] Deleted agent: ${agentId} for user ${userId}`);

    this.sendResponse(ws, {
      type: 'agent_deleted',
      agentId,
    });
  }

  /**
   * Send response to client
   */
  private sendResponse(ws: WebSocket, data: any): void {
    ws.send(JSON.stringify(data));
  }

  /**
   * Send error to client
   */
  private sendError(ws: WebSocket, code: string, message: string): void {
    ws.send(
      JSON.stringify({
        type: 'error',
        code,
        message,
      }),
    );
  }
}
