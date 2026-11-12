/**
 * VocabularyResolver — Dynamic per-user vocabulary for STT providers
 *
 * Queries MongoDB for user-specific entities (workspaces, projects, agents,
 * skills, apps) and combines them with the static vocabulary from
 * .secrets/system/transcription.json. Results are cached per-user with a
 * configurable TTL (default 5 minutes) to avoid hitting the database on
 * every transcription.
 *
 * Term limits:
 * - ElevenLabs Scribe: up to 1,000 keyterms (max 50 chars each)
 * - OpenAI Whisper: ~224 tokens for the prompt parameter
 *
 * When the combined vocabulary exceeds the limit, terms are prioritized:
 *   1. Static config vocabulary (platform terms like "Teros", "MCA")
 *   2. Agent names (most likely to be spoken)
 *   3. Project names
 *   4. Workspace names
 *   5. Skill names
 *   6. App names
 */

import type { Db } from "mongodb"
import type { SecretsManager } from "../../secrets/secrets-manager"
import { TranscriptionProviderFactory } from "./TranscriptionProviderFactory"

/** Provider-specific term limits */
const MAX_TERMS_SCRIBE = 1000
const MAX_TERMS_WHISPER = 150 // ~224 tokens, but we leave room for the comma separators

/** Cache TTL in milliseconds (default: 5 minutes) */
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000

interface CacheEntry {
  terms: string[]
  expiresAt: number
}

/**
 * Resolve dynamic vocabulary terms for a user by querying MongoDB.
 * Returns an ordered list of terms with static vocabulary first,
 * followed by user-specific entities in priority order.
 */
export class VocabularyResolver {
  private db: Db
  private secretsManager: SecretsManager
  private cacheTtlMs: number
  private cache: Map<string, CacheEntry> = new Map()

  constructor(db: Db, secretsManager: SecretsManager, cacheTtlMs?: number) {
    this.db = db
    this.secretsManager = secretsManager
    this.cacheTtlMs = cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  }

  /**
   * Get the combined vocabulary (static + dynamic) for a user.
   * Results are cached per-user for cacheTtlMs.
   *
   * @param userId - The user ID to resolve vocabulary for
   * @param maxTerms - Maximum number of terms to return (provider-specific)
   * @param workspaceId - Current workspace ID. Agents, projects, skills and apps
   *                      are scoped to this workspace. Workspace names are NOT scoped
   *                      (user can reference any of their workspaces by name).
   * @returns Array of vocabulary terms, deduplicated and prioritized
   */
  async resolveVocabulary(userId: string, maxTerms?: number, workspaceId?: string): Promise<string[]> {
    const limit = maxTerms ?? MAX_TERMS_SCRIBE

    // Cache key includes workspaceId so different workspaces get different caches
    const cacheKey = `${userId}:${workspaceId ?? "none"}`
    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.terms.slice(0, limit)
    }

    // 1. Static vocabulary from config (highest priority)
    const staticVocab = TranscriptionProviderFactory.getDefaultVocabulary(this.secretsManager) ?? []

    // 2. Query MongoDB for user-specific entities
    // All dynamic entities are scoped to the current workspace only
    const [agentNames, projectNames, workspaceNames, skillNames, appNames] = await Promise.all([
      this.getAgentNamesForWorkspace(workspaceId),
      this.getProjectNamesForWorkspace(workspaceId),
      this.getWorkspaceNames(userId),
      this.getSkillNamesForWorkspace(workspaceId),
      this.getAppNamesForWorkspace(workspaceId),
    ])

    // 3. Combine with priority ordering, deduplicate (case-insensitive)
    const seen = new Set<string>()
    const allTerms: string[] = []

