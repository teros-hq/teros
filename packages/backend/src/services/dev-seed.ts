/**
 * Dev seed — a functional local user for dev auto-login (LOCAL ONLY).
 *
 * `dev@teros.local` (super, password `devdev1234`) with real, usable state:
 * private + shared workspace, the general assistant (Iria) plus two workspace
 * agents, the system apps plus filesystem/bash, an LLM provider when
 * DEV_SEED_PROVIDER_KEY is set, a project board with tasks (in the private
 * workspace, where the app lands) and a few conversations. Everything goes
 * through the same services signup and the app use, so the account looks like
 * a real one.
 *
 * Idempotent: each artifact is looked up by a stable key (email,
 * owner+name, workspace+mca, user+agent+channel name) and only created when
 * missing; messages and tasks are only added to an empty parent. `reset`
 * deletes the dev user and everything it owns first (DeletionService), and
 * nothing else.
 *
 * Two entry points: `yarn dev:seed` (src/scripts/dev-seed.ts) and the boot hook
 * maybeAutoSeedDevUser, reachable only when dev auto-login passed its prod
 * guards (src/auth/dev-autologin.ts).
 *
 * The seeded messages are UI history (channel_messages) only: an agent doesn't
 * "remember" them if the conversation is continued.
 */

import { readFileSync, rmSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { AgentId, Message, UserId } from "@teros/shared"
import type { Db } from "mongodb"
import { DefaultAgentService } from "../auth/default-agent-service"
import { DEV_AUTOLOGIN_DEFAULT_USER, type DevAutologinState } from "../auth/dev-autologin"
import { IdentityService } from "../auth/identity-service"
import { UserService } from "../auth/user-service"
import { config } from "../config"
import { COLLECTIONS, collection } from "../db"
import { createLogger } from "../lib/logger"
import { AgentProvisioningService } from "./agent-provisioning-service"
import { BoardEventService } from "./board-event-service"
import { BoardService } from "./board-service"
import { ChannelManager } from "./channel-manager"
import { DeletionService } from "./deletion-service"
import { FeatureFlagService } from "./feature-flag-service"
import { McaService } from "./mca-service"
import { ProviderService, type UserProviderRecord } from "./provider-service"
import { VolumeService } from "./volume-service"
import { WorkspaceService } from "./workspace-service"

const log = createLogger("DevSeed")

export const DEV_SEED_EMAIL = DEV_AUTOLOGIN_DEFAULT_USER
export const DEV_SEED_PASSWORD = "devdev1234"
const DEV_SEED_NAME = "Dev"
const SHARED_WORKSPACE_NAME = "Dev Team"
const PROJECT_NAME = "Dev Sandbox"
/** Installed on top of the system apps every agent gets automatically */
const EXTRA_APPS = ["mca.teros.filesystem", "mca.teros.bash"]

/** Same provider the local stacks use; override with DEV_SEED_PROVIDER_* */
const DEFAULT_PROVIDER = {
  type: "openai-compatible",
  name: "NaN Builders",
  baseUrl: "https://api.nan.builders/v1",
  model: "qwen3.6",
}

type Workspace = "private" | "shared"

/** Workspace agents next to Iria, the general assistant signup creates */
const WORKSPACE_AGENTS: Array<{
  workspace: Workspace
  profile: { name: string; fullName: string; role: string; intro: string; avatarUrl: string }
}> = [
  {
    workspace: "shared",
    profile: {
      name: "Ada",
      fullName: "Ada Ramos",
      role: "Software Engineer",
      intro: "Hi, I'm Ada. I write, review and debug code for the Dev Team workspace.",
      avatarUrl: "ada-avatar.jpg",
    },
  },
  {
    workspace: "private",
    profile: {
      name: "Atlas",
      fullName: "Atlas Moreno",
      role: "Research Analyst",
      intro: "I'm Atlas. I dig into topics, compare options and write up what I find.",
      avatarUrl: "atlas-avatar.jpg",
    },
  },
]

const CONVERSATIONS: Array<{
  agent: string
  workspace: Workspace
  name: string
  messages: Array<["user" | "assistant", string]>
}> = [
  {
    agent: "Iria",
    workspace: "private",
    name: "Plan my week",
    messages: [
      [
        "user",
        "Can you help me plan this week? I need to ship the auth fix and prep Thursday's demo.",
      ],
      [
        "assistant",
        "Sure. Monday–Tuesday: finish and review the auth fix. Wednesday: buffer for review feedback and a dry run of the demo. Thursday morning: final demo prep. Want me to put these on the Dev Sandbox board?",
      ],
      ["user", "Yes, and remind me Wednesday about the dry run."],
      [
        "assistant",
        "Done — the tasks are on the board and I'll ping you Wednesday at 10:00 for the dry run.",
      ],
    ],
  },
  {
    agent: "Ada",
    workspace: "shared",
    name: "Login bug triage",
    messages: [
      ["user", "Users get logged out after a page reload on Safari. Where would you start?"],
      [
        "assistant",
        "I'd check the session cookie first: SameSite and Secure flags, and whether the app restores the session before the first request. A reproduction in a private window usually tells which one it is.",
      ],
      ["user", "Private window reproduces it."],
      [
        "assistant",
        "Then it's likely the cookie being dropped as third-party. I'll open a task with the repro steps and a fix proposal.",
      ],
    ],
  },
  {
    agent: "Atlas",
    workspace: "private",
    name: "Research: vector databases",
    messages: [
      ["user", "Compare pgvector, Qdrant and Weaviate for ~5M embeddings."],
      [
        "assistant",
        "Short version: pgvector if you already run Postgres and can live with HNSW build times; Qdrant for the best filtered-search latency per dollar; Weaviate if you want hybrid search and modules out of the box. I can write up a full comparison table.",
      ],
    ],
  },
]

const SEED_TASKS: Array<{
  column: string
  title: string
  instructions: string
  priority?: "low" | "high"
}> = [
  {
    column: "backlog",
    title: "Write onboarding guide",
    instructions: "Draft a short guide for new teammates: setup, conventions, where things live.",
  },
  {
    column: "backlog",
    title: "Evaluate vector database options",
    instructions:
      "Compare pgvector, Qdrant and Weaviate for ~5M embeddings; summarise cost and latency.",
    priority: "low",
  },
  {
    column: "todo",
    title: "Prepare Thursday demo",
    instructions: "Script the demo flow, seed demo data and do a dry run on Wednesday.",
    priority: "high",
  },
  {
    column: "todo",
    title: "Add dark mode to settings",
    instructions: "Expose the theme toggle in Settings → Appearance and persist the choice.",
  },
  {
    column: "in_progress",
    title: "Fix Safari logout on reload",
    instructions:
      "Session cookie is dropped in private windows; check SameSite/Secure and restore order.",
    priority: "high",
  },
  {
    column: "review",
    title: "Refactor billing webhook handler",
    instructions: "Split parsing from side effects and add idempotency on event id.",
  },
  {
    column: "done",
    title: "Set up CI pipeline",
    instructions: "Lint, typecheck and unit tests on every PR.",
  },
]

export interface DevSeedOptions {
  /** Delete the dev user and everything it owns before seeding */
  reset?: boolean
  /** Defaults to process.env (DEV_SEED_PROVIDER_KEY / _TYPE / _NAME / _BASE_URL / _MODEL) */
  env?: Record<string, string | undefined>
  /** Where workspace volumes live; defaults to config.volumes.basePath */
  volumesBasePath?: string
}

export interface DevSeedReport {
  userId: string
  createdUser: boolean
  workspaces: number
  agents: number
  apps: number
  provider: "configured" | "missing-key"
  tasks: number
  conversations: number
}

interface Services {
  users: UserService
  identities: IdentityService
  workspaces: WorkspaceService
  mca: McaService
  provisioning: AgentProvisioningService
  defaultAgent: DefaultAgentService
  providers: ProviderService
  boards: BoardService
  channels: ChannelManager
}

/** One seeding run: the database, its services and the dev user */
interface Ctx {
  db: Db
  s: Services
  userId: string
  workspaceIds: Record<Workspace, string>
}

/** The services signup uses, wired the way bootstrapServer wires them. */
function createServices(db: Db, volumesBasePath: string): Services {
  const volumes = new VolumeService(db, {
    basePath: volumesBasePath,
    defaultWorkspaceQuota: config.volumes.defaultWorkspaceQuota,
  })
  const workspaces = new WorkspaceService(db, volumes)
  const featureFlags = new FeatureFlagService(db)
  const providers = new ProviderService(db)
  const mca = new McaService(db, { workspaceService: workspaces, volumeService: volumes })
  const provisioning = new AgentProvisioningService(db, mca)

  const users = new UserService(db)
  users.setWorkspaceService(workspaces)
  users.setProviderService(providers)
  users.setFeatureFlagService(featureFlags)

  const defaultAgent = new DefaultAgentService(db)
  defaultAgent.setProvisioningService(provisioning)

  return {
    users,
    identities: new IdentityService(db),
    workspaces,
    mca,
    provisioning,
    defaultAgent,
    providers,
    boards: new BoardService(db, undefined, new BoardEventService(db)),
    channels: new ChannelManager(db, providers),
  }
}

/** Seed (or top up) the dev user. Safe to run any number of times. */
export async function seedDevUser(db: Db, options: DevSeedOptions = {}): Promise<DevSeedReport> {
  const volumesBasePath = options.volumesBasePath ?? config.volumes.basePath
  if (options.reset) await resetDevUser(db, volumesBasePath)

  await ensureMcaCatalog(db)
  const s = createServices(db, volumesBasePath)
  const { userId, created } = await ensureUser(s)
  const ctx: Ctx = { db, s, userId, workspaceIds: await ensureWorkspaces(db, s, userId) }

  const agents = await ensureAgents(ctx)
  await ensureApps(ctx, agents)
  const provider = await ensureProvider(ctx, [...agents.values()], options.env ?? process.env)
  const tasks = await ensureBoard(ctx)
  const conversations = await ensureConversations(ctx, agents)

  const apps = await collection(db, COLLECTIONS.apps).countDocuments({
    ownerId: { $in: Object.values(ctx.workspaceIds) },
    status: "active",
  })
  return {
    userId,
    createdUser: created,
    workspaces: 2,
    agents: agents.size,
    apps,
    provider,
    tasks,
    conversations,
  }
}

/**
 * Boot hook: with dev auto-login on (prod guards already passed), seed the
 * default dev user when it doesn't exist yet. A TEROS_DEV_USER that names
 * another, missing account is never seeded — just reported.
 */
export async function maybeAutoSeedDevUser(
  db: Db,
  state: DevAutologinState,
  options: Pick<DevSeedOptions, "volumesBasePath"> = {},
): Promise<"disabled" | "exists" | "seeded" | "missing"> {
  if (!state.enabled) return "disabled"
  const email = state.userEmail
  const existing = await collection(db, COLLECTIONS.users).findOne({
    "profile.email": email,
    deletedAt: { $exists: false },
  })
  if (existing) return "exists"
  if (email !== DEV_SEED_EMAIL) {
    log.warn(`⚠ DEV AUTOLOGIN: user ${email} does not exist — create it or unset TEROS_DEV_USER`)
    return "missing"
  }
  await seedDevUser(db, options)
  log.warn(`⚠ DEV AUTOLOGIN: seeded ${DEV_SEED_EMAIL}`)
  return "seeded"
}

/** Delete the dev user and what it owns; the catalog and other users are untouched. */
async function resetDevUser(db: Db, volumesBasePath: string): Promise<void> {
  const users = collection(db, COLLECTIONS.users)
  const user = await users.findOne({ "profile.email": DEV_SEED_EMAIL })
  if (!user) return
  const userId = user.userId as string

  const volumeIds = (
    await collection(db, COLLECTIONS.workspaces)
      .find({ ownerId: userId }, { projection: { volumeId: 1 } })
      .toArray()
  ).map((w) => w.volumeId as string)
  const volumes = collection(db, COLLECTIONS.volumes)
  const hostPaths = (
    await volumes.find({ volumeId: { $in: volumeIds } }, { projection: { hostPath: 1 } }).toArray()
  ).map((v) => v.hostPath as string | undefined)

  const deletion = new DeletionService(db)
  await deletion.deleteUser(userId, "dev-seed", "dev-seed.reset")
  // Global agents stored with workspaceId null slip past the account cascade
  for (const agent of await collection(db, COLLECTIONS.agents)
    .find({ ownerId: userId })
    .toArray()) {
    await deletion.deleteAgent(agent.agentId as string, "dev-seed", "dev-seed.reset")
  }
  await volumes.deleteMany({ volumeId: { $in: volumeIds } })
  await collection(db, COLLECTIONS.billingSubscriptions).deleteMany({ userId })
  // A dev account leaves no tombstone: drop the pseudonymised users document too
  await users.deleteOne({ userId })

  const base = resolve(volumesBasePath) + sep
  for (const hostPath of hostPaths) {
    if (hostPath && resolve(hostPath).startsWith(base))
      rmSync(hostPath, { recursive: true, force: true })
  }
  log.info({ userId }, `Reset ${DEV_SEED_EMAIL}`)
}

/** Agents only get apps the catalog knows about; a fresh db has none until synced. */
async function ensureMcaCatalog(db: Db): Promise<void> {
  if (await collection(db, COLLECTIONS.mcaCatalog).countDocuments({}, { limit: 1 })) return
  log.info("mca_catalog is empty — syncing it from mcas/*/manifest.json")
  const { syncMcas } = await import("../scripts/sync-mcas")
  await syncMcas(false, db)
}

async function ensureUser(s: Services): Promise<{ userId: string; created: boolean }> {
  let user = await s.users.getByEmail(DEV_SEED_EMAIL)
  const created = !user
  if (!user) {
    // Private workspace + volume, billing subscription and the Teros provider come with it
    user = await s.users.createUser({
      email: DEV_SEED_EMAIL,
      displayName: DEV_SEED_NAME,
      emailVerified: true,
      role: "super",
    })
    log.info({ userId: user.userId }, `Created ${DEV_SEED_EMAIL}`)
  } else if (user.role !== "super") {
    await s.users.updateRole(user.userId, "super")
  }
  const userId = user.userId
  if ((await s.identities.getByUserId(userId)).length === 0) {
    await s.identities.createPasswordIdentity({
      userId,
      email: DEV_SEED_EMAIL,
      password: DEV_SEED_PASSWORD,
    })
  }
  await s.users.grantAccess(userId)
  await s.users.acceptTerms(userId)
  await s.users.completeOnboarding(userId)
  const latestChangelog = latestChangelogId()
  if (latestChangelog && !user.lastChangelogSeen)
    await s.users.updateLastChangelogSeen(userId, latestChangelog)
  return { userId, created }
}

/** Newest entry of the app's changelog, so the "What's New" carousel doesn't cover the landing */
function latestChangelogId(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const path = join(here, "../../../app/src/changelog/changelog.json")
    const entries = JSON.parse(readFileSync(path, "utf-8")).entries as Array<{ id: string }>
    return entries.at(-1)?.id ?? null
  } catch {
    return null
  }
}

