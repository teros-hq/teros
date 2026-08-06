/**
 * Skill Service
 *
 * Manages Skills as first-class resources within workspaces.
 *
 * Skills are reusable blocks of Markdown instructions/knowledge that can be
 * assigned to multiple agents and injected into their system prompts.
 *
 * Supports {{variable}} interpolation at injection time (see interpolateSkill).
 */

import { generateSkillId } from '@teros/core';
import type { Db, WithId } from 'mongodb';
import type { AgentSkillAccess, Skill } from '../types/database';
import { assertSafeSkillText, MAX_SKILL_CONTENT_CHARS, SkillSanitizationError } from './prompt-safety';

/**
 * Write-time guard (TER-379 / SEC-002/013): rechaza Unicode invisible/bidi y
 * contenido excesivamente largo en los campos de una skill ANTES de guardarla,
 * para que la carga nunca llegue al contexto del LLM. Fail-loud (lanza), nunca
 * recorta en silencio. Campos opcionales: solo valida los presentes.
 */
export function assertSkillFieldsSafe(fields: {
  name?: string;
  description?: string;
  content?: string;
}): void {
  if (fields.name !== undefined) assertSafeSkillText(fields.name, 'name');
  if (fields.description !== undefined) assertSafeSkillText(fields.description, 'description');
  if (fields.content !== undefined) {
    assertSafeSkillText(fields.content, 'content');
    if (fields.content.length > MAX_SKILL_CONTENT_CHARS) {
      throw new SkillSanitizationError(
        `content exceeds the maximum of ${MAX_SKILL_CONTENT_CHARS} characters (got ${fields.content.length}).`,
        'content',
        '',
        MAX_SKILL_CONTENT_CHARS,
      );
    }
  }
}

// ============================================================================
// SKILL INTERPOLATION
// ============================================================================

/**
 * Context available for variable interpolation in skill content
 */
export interface SkillInterpolationContext {
  agent: {
    name: string;
    fullName: string;
    role: string;
    intro: string;
    email?: string;
  };
  workspace?: {
    name: string;
  };
}

/**
 * Interpolates {{variable}} placeholders in skill content.
 * Variables that cannot be resolved are preserved as-is (not silenced),
 * and a warning is logged.
 *
 * Supported variables:
 * - {{agent.name}}, {{agent.fullName}}, {{agent.role}}, {{agent.intro}}, {{agent.email}}
 * - {{workspace.name}}
 *
 * @param content - Markdown content of the skill (may contain {{var}} placeholders)
 * @param ctx     - Interpolation context with agent and workspace data
 * @returns Content with resolved variables; unresolved variables are left as-is
 */
export function interpolateSkill(content: string, ctx: SkillInterpolationContext): string {
  const vars: Record<string, string | undefined> = {
    'agent.name': ctx.agent.name,
    'agent.fullName': ctx.agent.fullName,
    'agent.role': ctx.agent.role,
    'agent.intro': ctx.agent.intro,
    'agent.email': ctx.agent.email,
    'workspace.name': ctx.workspace?.name,
  };

  return content.replace(/\{\{([^}]+)\}\}/g, (match, key: string) => {
    const trimmed = key.trim();
    const value = vars[trimmed];
    if (value === undefined) {
      console.warn(`[SkillService] Unresolved skill variable: {{${trimmed}}}`);
      return match; // Preserve literal — do not silently drop
    }
    return value;
  });
}

// ============================================================================
// SKILL SERVICE
// ============================================================================

export class SkillService {
  private skillsCollection;
  private accessCollection;

  constructor(private db: Db) {
    this.skillsCollection = db.collection<Skill>('skills');
    this.accessCollection = db.collection<AgentSkillAccess>('agent_skill_access');
  }

  // ============================================================================
  // SKILL CRUD
  // ============================================================================

  /**
   * Create a new skill in a workspace.
   *
   * @param workspaceId - Workspace the skill belongs to
   * @param userId      - User creating the skill
   * @param data        - Skill fields (name required; description, content, category, tags optional)
   * @returns The created skill document
   * @throws If name is already taken within the workspace (MongoDB unique index)
   */
  async createSkill(
    workspaceId: string,
    userId: string,
    data: {
      name: string;
      description?: string;
      content: string;
      category?: Skill['category'];
      tags?: string[];
    },
  ): Promise<Skill> {
    if (!data.name || data.name.trim() === '') {
      throw new Error('Skill name is required');
    }
    if (!data.content && data.content !== '') {
      throw new Error('Skill content is required');
    }
    assertSkillFieldsSafe({ name: data.name, description: data.description, content: data.content });

    const now = new Date().toISOString();
    const skill: Skill = {
      skillId: generateSkillId(),
      workspaceId,
      name: data.name.trim(),
      description: data.description,
      content: data.content,
      category: data.category,
      tags: data.tags ?? [],
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    };

    await this.skillsCollection.insertOne(skill);
    console.log(`[SkillService] Created skill: ${skill.skillId} (${skill.name}) in ${workspaceId}`);
    return skill;
  }

