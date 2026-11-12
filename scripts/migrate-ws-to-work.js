/**
 * Migrate workspace IDs from ws_ prefix to work_ prefix.
 *
 * Usage:
 *   mongosh teros /tmp/migrate-ws-to-work.js              # DRY RUN (default)
 *   mongosh teros --eval "const DRY_RUN=false" /tmp/migrate-ws-to-work.js  # REAL RUN
 *
 * The script builds a mapping of ws_ → work_ IDs (same hex suffix, only the
 * prefix changes), then updates every collection that references workspace IDs.
 *
 * Collections are updated in three tiers:
 *  1. DIRECT   — field workspaceId or ownerId on the document itself
 *  2. INDIRECT — resolved via a lookup chain (channelId → sessionId, agentId, projectId)
 *  3. NESTED   — workspaceId inside a sub-object (payload.workspaceId, groupKey.workspaceId)
 */

const DRY = typeof DRY_RUN !== 'undefined' ? DRY_RUN : true;

function log(msg)  { print(`[${DRY ? 'DRY' : 'LIVE'}] ${msg}`); }
function done(msg) { print(`  ✓ ${msg}`); }

// ── 1. Build the ws_ → work_ mapping ──────────────────────────────────────

const wsWorkspaces = db.workspaces.find({ workspaceId: /^ws_/ }).toArray();
const mapping = {}; // ws_xxx → work_xxx
const wsIds  = [];  // all ws_ workspace IDs

wsWorkspaces.forEach(w => {
  const oldId = w.workspaceId;
  const newId = 'work_' + oldId.slice(3); // ws_xxx → work_xxx
  mapping[oldId] = newId;
  wsIds.push(oldId);
});

log(`Found ${wsIds.length} workspaces to migrate`);
if (wsIds.length === 0) {
  print('Nothing to migrate. Exiting.');
  quit();
}

// ── 2. Build lookup maps for indirect references ──────────────────────────

// channels: workspaceId → [channelIds]
const wsChannelIds = [];
db.channels.find({ workspaceId: { $in: wsIds } }).forEach(c => wsChannelIds.push(c.channelId));

// sessions: channelId → [sessionIds]
const wsSessionIds = [];
db.sessions.find({ channelId: { $in: wsChannelIds } }).forEach(s => wsSessionIds.push(s.sessionId));

// agents: workspaceId → [agentIds]
const wsAgentIds = [];
db.agents.find({ workspaceId: { $in: wsIds } }).forEach(a => wsAgentIds.push(a.agentId));

// projects: workspaceId → [projectIds]
const wsProjectIds = [];
db.projects.find({ workspaceId: { $in: wsIds } }).forEach(p => wsProjectIds.push(p.projectId));

// boards: projectId → [boardIds]
const wsBoardIds = [];
db.boards.find({ projectId: { $in: wsProjectIds } }).forEach(b => wsBoardIds.push(b.boardId));

log(`Lookup maps: ${wsChannelIds.length} channels, ${wsSessionIds.length} sessions, ${wsAgentIds.length} agents, ${wsProjectIds.length} projects, ${wsBoardIds.length} boards`);

// ── 3. Helper: bulk update a field across a mapping ───────────────────────

function updateField(collection, field, idMap, filterField) {
  const coll = db.getCollection(collection);
  let total = 0;
  for (const [oldId, newId] of Object.entries(idMap)) {
    const filter = { [filterField || field]: oldId };
    const update = { $set: { [field]: newId } };
    const count = DRY ? coll.countDocuments(filter) : coll.updateMany(filter, update).modifiedCount;
    total += count;
  }
  return total;
}

function updateNestedField(collection, dotPath, idMap, filterField) {
  const coll = db.getCollection(collection);
  let total = 0;
  for (const [oldId, newId] of Object.entries(idMap)) {
    const filter = { [filterField || dotPath]: oldId };
    const update = { $set: { [dotPath]: newId } };
    const count = DRY ? coll.countDocuments(filter) : coll.updateMany(filter, update).modifiedCount;
    total += count;
  }
  return total;
}