async function ensureWorkspaces(
  db: Db,
  s: Services,
  userId: string,
): Promise<Record<Workspace, string>> {
  const privateWs = await s.workspaces.createPrivateWorkspace(userId)
  const sharedWs =
    (await collection(db, COLLECTIONS.workspaces).findOne({
      ownerId: userId,
      type: "shared",
      name: SHARED_WORKSPACE_NAME,
      status: "active",
    })) ??
    (await s.workspaces.createWorkspace(
      userId,
      {
        name: SHARED_WORKSPACE_NAME,
        description: "Shared workspace seeded for local development",
        type: "shared",
      },
      { skipBillingGate: true },
    ))
  return { private: privateWs.workspaceId, shared: sharedWs.workspaceId as string }
}

/** Agent name → agentId */
async function ensureAgents({ db, s, userId, workspaceIds }: Ctx): Promise<Map<string, string>> {
  const agentsColl = collection(db, COLLECTIONS.agents)
  // The general assistant is exactly the one signup creates (global, super-agent core)
  await s.defaultAgent.createDefaultAgentIfNeeded(userId)
  const iria = await agentsColl.findOne({ ownerId: userId, name: "Iria", status: "active" })
  if (!iria) throw new Error("dev seed: the default agent was not created")
  const agents = new Map([["Iria", iria.agentId as string]])

  for (const { workspace, profile } of WORKSPACE_AGENTS) {
    const workspaceId = workspaceIds[workspace]
    const existing = await agentsColl.findOne({
      ownerId: userId,
      workspaceId,
      name: profile.name,
      status: "active",
    })
    const agentId =
      (existing?.agentId as string | undefined) ??
      (await s.provisioning.createAgentFromCore({ ownerId: userId, workspaceId, profile })).agentId
    agents.set(profile.name, agentId)
  }
  return agents
}

