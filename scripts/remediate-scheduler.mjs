#!/usr/bin/env node
/**
 * Diagnóstico + remediación del subsistema scheduler tras el incidente de
 * cross-user writes (2026-06-03). Pensado para que lo corra alguien con acceso
 * a la DB de prod, SIN editar Mongo a mano.
 *
 * El bug estuvo vivo en prod, así que afecta a una población DESCONOCIDA de
 * usuarios/tasks, no solo a las 2 del postmortem. Este script primero mide
 * (read-only) y solo muta lo seguro/inequívoco; lo ambiguo lo reporta para
 * juicio humano. Todas las mutaciones requieren `--apply` (default dry-run) y
 * están scopeadas por {id, user_id}.
 *
 * IMPORTANTE — qué se auto-cura SOLO con el deploy (NO necesita este script):
 *   - Toda recurring task `enabled` (víctimas del bucle con next_run en pasado,
 *     y víctimas colaterales con next_run cruzado): el tick corregido recomputa
 *     su next_run desde su propio cron en la primera pasada. Aquí solo se
 *     REPORTAN para visibilidad.
 * Lo que NO se auto-cura y este script atiende:
 *   - Reminders atascados en `dispatching` (estado muerto) → heal seguro.
 *   - Recurring tasks DESHABILITADAS (Task A manual + auto-disable por fallos)
 *     → re-enable DIRIGIDO (Pablo decide cuáles).
 *
 * Comandos:
 *   node scripts/remediate-scheduler.mjs                       # diagnose (read-only)
 *   node scripts/remediate-scheduler.mjs heal-reminders        # dry-run del reset
 *   node scripts/remediate-scheduler.mjs heal-reminders --apply
 *   node scripts/remediate-scheduler.mjs reenable 4:user_xxx 7:user_yyy        # dry-run
 *   node scripts/remediate-scheduler.mjs reenable 4:user_xxx --apply
 *
 * Env: MONGODB_URI, MONGODB_DB_NAME (default 'teros'),
 *      STUCK_DISPATCHING_MINUTES (default 10).
 */

import { MongoClient } from 'mongodb';
import { Cron } from 'croner';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const cmd = argv.find((a) => !a.startsWith('--')) || 'diagnose';
const targets = argv.filter((a) => !a.startsWith('--') && a.includes(':')); // id:user_id

const URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGODB_DB_NAME || process.env.MONGODB_DATABASE || 'teros';
const STUCK_MIN = Number(process.env.STUCK_DISPATCHING_MINUTES || 10);

const now = Date.now();
const iso = (v) => (v == null ? 'null' : new Date(typeof v === 'number' ? v : v).toISOString());

