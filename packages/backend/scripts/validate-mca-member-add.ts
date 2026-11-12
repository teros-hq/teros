/**
 * Fase 1 validation harness — exercises the NEW handleWorkspaceMemberAdd
 * (MCA HTTP path) directly against the live RAW database with mock res.
 *
 * Workspace under test: work_bb02eff683ac5b89 (test-invite-repro, authorized
 * by Pablo — do NOT archive/delete). Owner: user_0000000000000000 (Pablo).
 *
 * Covers the 6 cases from the board task:
 *   1. Non-existent email → 201 pending + invitation token inv_...
 *   2. Existing email (pablo@example.agentapps.tech) → 201 active + real userId + volume
 *   3. Invalid email → 400
 *   4. Invalid role (owner) → 400
 *   5. Repeat pending invite → idempotent, no duplicate
 *   6. Non-admin inviter → 403
 *
 * Run: cd packages/backend && npx tsx scripts/validate-mca-member-add.ts
 * Cleanup: --clean flag removes test members and exits.
 */

import type { ServerResponse } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MongoClient, type Db } from 'mongodb';
import { config } from '../src/config';
import { VolumeService } from '../src/services/volume-service';
import { WorkspaceService } from '../src/services/workspace-service';
import { UserService } from '../src/auth/user-service';
import { secrets } from '../src/secrets/secrets-manager';
import { handleWorkspaceMemberAdd } from '../src/routes/mca-resources-handlers';

const TEST_WORKSPACE_ID = 'work_bb02eff683ac5b89';
const OWNER_USER_ID = 'user_0000000000000000'; // Pablo — workspace owner
const PABLO_EMAIL = 'pablo@example.agentapps.tech'; // existing account (owner himself)
const NON_EXISTENT_EMAIL = 'invite-fase1-test@example.com'; // no account
const NON_ADMIN_USER_ID = 'user_491d53f461d56b8a'; // Alice — no membership here

// ─── mock res (minimal ServerResponse) ──────────────────────────────────────
interface MockRes {
  statusCode: number;
  body: any;
}
function mockRes(): { res: ServerResponse; state: MockRes } {
  const state: MockRes = { statusCode: 0, body: null };
  const res = {
    writeHead(status: number) {
      state.statusCode = status;
    },
    end(chunk?: any) {
      state.body = chunk ? JSON.parse(chunk) : null;
    },
  } as unknown as ServerResponse;
  return { res, state };
}