/**
 * System apps for the global agent in both workspaces (the server's
 * workspace-created hook does this), then filesystem + bash in each workspace
 * for its agent and the global one.
 */
async function ensureApps(ctx: Ctx, agents: Map<string, string>): Promise<void> {
  const { db, s, userId, workspaceIds } = ctx
  const iria = agents.get("Iria") as string
  for (const workspaceId of Object.values(workspaceIds)) {
    await s.mca.ensureProvisionedApps(iria, workspaceId)
  }
  for (const { workspace, profile } of WORKSPACE_AGENTS) {
    const workspaceId = workspaceIds[workspace]
    for (const mcaId of EXTRA_APPS) {
      const existing = await collection(db, COLLECTIONS.apps).findOne({
        ownerId: workspaceId,
        mcaId,
        status: "active",
      })
      let appId = existing?.appId as string | undefined
      if (!appId) {
        if (!(await collection(db, COLLECTIONS.mcaCatalog).findOne({ mcaId, status: "active" }))) {
          log.warn(`${mcaId} is not in the catalog — skipped`)
          continue
        }
        appId = (await s.mca.createWorkspaceApp(workspaceId, mcaId, "", userId)).appId
      }
      await s.mca.grantAccess({
        agentId: agents.get(profile.name) as string,
        appId,
        grantedBy: userId,
      })
      await s.mca.grantAccessToUserSuperagents(userId, appId)
    }
  }
}

