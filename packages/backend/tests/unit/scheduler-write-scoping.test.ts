/**
 * Invariante estructural (lint-as-test) — toda mutación del scheduler a
 * `scheduler_reminders` / `scheduler_recurring_tasks` DEBE filtrar por user_id.
 *
 * El incidente prod (recurring id=4 corriendo en bucle) y el cross-user de
 * reminders fueron exactamente writes filtrados solo por `id` — que es un
 * counter PER-USER, así que un updateOne/findOneAndUpdate sin user_id impacta
 * la fila de OTRO usuario. Este test es la barrera que impide reintroducir la
 * clase entera sin tener que ejercitar cada path. Patrón: toolCallCardAdoption.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';

const SRC = readFileSync(
  join(import.meta.dir, '../../src/services/scheduler-service.ts'),
  'utf8',
);

// insertOne se excluye a propósito: es append-only (lleva user_id como campo,
// no como filtro). find() de reminders/tasks ya filtra por user_id ($ne
// ORPHANED) y no muta. Aquí cazamos solo mutaciones por filtro.
const WRITE_RE =
  /this\.(remindersCollection|recurringTasksCollection)\.(updateOne|findOneAndUpdate|findOneAndDelete)\(/g;

describe('invariante: mutaciones del scheduler scopeadas por user_id', () => {
  it('todo updateOne/findOneAndUpdate/findOneAndDelete incluye user_id en el filtro', () => {
    const offenders: string[] = [];
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiom de regex.exec
    while ((m = WRITE_RE.exec(SRC)) !== null) {
      // El primer argumento (el filtro) arranca justo tras el `(`. Tomamos una
      // ventana amplia y recortamos hasta el cierre del objeto de filtro `},`.
      const window = SRC.slice(m.index, m.index + 220);
      const end = window.indexOf('},');
      const filter = end === -1 ? window : window.slice(0, end + 1);
      if (!/user_id/.test(filter)) {
        const line = SRC.slice(0, m.index).split('\n').length;
        offenders.push(`L${line}: ${m[1]}.${m[2]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('detecta al menos las mutaciones esperadas (sanity del regex)', () => {
    const count = (SRC.match(WRITE_RE) || []).length;
    // 4 recurring (claim, cron-disable, success-reset, failure-inc, cap-disable
    // = 5 en realidad) + reminders (claim, ownership-fail, sent, failed). El
    // regex debe encontrar varias; si baja a 0 el path cambió de forma.
    expect(count).toBeGreaterThanOrEqual(6);
  });
});