function updateByRefIds(collection, field, refIds, newWorkspaceId) {
  const coll = db.getCollection(collection);
  if (refIds.length === 0) return 0;
  const filter = { [field]: { $in: refIds } };
  // In dry run, just count
  if (DRY) return coll.countDocuments(filter);
  // In live mode, we need to update each document's workspaceId
  // But these collections might not have a workspaceId field — they're referenced indirectly
  // Actually, for indirect references, the workspaceId is NOT on these documents.
  // The migration only changes workspaceId fields. Collections like channel_messages
  // don't have workspaceId — they have channelId. The channelId doesn't change.
  // So we DON'T need to update these — only the parent (channels) gets updated.
  return 0;
}

// ── 4. Execute migration ──────────────────────────────────────────────────

log('--- TIER 1: Direct workspaceId / ownerId fields ---');

// workspaces.workspaceId
let n = updateField('workspaces', 'workspaceId', mapping);
done(`workspaces.workspaceId: ${n}`);

// users.privateWorkspaceId
n = updateField('users', 'privateWorkspaceId', mapping);
done(`users.privateWorkspaceId: ${n}`);

// apps.ownerId
n = updateField('apps', 'ownerId', mapping);
done(`apps.ownerId: ${n}`);

// channels.workspaceId
n = updateField('channels', 'workspaceId', mapping);
done(`channels.workspaceId: ${n}`);

// agents.workspaceId
n = updateField('agents', 'workspaceId', mapping);
done(`agents.workspaceId: ${n}`);

// agent_skill_access.workspaceId
n = updateField('agent_skill_access', 'workspaceId', mapping);
done(`agent_skill_access.workspaceId: ${n}`);

// projects.workspaceId
n = updateField('projects', 'workspaceId', mapping);
done(`projects.workspaceId: ${n}`);

// volumes.workspaceId
n = updateField('volumes', 'workspaceId', mapping);
done(`volumes.workspaceId: ${n}`);

// shared_files.workspaceId
n = updateField('shared_files', 'workspaceId', mapping);
done(`shared_files.workspaceId: ${n}`);

// agent_usage_sessions.workspaceId
n = updateField('agent_usage_sessions', 'workspaceId', mapping);
done(`agent_usage_sessions.workspaceId: ${n}`);

// user_desktop_state.workspaceId
n = updateField('user_desktop_state', 'workspaceId', mapping);
done(`user_desktop_state.workspaceId: ${n}`);

log('--- TIER 2: Indirect references (via agentId, projectId, boardId) ---');

// agent_app_access — no workspaceId field, linked via agentId
// The agentId doesn't change, only the agent's workspaceId changes (done above)
// So no update needed here.
done(`agent_app_access: 0 (linked via agentId, no workspaceId field)`);

// agent_configs — same, linked via agentId
done(`agent_configs: 0 (linked via agentId, no workspaceId field)`);

// boards — linked via projectId, no workspaceId field
done(`boards: 0 (linked via projectId, no workspaceId field)`);

// board_subscriptions — linked via boardId, no workspaceId field
done(`board_subscriptions: 0 (linked via boardId, no workspaceId field)`);

// channel_messages, sessions, tool_executions, llm_usage, conversation_usage
// — all linked via channelId/sessionId, no workspaceId field
done(`channel_messages: 0 (linked via channelId, no workspaceId field)`);
done(`sessions: 0 (linked via channelId, no workspaceId field)`);
done(`tool_executions: 0 (linked via sessionId, no workspaceId field)`);
done(`llm_usage: 0 (linked via sessionId, no workspaceId field)`);
done(`conversation_usage: 0 (linked via channelId, no workspaceId field)`);
done(`subscriptions_channel: 0 (linked via channelId, no workspaceId field)`);

log('--- TIER 3: Nested workspaceId fields ---');

