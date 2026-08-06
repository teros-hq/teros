#!/usr/bin/env node
/**
 * Seed para la demo del despliegue gradual de cores (TER-412 / #132).
 *
 * Crea N usuarios fake, cada uno con varios super-agents GLOBALES (coreId
 * 'super-agent', sin workspaceId, con ownerId) para que el bucketing por ownerId
 * reparta de forma realista al mover el % en Agent Cores → Despliegue gradual.
 *
 * Todo lo sembrado lleva `seedTag: 'rollout-demo'` → limpieza quirúrgica con
 * --clean. NO toca usuarios/agentes reales. Para la DB local del stack (`teros`).
 *
 * Decisión de diseño: los usuarios NO llevan privateWorkspaceId a propósito. Así un
 * Apply real re-apunta el coreId (la distribución cambia, que es lo que se demuestra)
 * y omite el reaprovisionamiento de apps limpiamente — no hay workspace que resolver,
 * así que no falla contra workspaces inexistentes.
 *
 * Uso:
 *   node scripts/playwright-smoke/seed-rollout-demo.mjs                  # 40 users, ≤3 agentes c/u
 *   node scripts/playwright-smoke/seed-rollout-demo.mjs --users=60 --max-agents=2
 *   node scripts/playwright-smoke/seed-rollout-demo.mjs --clean          # borra SOLO lo sembrado
 */
import { randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';

const URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGODB_DATABASE ?? 'teros';
const SEED_TAG = 'rollout-demo';
const STABLE_CORE = 'super-agent';

const args = process.argv.slice(2);
const clean = args.includes('--clean');
const intArg = (name, def) => {
  const m = args.find((a) => a.startsWith(`--${name}=`));
  return m ? Number.parseInt(m.split('=')[1], 10) : def;
};
const N_USERS = intArg('users', 40);
const MAX_AGENTS = intArg('max-agents', 3);

const hex = (n = 8) => randomBytes(n).toString('hex');
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const FIRST = ['Lucía', 'Mateo', 'Sofía', 'Hugo', 'Martina', 'Leo', 'Valentina', 'Daniel', 'Emma', 'Pablo', 'Olivia', 'Marcos', 'Julia', 'Adrián', 'Carla', 'Diego', 'Noa', 'Álvaro', 'Vega', 'Bruno', 'Nora', 'Iván', 'Alba', 'Gael', 'Lola', 'Enzo', 'Triana', 'Izan', 'Jimena', 'Thiago'];
const LAST = ['García', 'Fernández', 'Martín', 'López', 'Sánchez', 'Romero', 'Torres', 'Navarro', 'Gil', 'Vidal', 'Ortega', 'Cano', 'Prieto', 'Ramos', 'Cruz', 'Flores', 'Castro', 'Rubio', 'Marín', 'Soto'];
const ROLES = ['Personal Assistant', 'Research Aide', 'Ops Copilot', 'Writing Partner', 'Data Analyst', 'Project Helper'];
const INTROS = ['I help with software engineering and technical workflows.', 'I assist with research, planning and day-to-day tasks.', 'I help organize projects and keep the work moving.'];

const now = () => new Date().toISOString();

async function main() {
  const client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 5000 });
  const db = client.db(DB_NAME);
  const users = db.collection('users');
  const agents = db.collection('agents');

  if (clean) {
    const u = await users.deleteMany({ seedTag: SEED_TAG });
    const a = await agents.deleteMany({ seedTag: SEED_TAG });
    console.log(`🧹 Limpieza: ${u.deletedCount} usuarios y ${a.deletedCount} agentes (seedTag='${SEED_TAG}') borrados.`);
    await client.close();
    return;
  }

  // El rollout exige el core estable de super-agent: no sembramos huérfanos.
  const core = await db
    .collection('agent_cores')
    .findOne({ coreId: STABLE_CORE, coreType: 'super-agent', status: 'active' });
  if (!core) {
    console.error(`❌ No existe el core estable activo '${STABLE_CORE}'. Aborto.`);
    await client.close();
    process.exit(1);
  }

  // Idempotente: borra lo sembrado antes y recrea (re-ejecutable sin acumular).
  await users.deleteMany({ seedTag: SEED_TAG });
  await agents.deleteMany({ seedTag: SEED_TAG });

  const userDocs = [];
  const agentDocs = [];

  for (let i = 0; i < N_USERS; i++) {
    const userId = `user_${hex()}`;
    const displayName = `${pick(FIRST)} ${pick(LAST)}`;
    userDocs.push({
      userId,
      profile: { displayName, email: `seed_${i}_${hex(3)}@rollout.demo`, avatarUrl: null },
      status: 'active',
      role: 'user',
      emailVerified: true,
      accessGranted: true,
      createdAt: now(),
      updatedAt: now(),
      seedTag: SEED_TAG,
    });
    const count = 1 + Math.floor(Math.random() * MAX_AGENTS);
    for (let j = 0; j < count; j++) {
      const fullName = `${pick(FIRST)} ${pick(LAST)}`;
      agentDocs.push({
        agentId: `agent_${hex()}`,
        coreId: STABLE_CORE, // nace en el core estable (como en producción)
        ownerId: userId, // identidad de bucketing del rollout
        // sin workspaceId: agente global (super-agent)
        name: fullName.split(' ')[0],
        fullName,
        role: pick(ROLES),
        intro: pick(INTROS),
        status: 'active',
        maxSteps: 80,
        availableProviders: [],
        selectedProviderId: null,
        selectedModelId: null,
        createdAt: now(),
        updatedAt: now(),
        seedTag: SEED_TAG,
      });
    }
  }

  await users.insertMany(userDocs);
  await agents.insertMany(agentDocs);

  const total = await agents.countDocuments({ coreId: STABLE_CORE });
  console.log(`✅ Sembrados ${userDocs.length} usuarios y ${agentDocs.length} super-agents (dueños variados).`);
  console.log(`   Total agentes en '${STABLE_CORE}' ahora: ${total}.`);
  console.log("   Abre Agent Cores → core estable 'super-agent' → Despliegue gradual y mueve el %.");
  console.log('   Limpieza al terminar: node scripts/playwright-smoke/seed-rollout-demo.mjs --clean');
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