async function callHandler(
  db: Db,
  ws: WorkspaceService,
  us: UserService,
  inviterUserId: string,
  body: Record<string, string>,
): Promise<MockRes> {
  const { res, state } = mockRes();
  await handleWorkspaceMemberAdd(
    res,
    { userId: inviterUserId, channelId: 'ch_validation_scratch' },
    db,
    TEST_WORKSPACE_ID,
    body as any,
    ws,
    us,
  );
  return state;
}

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  const mode = process.argv[2] ?? '';

  // ─── Clean mode: remove test members and exit ────────────────────────────
  if (mode === '--clean') {
    const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017');
    await client.connect();
    const db = client.db(process.env.MONGODB_DATABASE || 'teros');
    const before = await db.collection('workspace_members').countDocuments({ workspaceId: TEST_WORKSPACE_ID });
    await db.collection('workspace_members').deleteMany({ workspaceId: TEST_WORKSPACE_ID });
    // Restore volume members to the original owner-admin entry only
    // (dedupe: Case 2 adds the owner again with the test role — pull everything
    // that is not the original admin entry, including duplicate owner rows)
    const wsDoc = await db.collection('workspaces').findOne({ workspaceId: TEST_WORKSPACE_ID });
    if (wsDoc?.volumeId) {
      await db.collection('volumes').updateOne(
        { volumeId: wsDoc.volumeId },
        { $pull: { members: { $or: [{ userId: { $ne: OWNER_USER_ID } }, { role: { $ne: 'admin' } }] } } },
      );
    }
    const after = await db.collection('workspace_members').countDocuments({ workspaceId: TEST_WORKSPACE_ID });
    console.log(`Cleanup: removed ${before - after} members (workspace now has ${after}).`);
    await client.close();
    return;
  }

  // ─── Validation mode ──────────────────────────────────────────────────────
  // Secrets must be loaded before isEmailConfigured() (email-service singleton).
  // Same wiring as src/index.ts:52-57 — singleton basePath must point at the
  // repo-root .secrets, not the package-relative default.
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const secretsPath = join(__dirname, '../../../.secrets');
  (secrets as any).basePath = secretsPath;
  await secrets.load();

  const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017');
  await client.connect();
  const db = client.db(process.env.MONGODB_DATABASE || 'teros');

  // Services wired exactly like bootstrap.ts:169-178
  const volumeService = new VolumeService(db, {
    basePath: config.volumes.basePath,
    defaultWorkspaceQuota: config.volumes.defaultWorkspaceQuota,
  });
  const workspaceService = new WorkspaceService(db, volumeService);
  const userService = new UserService(db);

  const wsDoc = await db.collection('workspaces').findOne({ workspaceId: TEST_WORKSPACE_ID });
  if (!wsDoc) throw new Error(`Test workspace ${TEST_WORKSPACE_ID} not found`);
  const volumeId = wsDoc.volumeId as string;
  console.log(`Workspace: ${wsDoc.name} (${TEST_WORKSPACE_ID}), volume ${volumeId}`);
  console.log(`Email configured: ${process.env.RESEND_API_KEY ? 'env' : 'secrets'}`);

  // Pre-flight: workspace starts at 0 members
  const preCount = await db.collection('workspace_members').countDocuments({ workspaceId: TEST_WORKSPACE_ID });
  check('pre-flight: workspace has 0 members', preCount === 0, `found ${preCount}`);

  // ── Case 1: non-existent email → 201 pending + invitation token ─────────
  console.log('\n── Case 1: non-existent email → pending invitation ──');
  const c1 = await callHandler(db, workspaceService, userService, OWNER_USER_ID, {
    email: NON_EXISTENT_EMAIL,
    role: 'read',
  });
  check('returns 201', c1.statusCode === 201, `got ${c1.statusCode} ${JSON.stringify(c1.body)}`);
  check("status: 'pending'", c1.body?.status === 'pending');
  const c1Member = await db.collection('workspace_members').findOne({
    workspaceId: TEST_WORKSPACE_ID,
    email: NON_EXISTENT_EMAIL,
  });
  check('member in DB with email', !!c1Member);
  check("member.status: 'pending'", c1Member?.status === 'pending');
  check('invitation.token starts with inv_', typeof c1Member?.invitation?.token === 'string' && c1Member.invitation.token.startsWith('inv_'), JSON.stringify(c1Member?.invitation?.token));
  check('no ghost userId field', !c1Member?.userId, `userId = ${c1Member?.userId}`);
  check('response never returns userId', c1.body?.userId === undefined, `body.userId = ${c1.body?.userId}`);

  // ── Case 2: existing email → 201 active + real userId + volume ───────────
  console.log('\n── Case 2: existing email → active member ──');
  const c2 = await callHandler(db, workspaceService, userService, OWNER_USER_ID, {
    email: PABLO_EMAIL,
    role: 'write',
  });
  check('returns 201', c2.statusCode === 201, `got ${c2.statusCode} ${JSON.stringify(c2.body)}`);
  check("status: 'active'", c2.body?.status === 'active');
  const c2Member = await db.collection('workspace_members').findOne({
    workspaceId: TEST_WORKSPACE_ID,
    userId: OWNER_USER_ID,
  });
  check('member in DB with REAL userId', c2Member?.userId === OWNER_USER_ID);
  check("member.status: 'active'", c2Member?.status === 'active');
  check('member.email populated', c2Member?.email === PABLO_EMAIL);
  const volDoc = await db.collection('volumes').findOne({ volumeId });
  const volMember = volDoc?.members?.find((m: any) => m.userId === OWNER_USER_ID);
  check('added to volume', !!volMember, JSON.stringify(volDoc?.members?.map((m: any) => m.userId)));

  // ── Case 3: invalid email → 400 ───────────────────────────────────────────
  console.log('\n── Case 3: invalid email → 400 ──');
  const c3 = await callHandler(db, workspaceService, userService, OWNER_USER_ID, {
    email: 'not-an-email',
    role: 'read',
  });
  check('returns 400', c3.statusCode === 400, `got ${c3.statusCode}`);
  check('error mentions email', typeof c3.body?.error === 'string' && c3.body.error.toLowerCase().includes('email'));

  // ── Case 4: invalid role (owner) → 400 ────────────────────────────────────
  console.log('\n── Case 4: role owner → 400 ──');
  const c4 = await callHandler(db, workspaceService, userService, OWNER_USER_ID, {
    email: 'someone-role-test@example.com',
    role: 'owner',
  });
  check('returns 400', c4.statusCode === 400, `got ${c4.statusCode}`);
  check('error mentions role', typeof c4.body?.error === 'string' && c4.body.error.toLowerCase().includes('role'));

  // ── Case 5: repeat pending invite → idempotent ───────────────────────────
  console.log('\n── Case 5: repeat pending invite → idempotent ──');
  const c5 = await callHandler(db, workspaceService, userService, OWNER_USER_ID, {
    email: NON_EXISTENT_EMAIL,
    role: 'read',
  });
  check('returns 201 (not 409)', c5.statusCode === 201, `got ${c5.statusCode}`);
  check("status: 'pending'", c5.body?.status === 'pending');
  const pendingCount = await db.collection('workspace_members').countDocuments({
    workspaceId: TEST_WORKSPACE_ID,
    email: NON_EXISTENT_EMAIL,
    status: 'pending',
  });
  check('no duplicate pending member', pendingCount === 1, `found ${pendingCount}`);

  // ── Case 6: non-admin inviter → 403 ───────────────────────────────────────
  console.log('\n── Case 6: non-admin inviter → 403 ──');
  const c6 = await callHandler(db, workspaceService, userService, NON_ADMIN_USER_ID, {
    email: 'should-not-exist@example.com',
    role: 'read',
  });
  check('returns 403', c6.statusCode === 403, `got ${c6.statusCode} ${JSON.stringify(c6.body)}`);
  const leaked = await db.collection('workspace_members').findOne({
    workspaceId: TEST_WORKSPACE_ID,
    email: 'should-not-exist@example.com',
  });
  check('no member created', !leaked);

  // ── Bonus: legacy wire field (userId) still works ─────────────────────────
  console.log('\n── Bonus: legacy userId field tolerated ──');
  const c7 = await callHandler(db, workspaceService, userService, OWNER_USER_ID, {
    userId: 'legacy-wire@example.com',
    role: 'read',
  });
  check('returns 201 via legacy field', c7.statusCode === 201, `got ${c7.statusCode}`);
  check("status: 'pending'", c7.body?.status === 'pending');

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n═══ RESULT: ${pass} pass / ${fail} fail ═══`);
  console.log('NOTE: test members left in DB — run with --clean to remove.');
  await client.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('VALIDATION CRASHED:', e);
  process.exit(1);
});