// agent_usage_events.payload.workspaceId
n = updateNestedField('agent_usage_events', 'payload.workspaceId', mapping);
done(`agent_usage_events.payload.workspaceId: ${n}`);

// agent_usage_rollups_hourly.groupKey.workspaceId
n = updateNestedField('agent_usage_rollups_hourly', 'groupKey.workspaceId', mapping);
done(`agent_usage_rollups_hourly.groupKey.workspaceId: ${n}`);

// agent_usage_rollups_user_hourly.groupKey.workspaceId
n = updateNestedField('agent_usage_rollups_user_hourly', 'groupKey.workspaceId', mapping);
done(`agent_usage_rollups_user_hourly.groupKey.workspaceId: ${n}`);

// user_desktop_state — nested windows.*.props.workspaceId
// Each document has a `windows` object (keyed by windowId) where each window
// may have props.workspaceId. We need to update those too.
let nestedUds = 0;
for (const [oldId, newId] of Object.entries(mapping)) {
  const filter = { 'windows.props.workspaceId': oldId };
  if (DRY) {
    nestedUds += db.user_desktop_state.countDocuments(filter);
  } else {
    // Update each matching document — $set with dotted path for all windows
    // Since windows is an object (not array), we can use $set on the dot path
    // But we need to update all windows that have this workspaceId in their props
    // MongoDB can't do conditional $set on sub-documents, so we do it in JS
    db.user_desktop_state.find(filter).forEach(doc => {
      let changed = false;
      if (doc.windows) {
        for (const winId of Object.keys(doc.windows)) {
          const win = doc.windows[winId];
          if (win.props && win.props.workspaceId === oldId) {
            win.props.workspaceId = newId;
            changed = true;
          }
          // Also check history array entries
          if (win.history) {
            win.history.forEach(h => {
              if (h.props && h.props.workspaceId === oldId) {
                h.props.workspaceId = newId;
                changed = true;
              }
            });
          }
        }
      }
      if (changed) {
        db.user_desktop_state.updateOne({ _id: doc._id }, { $set: { windows: doc.windows } });
        nestedUds++;
      }
    });
  }
}
done(`user_desktop_state.windows.*.props.workspaceId: ${nestedUds}`);

// ── 5. Verification ───────────────────────────────────────────────────────

log('--- VERIFICATION ---');

const checks = [
  ['workspaces',    'workspaceId'],
  ['users',         'privateWorkspaceId'],
  ['apps',          'ownerId'],
  ['channels',      'workspaceId'],
  ['agents',        'workspaceId'],
  ['projects',      'workspaceId'],
  ['volumes',       'workspaceId'],
  ['shared_files',  'workspaceId'],
  ['agent_usage_sessions', 'workspaceId'],
  ['user_desktop_state',   'workspaceId'],
  ['agent_skill_access',   'workspaceId'],
];

let allZero = true;
for (const [coll, field] of checks) {
  const count = db.getCollection(coll).countDocuments({ [field]: /^ws_/ });
  const status = count === 0 ? '✅' : '❌';
  if (count > 0) allZero = false;
  print(`  ${status} ${coll}.${field}: ${count} remaining`);
}

// Nested checks
const nestedChecks = [
  ['agent_usage_events', 'payload.workspaceId'],
  ['agent_usage_rollups_hourly', 'groupKey.workspaceId'],
  ['agent_usage_rollups_user_hourly', 'groupKey.workspaceId'],
  ['user_desktop_state', 'windows.props.workspaceId'],
];

for (const [coll, dotPath] of nestedChecks) {
  const count = db.getCollection(coll).countDocuments({ [dotPath]: /^ws_/ });
  const status = count === 0 ? '✅' : '❌';
  if (count > 0) allZero = false;
  print(`  ${status} ${coll}.${dotPath}: ${count} remaining`);
}

log(allZero ? 'ALL CLEAR — no ws_ references remaining' : 'WARNING — some ws_ references remain');
