// datastore-isolation P0b — create the two role users on FIRST initialization.
//
// The official mongo image runs this (with mongosh, as the root user created
// from MONGO_INITDB_ROOT_USERNAME/PASSWORD) only when the data volume is empty.
// For an EXISTING deployment use scripts/security/mongo-create-users.sh instead.
//
// Model (decided 2026-10-14, Pablo): two users by ROLE, not per service —
//   - MONGO_RW_USER  (default teros_rw): readWrite on the `teros` database → the backend
//   - MONGO_RO_USER  (default teros_ro): read only on `teros`            → ops / reporting
// No per-MCA credentials: after the P1b/P1c migrations no MCA connects to Mongo.
//
// Users are created in `admin` (authSource=admin in the backend URI).
const dbName = process.env.MONGO_INITDB_DATABASE || 'teros';
const users = [
  { user: process.env.MONGO_RW_USER || 'teros_rw', pwd: process.env.MONGO_RW_PASSWORD, role: 'readWrite' },
  { user: process.env.MONGO_RO_USER || 'teros_ro', pwd: process.env.MONGO_RO_PASSWORD, role: 'read' },
];
const admin = db.getSiblingDB('admin');
for (const u of users) {
  if (!u.pwd) throw new Error(`[mongo-init] missing password for ${u.user}`);
  const existing = admin.getUser(u.user);
  if (existing) {
    print(`[mongo-init] user ${u.user} already exists — skipping`);
    continue;
  }
  admin.createUser({ user: u.user, pwd: u.pwd, roles: [{ role: u.role, db: dbName }] });
  print(`[mongo-init] created ${u.user} (${u.role} on ${dbName})`);
}