  /**
   * Get a skill by its ID.
   *
   * @param skillId - Skill identifier
   * @returns The skill document, or null if not found
   */
  async getSkill(skillId: string): Promise<Skill | null> {
    return this.skillsCollection.findOne({ skillId });
  }

  /**
   * List all skills in a workspace, ordered by name.
   *
   * @param workspaceId - Workspace to list skills for
   * @returns Array of skills sorted alphabetically by name
   */
  async listSkills(workspaceId: string): Promise<Skill[]> {
    return this.skillsCollection.find({ workspaceId }).sort({ name: 1 }).toArray();
  }

  /**
   * Update a skill's mutable fields.
   * Only name, description, content, category, and tags can be updated.
   * updatedAt is always refreshed.
   *
   * @param skillId - Skill to update
   * @param data    - Fields to update (all optional)
   * @returns The updated skill document, or null if not found
   * @throws If name is already taken within the workspace (MongoDB unique index)
   */
  async updateSkill(
    skillId: string,
    data: {
      name?: string;
      description?: string;
      content?: string;
      category?: Skill['category'];
      tags?: string[];
    },
  ): Promise<Skill | null> {
    const updates: Partial<Skill> & { updatedAt: string } = {
      updatedAt: new Date().toISOString(),
    };

    if (data.name !== undefined) {
      if (data.name.trim() === '') {
        throw new Error('Skill name cannot be empty');
      }
      updates.name = data.name.trim();
    }
    assertSkillFieldsSafe({ name: data.name, description: data.description, content: data.content });
    if (data.description !== undefined) updates.description = data.description;
    if (data.content !== undefined) updates.content = data.content;
    if (data.category !== undefined) updates.category = data.category;
    if (data.tags !== undefined) updates.tags = data.tags;

    const result = await this.skillsCollection.findOneAndUpdate(
      { skillId },
      { $set: updates },
      { returnDocument: 'after' },
    );

    if (result) {
      console.log(`[SkillService] Updated skill: ${skillId}`);
    }
    return result ?? null;
  }

  /**
   * Delete a skill and all its agent_skill_access entries.
   *
   * @param skillId - Skill to delete
   * @returns true if the skill was deleted, false if not found
   */
  async deleteSkill(skillId: string): Promise<boolean> {
    // Remove all access grants first (cascading delete)
    const accessResult = await this.accessCollection.deleteMany({ skillId });
    console.log(
      `[SkillService] Removed ${accessResult.deletedCount} access entries for skill ${skillId}`,
    );

    const result = await this.skillsCollection.deleteOne({ skillId });
    if (result.deletedCount > 0) {
      console.log(`[SkillService] Deleted skill: ${skillId}`);
      return true;
    }
    return false;
  }

  // ============================================================================
  // AGENT SKILL ACCESS
  // ============================================================================

  /**
   * Grant a skill to an agent (upsert).
   * If the assignment already exists, it is updated with enabled=true.
   *
   * @param agentId     - Agent to assign the skill to
   * @param skillId     - Skill to assign
   * @param workspaceId - Workspace (denormalized for queries)
   * @param grantedBy   - User performing the grant
   * @param order       - Optional injection order (defaults to 0)
   * @returns The created/updated access entry
   * @throws If the skill does not exist
   */
  async grantSkillAccess(
    agentId: string,
    skillId: string,
    workspaceId: string,
    grantedBy: string,
    order: number = 0,
  ): Promise<AgentSkillAccess> {
    // Validate skill exists
    const skill = await this.getSkill(skillId);
    if (!skill) {
      throw new Error(`Skill ${skillId} not found`);
    }

    const access: AgentSkillAccess = {
      agentId,
      skillId,
      workspaceId,
      enabled: true,
      order,
      grantedBy,
      grantedAt: new Date().toISOString(),
    };

    await this.accessCollection.updateOne(
      { agentId, skillId },
      { $set: access },
      { upsert: true },
    );

    console.log(`[SkillService] Granted skill ${skillId} to agent ${agentId}`);
    return access;
  }