function providerSettings(env: Record<string, string | undefined>) {
  const providerType = (env.DEV_SEED_PROVIDER_TYPE?.trim() ||
    DEFAULT_PROVIDER.type) as UserProviderRecord["providerType"]
  const isDefaultType = providerType === DEFAULT_PROVIDER.type
  return {
    apiKey: env.DEV_SEED_PROVIDER_KEY?.trim(),
    providerType,
    displayName:
      env.DEV_SEED_PROVIDER_NAME?.trim() || (isDefaultType ? DEFAULT_PROVIDER.name : providerType),
    model: env.DEV_SEED_PROVIDER_MODEL?.trim() || (isDefaultType ? DEFAULT_PROVIDER.model : ""),
    baseUrl: env.DEV_SEED_PROVIDER_BASE_URL?.trim() || DEFAULT_PROVIDER.baseUrl,
  }
}

/**
 * Wire an LLM provider so the agents answer. The key only ever goes through
 * addProvider/setProviderSecrets (encrypted per user) — never logged.
 */
async function ensureProvider(
  { db, s, userId }: Ctx,
  agentIds: string[],
  env: Record<string, string | undefined>,
): Promise<"configured" | "missing-key"> {
  const { apiKey, providerType, displayName, model, baseUrl } = providerSettings(env)
  const coll = collection<UserProviderRecord>(db, COLLECTIONS.userProviders)
  const existing = await coll.findOne({ userId, providerType, displayName })
  if (!apiKey && !existing) {
    console.log(
      "[dev-seed] DEV_SEED_PROVIDER_KEY is not set — agents won't answer until a provider is configured (re-run with it, or add one in Settings → Providers)",
    )
    return "missing-key"
  }

  let providerId = existing?.providerId
  if (!providerId) {
    const providerConfig =
      providerType === "openai-compatible" ? { baseUrl, ...(model && { model }) } : {}
    providerId = (
      await s.providers.addProvider(userId, {
        providerType,
        displayName,
        config: providerConfig,
        auth: { apiKey },
      })
    ).providerId
  } else if (apiKey) {
    await s.providers.setProviderSecrets(userId, providerId, { apiKey })
  }

  const test = await s.providers.testProvider(providerId)
  if (!test.ok || !test.models?.length) {
    log.warn(
      { providerId, error: test.error },
      "dev seed: provider test failed — agents may not answer",
    )
    return "configured"
  }
  const chosen =
    test.models.find((m) => m.modelString === model || m.modelId === model) ?? test.models[0]
  await coll.updateOne({ providerId }, { $set: { defaultModelId: chosen.modelId } })
  // What agent.set-providers + agent.set-preferred-provider store
  await collection(db, COLLECTIONS.agents).updateMany(
    { agentId: { $in: agentIds } },
    {
      $set: {
        availableProviders: [providerId],
        selectedProviderId: providerId,
        preferredProviderId: providerId,
        selectedModelId: chosen.modelId,
        updatedAt: new Date().toISOString(),
      },
    },
  )
  return "configured"
}