/** Recomputa next_run validando exactamente 5 campos (igual que el fix). */
function computeNextRun(cron, tz) {
  const fields = String(cron).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron no-5-campos: "${cron}"`);
  const job = new Cron(cron, { timezone: tz || 'Europe/Madrid', paused: true });
  const next = job.nextRun();
  job.stop();
  if (!next) throw new Error(`cron sin próxima ejecución: "${cron}"`);
  return next.getTime();
}

async function dupGroups(col) {
  return col
    .aggregate([
      { $group: { _id: '$id', users: { $addToSet: '$user_id' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $project: { id: '$_id', _id: 0, count: 1, distinctUsers: { $size: '$users' } } },
      { $sort: { count: -1 } },
    ])
    .toArray();
}

async function diagnose(db) {
  const tasks = db.collection('scheduler_recurring_tasks');
  const reminders = db.collection('scheduler_reminders');

  console.log('\n================ DIAGNÓSTICO SCHEDULER (read-only) ================');
  console.log(`DB: ${DB_NAME} @ ${URI.replace(/\/\/[^@]*@/, '//***@')}  |  ${new Date(now).toISOString()}\n`);

  // 1) id duplicados (la exposición raíz del bug).
  const taskDups = await dupGroups(tasks);
  const remDups = await dupGroups(reminders);
  console.log(`── id duplicados (mismo id, varios usuarios) — origen del cross-user ──`);
  console.log(`   recurring_tasks: ${taskDups.length} grupos`);
  taskDups.slice(0, 20).forEach((g) => console.log(`     id=${g.id}: ${g.distinctUsers} usuarios`));
  console.log(`   reminders:       ${remDups.length} grupos`);
  remDups.slice(0, 20).forEach((g) => console.log(`     id=${g.id}: ${g.distinctUsers} usuarios`));

  // 2) Recurring enabled overdue (víctimas del bucle) — SE AUTO-CURAN al desplegar.
  const overdue = await tasks
    .find({ enabled: true, next_run: { $lte: now }, user_id: { $ne: '__orphaned__' } })
    .project({ id: 1, user_id: 1, next_run: 1, cron_expression: 1, _id: 0 })
    .toArray();
  console.log(`\n── recurring ENABLED con next_run en el pasado (víctimas del bucle) ──`);
  console.log(`   ${overdue.length} → SE AUTO-CURAN en el primer tick tras el deploy (no requieren acción).`);
  overdue.slice(0, 15).forEach((t) =>
    console.log(`     id=${t.id} user=${t.user_id} next_run=${iso(t.next_run)} cron="${t.cron_expression}"`),
  );

  // 3) Recurring DESHABILITADAS — clasificar por firma.
  const disabled = await tasks
    .find({ enabled: false })
    .project({ id: 1, user_id: 1, last_error: 1, consecutive_failures: 1, cron_expression: 1, timezone: 1, _id: 0 })
    .toArray();
  const disabledByFailure = disabled.filter((t) => t.last_error || (t.consecutive_failures ?? 0) > 0);
  const disabledClean = disabled.filter((t) => !t.last_error && !(t.consecutive_failures ?? 0));
  console.log(`\n── recurring DESHABILITADAS (NO se auto-curan — requieren re-enable dirigido) ──`);
  console.log(`   con firma de fallo (last_error / consecutive_failures>0) — candidatas a re-enable:`);
  console.log(`   ${disabledByFailure.length}`);
  disabledByFailure.slice(0, 30).forEach((t) =>
    console.log(`     id=${t.id} user=${t.user_id} fails=${t.consecutive_failures ?? 0} err="${(t.last_error ?? '').slice(0, 60)}"`),
  );
  console.log(`   sin firma (probablemente deshabilitadas a propósito por el usuario) — NO tocar a ciegas: ${disabledClean.length}`);
  disabledClean.slice(0, 30).forEach((t) => console.log(`     id=${t.id} user=${t.user_id} cron="${t.cron_expression}"`));

  // 4) Crons de 6 campos (sub-minuto) — el fix las auto-deshabilita al ejecutarse.
  const all = await tasks.find({}).project({ id: 1, user_id: 1, cron_expression: 1, enabled: 1, _id: 0 }).toArray();
  const sixField = all.filter((t) => String(t.cron_expression || '').trim().split(/\s+/).length !== 5);
  console.log(`\n── tasks con cron != 5 campos (sub-minuto / nicknames) ──`);
  console.log(`   ${sixField.length} → el fix las rechaza (auto-disable). El usuario debe recrearlas con cron de 5 campos.`);
  sixField.slice(0, 20).forEach((t) => console.log(`     id=${t.id} user=${t.user_id} enabled=${t.enabled} cron="${t.cron_expression}"`));

  // 5) Reminders atascados en dispatching (estado muerto — NO se auto-curan).
  const stuckCutoff = new Date(now - STUCK_MIN * 60_000);
  const stuck = await reminders
    .find({ status: 'dispatching', $or: [{ dispatching_at: { $lt: stuckCutoff } }, { dispatching_at: { $exists: false } }] })
    .project({ id: 1, user_id: 1, dispatching_at: 1, scheduled_time: 1, _id: 0 })
    .toArray();
  console.log(`\n── reminders ATASCADOS en 'dispatching' > ${STUCK_MIN} min (estado muerto) ──`);
  console.log(`   ${stuck.length} → 'heal-reminders' los resetea a 'pending' para re-entrega correcta (scopeada).`);
  stuck.slice(0, 20).forEach((r) =>
    console.log(`     id=${r.id} user=${r.user_id} dispatching_at=${iso(r.dispatching_at)} scheduled=${iso(r.scheduled_time)}`),
  );

  console.log(`\n================ FIN DIAGNÓSTICO ================`);
  console.log(`Próximos pasos sugeridos:`);
  console.log(`  1) Revisa los grupos de id duplicados y las disabled-con-firma.`);
  console.log(`  2) heal-reminders --apply  (resetea los ${stuck.length} reminders atascados).`);
  console.log(`  3) reenable <id>:<user_id> --apply  para las disabled que decidas re-habilitar.\n`);
}

async function healReminders(db) {
  const reminders = db.collection('scheduler_reminders');
  const stuckCutoff = new Date(now - STUCK_MIN * 60_000);
  const filter = {
    status: 'dispatching',
    $or: [{ dispatching_at: { $lt: stuckCutoff } }, { dispatching_at: { $exists: false } }],
  };
  const stuck = await reminders.find(filter).project({ id: 1, user_id: 1, _id: 0 }).toArray();
  console.log(`\n=== heal-reminders — ${APPLY ? 'APPLY' : 'DRY-RUN'} — ${stuck.length} atascados > ${STUCK_MIN} min ===`);
  stuck.forEach((r) => console.log(`  id=${r.id} user=${r.user_id} → status: dispatching → pending`));
  if (!APPLY) return console.log(`(dry-run; re-ejecuta con --apply para resetear)\n`);
  const res = await reminders.updateMany(filter, {
    $set: { status: 'pending' },
    $unset: { dispatching_at: '' },
  });
  console.log(`✅ ${res.modifiedCount} reminders reseteados a 'pending'. El scheduler los re-entregará (ya scopeado).\n`);
}

async function reenable(db) {
  const tasks = db.collection('scheduler_recurring_tasks');
  if (targets.length === 0) {
    console.error('Uso: reenable <id>:<user_id> [<id>:<user_id> ...] [--apply]');
    process.exit(1);
  }
  console.log(`\n=== reenable — ${APPLY ? 'APPLY' : 'DRY-RUN'} — ${targets.length} target(s) ===`);
  for (const t of targets) {
    const [idStr, userId] = t.split(':');
    const id = Number(idStr);
    const doc = await tasks.findOne({ id, user_id: userId });
    if (!doc) {
      console.log(`  ⚠️  id=${id} user=${userId}: NO encontrada. Saltando.`);
      continue;
    }
    let nextRun;
    try {
      nextRun = computeNextRun(doc.cron_expression, doc.timezone);
    } catch (e) {
      console.log(`  ❌ id=${id} user=${userId}: ${e.message}. Necesita recrearse con cron válido. Saltando.`);
      continue;
    }
    console.log(`  id=${id} user=${userId}  cron="${doc.cron_expression}" tz=${doc.timezone || '(def)'}`);
    console.log(`     enabled: ${doc.enabled} → true | next_run: ${iso(doc.next_run)} → ${iso(nextRun)}`);
    if (!APPLY) continue;
    const res = await tasks.updateOne(
      { id, user_id: userId }, // scopeado (fix Bug A)
      { $set: { enabled: true, next_run: nextRun, consecutive_failures: 0 }, $unset: { last_error: '' } },
    );
    console.log(`     ✅ aplicado (modified=${res.modifiedCount})`);
  }
  if (!APPLY) console.log(`(dry-run; re-ejecuta con --apply)\n`);
  else console.log('Re-habilitación aplicada.\n');
}

async function main() {
  const client = new MongoClient(URI);
  await client.connect();
  try {
    const db = client.db(DB_NAME);
    if (cmd === 'diagnose') await diagnose(db);
    else if (cmd === 'heal-reminders') await healReminders(db);
    else if (cmd === 'reenable') await reenable(db);
    else {
      console.error(`Comando desconocido: "${cmd}". Usa: diagnose | heal-reminders | reenable`);
      process.exit(1);
    }
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
