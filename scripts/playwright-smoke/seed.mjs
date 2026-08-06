/**
 * Seed two test users for the TER-304 Playwright smoke test.
 * Idempotent: if users already exist, just prints their info.
 *
 * Run from the worktree root so node_modules resolves bcrypt/mongodb:
 *   cd /private/tmp/ter-304-navbar-sync && node /tmp/seed-ter304-test-users.mjs
 */
import bcrypt from 'bcrypt'
import { MongoClient, ObjectId } from 'mongodb'
import { randomBytes } from 'node:crypto'

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017'
const DB_NAME = process.env.MONGODB_DATABASE || 'teros'

const USERS = [
  { email: 'playwright1@test.com', displayName: 'Play One', password: 'test1234' },
  { email: 'playwright2@test.com', displayName: 'Play Two', password: 'test1234' },
  // user3 is a SUPER admin — needed by core-rollout.spec.ts (create-core,
  // set-rollout and core-rollout-apply are super-only). Kept separate so the
  // other specs' user1/user2 stay plain 'user' (no permission drift).
  { email: 'playwright3@test.com', displayName: 'Play Three Super', password: 'test1234', role: 'super' },
]

const RESET = process.env.RESET === '1'

function genId(prefix) {
  return `${prefix}_${randomBytes(8).toString('hex')}`
}

const client = new MongoClient(MONGO_URI)
await client.connect()
const db = client.db(DB_NAME)
console.log(`Connected to ${MONGO_URI}/${DB_NAME}`)

const users = db.collection('users')
const identities = db.collection('user_identities')
const workspaces = db.collection('workspaces')
const volumes = db.collection('volumes')
const agents = db.collection('agents')
const agentCores = db.collection('agent_cores')
const channels = db.collection('channels')
const projects = db.collection('projects')
const boards = db.collection('boards')
const tasks = db.collection('tasks')
const apps = db.collection('apps')
const mcaCatalog = db.collection('mca_catalog')

if (RESET) {
  console.log('🧹 RESET=1 → wiping playwright test artifacts')
  const userIds = (await users.find({ 'profile.email': { $regex: '^playwright[123]@test.com$' } }).toArray()).map((u) => u.userId)
  await users.deleteMany({ 'profile.email': { $regex: '^playwright[123]@test.com$' } })
  await identities.deleteMany({ email: { $regex: '^playwright[123]@test.com$' } })
  if (userIds.length) {
    await workspaces.deleteMany({ ownerId: { $in: userIds } })
    await agents.deleteMany({ ownerId: { $in: userIds } })
    await channels.deleteMany({ userId: { $in: userIds } })
    const projectsToDelete = await projects.find({ name: { $regex: '^Pw' } }).toArray()
    const projectIds = projectsToDelete.map((p) => p.projectId)
    await projects.deleteMany({ projectId: { $in: projectIds } })
    await boards.deleteMany({ projectId: { $in: projectIds } })
    await tasks.deleteMany({ projectId: { $in: projectIds } })
    await apps.deleteMany({ name: { $regex: '^pw-' } })
  }
  console.log(`  removed ${userIds.length} user(s) + dependents`)
}

// Ensure a minimal agent core exists so we can attach default agents to it.
// modelId es OBLIGATORIO: sin él, getEffectiveAgentConfig lanza "Could not resolve config for
// agent" y el turno termina sin llamar al LLM → todos los specs @llm fallan (incident: el @llm
// env quedaba roto). teros-kimi-k2.6 es el modelo del provider `teros` (Kimi) que
// ensureTerosProvider asigna al agente. Upsert (no insert-if-absent) para reparar cores ya
// sembrados sin modelId.
const TEST_CORE_ID = 'core:pw-test'
await agentCores.updateOne(
  { coreId: TEST_CORE_ID },
  {
    $set: {
      coreVersion: '1.0.0',
      name: 'Pw Test Core',
      avatarUrl: 'iria.png',
      personality: ['friendly', 'helpful'],
      capabilities: ['chat'],
      baseSystemPrompt: 'You are a helpful test assistant.',
      modelId: 'teros-kimi-k2.6',
      updatedAt: new Date().toISOString(),
    },
    $setOnInsert: { createdAt: new Date().toISOString() },
  },
  { upsert: true },
)
console.log(`✓ Ensured agent core ${TEST_CORE_ID} (modelId teros-kimi-k2.6)`)