  /**
   * Revoke a skill from an agent (removes the access entry).
   *
   * @param agentId - Agent to revoke from
   * @param skillId - Skill to revoke
   * @returns true if the entry was removed, false if it did not exist
   */
  async revokeSkillAccess(agentId: string, skillId: string): Promise<boolean> {
    const result = await this.accessCollection.deleteOne({ agentId, skillId });
    if (result.deletedCount > 0) {
      console.log(`[SkillService] Revoked skill ${skillId} from agent ${agentId}`);
      return true;
    }
    return false;
  }

  /**
   * Get a single agent_skill_access entry.
   * Returns null if the agent does not have the skill granted.
   *
   * @param agentId - Agent to query
   * @param skillId - Skill to query
   * @returns The access entry, or null
   */
  async getAccessEntry(agentId: string, skillId: string): Promise<AgentSkillAccess | null> {
    return this.accessCollection.findOne({ agentId, skillId });
  }

  /**
   * Enable or disable a skill for a specific agent.
   * The assignment remains; only the `enabled` flag changes.
   *
   * @param agentId - Agent whose skill to toggle
   * @param skillId - Skill to toggle
   * @param enabled - New enabled state
   * @returns The updated access entry, or null if not found
   */
  async setSkillEnabled(
    agentId: string,
    skillId: string,
    enabled: boolean,
  ): Promise<AgentSkillAccess | null> {
    const result = await this.accessCollection.findOneAndUpdate(
      { agentId, skillId },
      { $set: { enabled } },
      { returnDocument: 'after' },
    );

    if (result) {
      console.log(
        `[SkillService] Set skill ${skillId} enabled=${enabled} for agent ${agentId}`,
      );
    }
    return result ?? null;
  }

  /**
   * Get all enabled skills for an agent, ordered by `order` field ascending.
   * Only skills with enabled=true are returned.
   *
   * If workspaceId is provided, only skills belonging to that workspace are
   * returned. This ensures skills are scoped to the workspace they were created
   * in, so a superagent only gets the skills relevant to the active workspace.
   *
   * @param agentId     - Agent to get skills for
   * @param workspaceId - Optional workspace filter (recommended — omit only for admin/debug use)
   * @returns Array of skill documents in injection order
   */
  async getAgentSkills(agentId: string, workspaceId?: string): Promise<Skill[]> {
    // Single efficient query: get enabled access entries sorted by order
    const accessQuery: Record<string, unknown> = { agentId, enabled: true };
    if (workspaceId) {
      accessQuery.workspaceId = workspaceId;
    }
    const accessEntries = await this.accessCollection
      .find(accessQuery)
      .sort({ order: 1 })
      .toArray();

    if (accessEntries.length === 0) {
      return [];
    }

    // Batch-fetch all skills (no N+1)
    const skillIds = accessEntries.map((a) => a.skillId);
    const skills = await this.skillsCollection
      .find({ skillId: { $in: skillIds } })
      .toArray();

    // Re-order skills to match the access entry order
    const skillMap = new Map(skills.map((s) => [s.skillId, s]));
    return accessEntries
      .map((a) => skillMap.get(a.skillId))
      .filter((s): s is WithId<Skill> => s !== undefined);
  }

  /**
   * Reorder skills for an agent by updating the `order` field on each access entry.
   * The position in the provided array determines the order (index 0 = first).
   *
   * @param agentId        - Agent whose skill order to update
   * @param orderedSkillIds - Skill IDs in the desired injection order
   */
  async reorderAgentSkills(agentId: string, orderedSkillIds: string[]): Promise<void> {
    if (orderedSkillIds.length === 0) return;

    // Update each entry's order in parallel
    await Promise.all(
      orderedSkillIds.map((skillId, index) =>
        this.accessCollection.updateOne(
          { agentId, skillId },
          { $set: { order: index } },
        ),
      ),
    );

    console.log(
      `[SkillService] Reordered ${orderedSkillIds.length} skills for agent ${agentId}`,
    );
  }

  /**
   * Get all access entries for an agent (both enabled and disabled).
   * Useful for displaying the full list of assigned skills with their state.
   *
   * @param agentId - Agent to query
   * @returns Array of access entries sorted by order
   */
  async getAgentSkillAccess(agentId: string): Promise<AgentSkillAccess[]> {
    return this.accessCollection.find({ agentId }).sort({ order: 1 }).toArray();
  }
}