    const addTerms = (terms: string[]) => {
      for (const term of terms) {
        const trimmed = term.trim()
        if (trimmed.length === 0 || trimmed.length > 50) continue
        // ElevenLabs Scribe rejects keywords with more than 4 spaces (5+ words)
        const spaceCount = (trimmed.match(/ /g) || []).length
        if (spaceCount > 4) continue
        const lower = trimmed.toLowerCase()
        if (seen.has(lower)) continue
        seen.add(lower)
        allTerms.push(trimmed)
      }
    }

    // Priority order: static → agents → projects → workspaces → skills → apps
    addTerms(staticVocab)
    addTerms(agentNames)
    addTerms(projectNames)
    addTerms(workspaceNames)
    addTerms(skillNames)
    addTerms(appNames)

    // Cache the full list (before limit), return limited slice
    this.cache.set(cacheKey, {
      terms: allTerms,
      expiresAt: Date.now() + this.cacheTtlMs,
    })

    return allTerms.slice(0, limit)
  }

  /**
   * Get the max terms for a given provider type.
   */
  static getMaxTermsForProvider(provider: "whisper" | "elevenlabs"): number {
    return provider === "whisper" ? MAX_TERMS_WHISPER : MAX_TERMS_SCRIBE
  }

  /**
   * Clear the cache for a specific user, or all users if no userId given.
   */
  invalidateCache(userId?: string, workspaceId?: string): void {
    if (userId && workspaceId) {
      this.cache.delete(`${userId}:${workspaceId}`)
    } else if (userId) {
      // Clear all workspace caches for this user
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${userId}:`)) this.cache.delete(key)
      }
    } else {
      this.cache.clear()
    }
  }

  // ─── Private query methods ───────────────────────────────────────────

  /**
   * Get workspace names for the user (owner or member).
   * These are NOT scoped to the current workspace — we want all workspace names
   * so the user can reference any of them by name in voice messages.
   */
  private async getWorkspaceNames(userId: string): Promise<string[]> {
    const workspaces = await this.db
      .collection("workspaces")
      .find(
        {
          $or: [{ ownerId: userId }, { "members.userId": userId }],
        },
        { projection: { name: 1 } },
      )
      .toArray()

    return workspaces.map((w) => w.name).filter((n): n is string => typeof n === "string" && n.length > 0)
  }

  /**
   * Get active agent names (name only, not fullName) from a workspace.
   */
  private async getAgentNamesForWorkspace(workspaceId?: string): Promise<string[]> {
    if (!workspaceId) return []
    const agents = await this.db
      .collection("agents")
      .find(
        { workspaceId, status: "active" },
        { projection: { name: 1 } },
      )
      .toArray()
    return agents.map((a) => a.name).filter((n): n is string => typeof n === "string" && n.length > 0)
  }

  /**
   * Get active project names from a specific workspace.
   */
  private async getProjectNamesForWorkspace(workspaceId?: string): Promise<string[]> {
    if (!workspaceId) return []
    const projects = await this.db
      .collection("projects")
      .find(
        { workspaceId, status: "active" },
        { projection: { name: 1 } },
      )
      .toArray()
    return projects.map((p) => p.name).filter((n): n is string => typeof n === "string" && n.length > 0)
  }

  /**
   * Get skill names from a specific workspace.
   */
  private async getSkillNamesForWorkspace(workspaceId?: string): Promise<string[]> {
    if (!workspaceId) return []
    const skills = await this.db
      .collection("skills")
      .find(
        { workspaceId },
        { projection: { name: 1 } },
      )
      .toArray()

    return skills.map((s) => s.name).filter((n): n is string => typeof n === "string" && n.length > 0)
  }

  /**
   * Get installed app names from a specific workspace.
   */
  private async getAppNamesForWorkspace(workspaceId?: string): Promise<string[]> {
    if (!workspaceId) return []
    const apps = await this.db
      .collection("apps")
      .find(
        { ownerId: workspaceId },
        { projection: { name: 1 } },
      )
      .toArray()

    return apps.map((a) => a.name).filter((n): n is string => typeof n === "string" && n.length > 0)
  }
}