async function ensureBoard({ db, s, userId, workspaceIds }: Ctx): Promise<number> {
  // The private workspace is where the app lands after sign-in
  const workspaceId = workspaceIds.private
  const existing = await collection(db, COLLECTIONS.projects).findOne({
    workspaceId,
    name: PROJECT_NAME,
    status: "active",
  })
  const boardId = existing
    ? (existing.boardId as string)
    : (
        await s.boards.createProject(workspaceId, userId, {
          name: PROJECT_NAME,
          description: "Seeded board for local development",
        })
      ).board.boardId
  const count = await collection(db, COLLECTIONS.tasks).countDocuments({ boardId })
  if (count > 0) return count

  const board = await collection(db, COLLECTIONS.boards).findOne({ boardId })
  const columns = (board?.columns ?? []) as Array<{ slug: string; columnId: string }>
  const columnBySlug = new Map(columns.map((c) => [c.slug, c.columnId]))
  const created = await s.boards.batchCreateTasks(
    boardId,
    userId,
    SEED_TASKS.map((t) => ({
      title: t.title,
      instructions: t.instructions,
      priority: t.priority,
      columnId: columnBySlug.get(t.column),
    })),
  )
  return created.length
}

async function ensureConversations(
  { db, s, userId, workspaceIds }: Ctx,
  agents: Map<string, string>,
): Promise<number> {
  const channels = collection(db, COLLECTIONS.channels)
  const messages = collection(db, COLLECTIONS.channelMessages)
  const userSender = (await s.channels.getUserSender(userId)) ?? undefined

  // Oldest first, a few minutes apart, all in the past
  let clock = Date.now() - 60 * 60 * 1000
  for (const conv of CONVERSATIONS) {
    const agentId = agents.get(conv.agent) as string
    const existing = await channels.findOne({
      userId,
      agentId,
      "metadata.name": conv.name,
      status: "active",
    })
    const channelId =
      (existing?.channelId as string | undefined) ??
      (
        await s.channels.createChannel(
          userId as UserId,
          agentId as AgentId,
          { name: conv.name },
          {
            workspaceId: workspaceIds[conv.workspace],
          },
        )
      ).channelId
    if ((await messages.countDocuments({ channelId })) > 0) continue

    const agentSender = (await s.channels.getAgentSender(agentId)) ?? undefined
    for (const [role, text] of conv.messages) {
      clock += 3 * 60 * 1000
      const message = {
        messageId: s.channels.createMessageId(),
        channelId,
        role,
        ...(role === "user" ? { userId, sender: userSender } : { agentId, sender: agentSender }),
        content: { type: "text", text },
        timestamp: new Date(clock).toISOString(),
      } as Message
      await s.channels.saveMessage(message)
    }
  }
  return CONVERSATIONS.length
}