const results = []
for (const u of USERS) {
  const email = u.email.toLowerCase()
  const wantRole = u.role || 'user'
  const existing = await users.findOne({ 'profile.email': email })
  if (existing) {
    // Keep the role in sync — user3 must be super even if it was seeded earlier
    // as a plain user (idempotent re-seeds).
    if (existing.role !== wantRole) {
      await users.updateOne({ userId: existing.userId }, { $set: { role: wantRole } })
      console.log(`✓ ${email} already exists (userId=${existing.userId}) — role → ${wantRole}`)
    } else {
      console.log(`✓ ${email} already exists (userId=${existing.userId}, role=${wantRole})`)
    }
    results.push({ email, userId: existing.userId, password: u.password, privateWorkspaceId: existing.privateWorkspaceId })
    continue
  }

  const userId = genId('user')
  const now = new Date()

  // Create private workspace + volume first so we can wire privateWorkspaceId.
  const volumeId = genId('vol_user')
  await volumes.insertOne({
    volumeId,
    name: `${u.displayName} Personal`,
    type: 'user',
    ownerId: userId,
    members: [],
    quotaBytes: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  })

  const workspaceId = genId('work')
  await workspaces.insertOne({
    workspaceId,
    name: 'Private',
    type: 'private',
    ownerId: userId,
    volumeId,
    members: [],
    settings: {},
    status: 'active',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  })

  // User
  await users.insertOne({
    userId,
    profile: {
      email,
      displayName: u.displayName,
      avatarUrl: null,
    },
    privateWorkspaceId: workspaceId,
    accessGranted: true,
    emailVerified: true,
    onboardingCompletedAt: now,
    status: 'active',
    role: wantRole,
    createdAt: now,
    updatedAt: now,
  })

  // Password identity (bcrypt rounds=12 to match BCRYPT_ROUNDS in identity-service)
  const passwordHash = await bcrypt.hash(u.password, 12)
  await identities.insertOne({
    _id: new ObjectId(),
    userId,
    type: 'password',
    providerUserId: email,
    email,
    data: {
      passwordHash,
      failedAttempts: 0,
      lastPasswordChangeAt: now,
    },
    status: 'active',
    createdAt: now,
    updatedAt: now,
  })

  // Default global agent (so the user can start conversations from the modal)
  const agentId = genId('agent')
  await agents.insertOne({
    agentId,
    coreId: TEST_CORE_ID,
    ownerId: userId,
    workspaceId: null,
    name: 'PwBot',
    fullName: 'Playwright Bot',
    role: 'test assistant',
    intro: 'I am a test agent for Playwright smoke runs.',
    avatarUrl: 'iria.png',
    availableProviders: [],
    selectedProviderId: null,
    selectedModelId: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  })

  console.log(`✅ Created ${email} (userId=${userId}, privateWorkspace=${workspaceId}, agent=${agentId})`)
  results.push({ email, userId, password: u.password, privateWorkspaceId: workspaceId, agentId })
}

// Create a shared workspace owned by playwright1, with playwright2 as member.
// Used by the cross-user test.
const userA = results[0]
const userB = results[1]
let sharedWs = await workspaces.findOne({ ownerId: userA?.userId, type: 'shared', name: 'Pw Shared Test' })
if (!sharedWs && userA && userB) {
  const sharedVolumeId = genId('vol_work')
  const now = new Date()
  await volumes.insertOne({
    volumeId: sharedVolumeId,
    name: 'Pw Shared Volume',
    type: 'workspace',
    ownerId: userA.userId,
    members: [{ userId: userB.userId, role: 'write', addedAt: now.toISOString(), addedBy: userA.userId }],
    quotaBytes: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  })
  const sharedWsId = genId('work')
  await workspaces.insertOne({
    workspaceId: sharedWsId,
    name: 'Pw Shared Test',
    type: 'shared',
    ownerId: userA.userId,
    volumeId: sharedVolumeId,
    members: [{ userId: userB.userId, role: 'write', addedAt: now.toISOString(), addedBy: userA.userId }],
    settings: {},
    status: 'active',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  })
  console.log(`✅ Created shared workspace: ${sharedWsId} (owner=${userA.userId}, member=${userB.userId})`)
  sharedWs = { workspaceId: sharedWsId }
}

await client.close()
console.log('\nReady. Credentials:')
for (const r of results) console.log(`  ${r.email} / ${r.password}`)
if (sharedWs) console.log(`  Shared workspace: ${sharedWs.workspaceId}`)

// Persist test fixture IDs so the Playwright script can read them
import { writeFileSync } from 'node:fs'
const fixture = {
  user1: { email: USERS[0].email, userId: results[0]?.userId, privateWorkspaceId: results[0]?.privateWorkspaceId, agentId: results[0]?.agentId },
  user2: { email: USERS[1].email, userId: results[1]?.userId, privateWorkspaceId: results[1]?.privateWorkspaceId, agentId: results[1]?.agentId },
  user3: { email: USERS[2].email, userId: results[2]?.userId, privateWorkspaceId: results[2]?.privateWorkspaceId },
  sharedWorkspaceId: sharedWs?.workspaceId,
}
writeFileSync('/tmp/ter304-fixtures.json', JSON.stringify(fixture, null, 2))
console.log(`  Fixtures: /tmp/ter304-fixtures.json`)
