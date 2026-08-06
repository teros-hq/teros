import { type Collection, type Db, type Filter, MongoClient, type ObjectId } from 'mongodb';
import {
  type BulkCancelFilter,
  type Execution,
  type ExecutionsQuery,
  ORPHANED_USER_ID,
  type PageResult,
  type Reminder,
  type RemindersQuery,
  type RecurringTask,
  type RecurringTasksQuery,
  TERMINAL_REMINDER_TTL_SECONDS,
} from '@teros/shared';
import { dropLegacyGlobalIdIndexV1 } from './migrations/drop-legacy-global-id-index-v1';
import { backfillUserIdV1 } from './migrations/user-id-backfill-v1';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGODB_DB_NAME || 'teros';

// Re-export tipos canónicos para que consumidores del MCA importen desde el lib.
export type {
  Reminder,
  RecurringTask,
  Execution,
  PageResult,
  RemindersQuery,
  RecurringTasksQuery,
  BulkCancelFilter,
  ExecutionsQuery,
} from '@teros/shared';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** Cap defensivo de bulk-cancel para evitar updateMany ilimitado. */
export const MAX_BULK_CANCEL = 5000;

function clampLimit(limit?: number): number {
  if (!limit || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

function encodeCursor(scheduledTime: number, id: number): string {
  return Buffer.from(`${scheduledTime}:${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { scheduledTime: number; id: number } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const [ts, id] = decoded.split(':');
    if (!ts || !id) return null;
    const tsNum = Number(ts);
    const idNum = Number(id);
    if (!Number.isFinite(tsNum) || !Number.isFinite(idNum)) return null;
    return { scheduledTime: tsNum, id: idNum };
  } catch {
    return null;
  }
}

/**
 * Documentos de la collection `scheduler_migrations`: registra qué migraciones
 * han corrido para que `init()` sea idempotente entre arranques y entre
 * contenedores HA.
 */
interface MigrationRecord {
  _id: string;
  completed_at: number;
  scanned: number;
  backfilled: number;
  orphaned: number;
}

export class SchedulerDB {
  private client: MongoClient;
  private db!: Db;
  // Las collections son públicas (package-private) solo para que la migration
  // las pueda usar sin re-conectar. No las consumas desde tools — usa los
  // métodos públicos.
  reminders!: Collection<Reminder & { _id?: ObjectId }>;
  recurringTasks!: Collection<RecurringTask & { _id?: ObjectId }>;
  executions!: Collection<Execution & { _id?: ObjectId }>;
  channels!: Collection<{ _id: string; userId?: string; workspaceId?: string }>;
  migrations!: Collection<MigrationRecord>;
  private connected = false;
  private counterCollection!: Collection<{ _id: string; seq: number }>;

  constructor() {
    // MongoDB driver default reconnect handles transient errors. Add retry
    // opts explicitos para sobrevivir blips de red (audit robustez M-4).
    this.client = new MongoClient(MONGODB_URI, {
      retryWrites: true,
      retryReads: true,
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 10,
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect();
    this.db = this.client.db(DB_NAME);
    this.reminders = this.db.collection('scheduler_reminders');
    this.recurringTasks = this.db.collection('scheduler_recurring_tasks');
    this.executions = this.db.collection('scheduler_executions');
    this.channels = this.db.collection('channels');
    this.migrations = this.db.collection('scheduler_migrations');
    this.counterCollection = this.db.collection('scheduler_counters');
    await this.init();
    this.connected = true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async init(): Promise<void> {
    // -- Migrations -----------------------------------------------------------
    // Migration v1 backfilla `user_id` resolviendo `channels.userId` por
    // `channel_id`. Documentos huérfanos quedan con `user_id = '__orphaned__'`
    // y se excluyen de queries normales. Idempotente vía claim atómico.
    await backfillUserIdV1(this);

    // -- Indexes --------------------------------------------------------------
    // Composite por-user para queries del MCA y del WsRouter. El executor usa
    // los índices globales (status, scheduled_time) / (enabled, next_run).
    await this.reminders.createIndex({ user_id: 1, status: 1, scheduled_time: 1 }, { background: true });
    await this.reminders.createIndex({ user_id: 1, channel_id: 1 }, { background: true });
    await this.reminders.createIndex({ status: 1, scheduled_time: 1 }, { background: true });
    await this.reminders.createIndex({ channel_id: 1 }, { background: true });
    await this.reminders.createIndex({ id: 1, user_id: 1 }, { unique: true, sparse: true, background: true });

    await this.recurringTasks.createIndex({ user_id: 1, enabled: 1, next_run: 1 }, { background: true });
    await this.recurringTasks.createIndex({ user_id: 1, channel_id: 1 }, { background: true });
    await this.recurringTasks.createIndex({ enabled: 1, next_run: 1 }, { background: true });
    await this.recurringTasks.createIndex({ channel_id: 1 }, { background: true });
    await this.recurringTasks.createIndex({ id: 1, user_id: 1 }, { unique: true, sparse: true, background: true });

    // Drop del índice unique GLOBAL legacy `{ id: 1 }` (pre-TER-358). El counter
    // per-user reinicia en 1 → distintos users colisionan bajo ese índice
    // (E11000 index: id_1). Se ejecuta tras crear el índice compuesto correcto.
    // Idempotente y barata; corre en cada connect(). Detalle: TER-387.
    await dropLegacyGlobalIdIndexV1(this);

    await this.executions.createIndex({ user_id: 1, task_id: 1, ran_at: -1 }, { background: true });
    await this.executions.createIndex({ task_id: 1, ran_at: -1 }, { background: true });

    // TTL purge para reminders terminales (audit robustez M-7). El field
    // `terminal_at` se setea cuando el reminder pasa a sent/cancelled/failed.
    // Documents sin `terminal_at` (todavía pending/dispatching) no expiran.
    await this.reminders.createIndex(
      { terminal_at: 1 },
      { expireAfterSeconds: TERMINAL_REMINDER_TTL_SECONDS, background: true },
    );

    // -- Counters -------------------------------------------------------------
    // Counter per-user para evitar enumeración cross-tenant (audit security C-4).
    // Documentos legacy con `_id: 'reminders'` / `'recurring_tasks'` quedan
    // huérfanos sin uso — la migración no los toca; quedan como historia.
  }

  /**
   * Counter per-user. `name` es 'reminders' o 'recurring_tasks'.
   * Cada user empieza fresh en 1. Los ids siguen siendo cortos en prompts del
   * LLM ("reminder 3") porque viven dentro del scope del user.
   */
  private async getNextSequence(userId: string, name: 'reminders' | 'recurring_tasks'): Promise<number> {
    const result = await this.counterCollection.findOneAndUpdate(
      { _id: `${name}:${userId}` },
      { $inc: { seq: 1 } },
      { returnDocument: 'after', upsert: true },
    );
    if (!result?.seq || result.seq < 1) {
      // No fallback silencioso: si Mongo devolvió un seq inválido, fail-loud.
      throw new Error(`Counter '${name}:${userId}' returned invalid seq: ${result?.seq}`);
    }
    return result.seq;
  }

  // ===========================================================================
  // Reminders
  // ===========================================================================

  async createReminder(
    userId: string,
    channelId: string,
    message: string,
    scheduledTime: number,
    timezone?: string,
    workspaceId?: string,
    idempotencyKey?: string,
  ): Promise<Reminder> {
    // Idempotency: si el caller pasa key y ya existe un reminder con la
    // misma key+user, retornar el existente (no crear duplicado).
    if (idempotencyKey) {
      const existing = await this.reminders.findOne({
        user_id: userId,
        idempotency_key: idempotencyKey,
      });
      if (existing) return existing;
    }
    const id = await this.getNextSequence(userId, 'reminders');
    const reminder: Reminder = {
      id,
      user_id: userId,
      channel_id: channelId,
      message,
      scheduled_time: scheduledTime,
      created_at: Date.now(),
      status: 'pending',
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
      ...(timezone ? { timezone } : {}),
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    };
    const result = await this.reminders.insertOne(reminder as Reminder & { _id?: ObjectId });
    reminder._id = result.insertedId;
    return reminder;
  }

  /**
   * Reminders pending y vencidos para el executor. NO filtra por user — el
   * executor recorre todos los users. Excluye `__orphaned__` para que docs
   * legacy sin owner resoluble nunca disparen. NO incluye `dispatching` —
   * el atomic claim los excluye por design.
   */
  async getPendingDueReminders(): Promise<Reminder[]> {
    return await this.reminders
      .find({
        status: 'pending',
        scheduled_time: { $lte: Date.now() },
        user_id: { $ne: ORPHANED_USER_ID },
      })
      .sort({ scheduled_time: 1 })
      .toArray();
  }

  async listReminders(query: RemindersQuery): Promise<PageResult<Reminder>> {
    const limit = clampLimit(query.limit);
    const filter: Filter<Reminder> = { user_id: query.userId };
    if (query.channelId) filter.channel_id = query.channelId;
    if (query.status) filter.status = query.status;
    if (query.scheduledBefore !== undefined) {
      filter.scheduled_time = { ...(filter.scheduled_time as object | undefined), $lte: query.scheduledBefore };
    }
    if (query.scheduledAfter !== undefined) {
      filter.scheduled_time = { ...(filter.scheduled_time as object | undefined), $gte: query.scheduledAfter };
    }

    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      if (c) {
        filter.$or = [
          { scheduled_time: { $gt: c.scheduledTime } },
          { scheduled_time: c.scheduledTime, id: { $gt: c.id } },
        ];
      }
    }

    const items = await this.reminders.find(filter).sort({ scheduled_time: 1, id: 1 }).limit(limit + 1).toArray();
    const hasMore = items.length > limit;
    const sliced = hasMore ? items.slice(0, limit) : items;
    const last = sliced[sliced.length - 1];
    return {
      items: sliced,
      nextCursor: hasMore && last?.id !== undefined ? encodeCursor(last.scheduled_time, last.id) : undefined,
    };
  }

  async getReminder(id: number, userId: string): Promise<Reminder | null> {
    return await this.reminders.findOne({ id, user_id: userId });
  }

  /**
   * Update atómico con filter compuesto. Si retorna null:
   * - El reminder no existe, o
   * - No pertenece al user, o
   * - Ya no está pending.
   * El caller (handler) re-lee si necesita distinguir entre `NOT_FOUND` y
   * `ALREADY_TERMINAL` (UX: noop vs error).
   */
  async updateReminder(
    id: number,
    userId: string,
    patch: Partial<Pick<Reminder, 'message' | 'scheduled_time' | 'timezone'>>,
  ): Promise<Reminder | null> {
    const set: Record<string, unknown> = {};
    if (patch.message !== undefined) set.message = patch.message;
    if (patch.scheduled_time !== undefined) set.scheduled_time = patch.scheduled_time;
    if (patch.timezone !== undefined) set.timezone = patch.timezone;
    if (Object.keys(set).length === 0) return await this.reminders.findOne({ id, user_id: userId });
    const result = await this.reminders.findOneAndUpdate(
      { id, user_id: userId, status: 'pending' },
      { $set: set },
      { returnDocument: 'after' },
    );
    return result ?? null;
  }

  /**
   * Cancelación atómica. Retorna el documento actualizado, o null si no
   * pertenece al user / no existe / no estaba pending.
   */
  async cancelReminder(id: number, userId: string): Promise<Reminder | null> {
    const result = await this.reminders.findOneAndUpdate(
      { id, user_id: userId, status: 'pending' },
      { $set: { status: 'cancelled', terminal_at: new Date() } },
      { returnDocument: 'after' },
    );
    return result ?? null;
  }

  /**
   * Bulk-cancel con scope user. El cap MAX_BULK_CANCEL evita updateMany
   * ilimitado (audit robustez m-3). Si más matches que el cap, lanza error;
   * el caller debe narrowar el filter o paginar.
   */
  async bulkCancelReminders(filter: BulkCancelFilter): Promise<number[]> {
    const mongoFilter: Filter<Reminder> = { user_id: filter.userId, status: 'pending' };
    if (filter.channelId) mongoFilter.channel_id = filter.channelId;
    if (filter.before !== undefined) mongoFilter.scheduled_time = { $lte: filter.before };
    if (filter.ids && filter.ids.length > 0) mongoFilter.id = { $in: filter.ids };

    const totalCount = await this.reminders.countDocuments(mongoFilter);
    if (totalCount > MAX_BULK_CANCEL) {
      throw new Error(
        `Bulk cancel would affect ${totalCount} reminders (cap: ${MAX_BULK_CANCEL}). Narrow your filter or call multiple times.`,
      );
    }

    const matching = await this.reminders.find(mongoFilter, { projection: { id: 1, _id: 0 } }).toArray();
    const ids = matching.map((m) => m.id).filter((v): v is number => typeof v === 'number');
    if (ids.length === 0) return [];

    await this.reminders.updateMany(
      { id: { $in: ids }, user_id: filter.userId, status: 'pending' },
      { $set: { status: 'cancelled', terminal_at: new Date() } },
    );
    return ids;
  }

  /**
   * Marca como sent. Guard acepta tanto `pending` como `dispatching` (atomic
   * claim del executor mueve a `dispatching` antes del dispatch). Si el user
   * canceló entre claim y mark, la cancelación gana (filter no matchea).
   * (audit robustez M-1, C-1)
   */
  async markAsSent(id: number, userId: string): Promise<boolean> {
    const result = await this.reminders.updateOne(
      { id, user_id: userId, status: { $in: ['pending', 'dispatching'] } },
      { $set: { status: 'sent', terminal_at: new Date() } },
    );
    return result.modifiedCount > 0;
  }

  /**
   * Atomic claim para el executor (audit robustez C-1, C-2): mueve un
   * reminder de `pending` → `dispatching` con compare-and-set. Si retorna
   * null, otro proceso (o el mismo proceso en una iteración solapada) ya lo
   * claimeó, o el reminder no existe / no está pending. El executor llama
   * dispatch solo sobre los docs que claim retorna.
   *
   * El status `dispatching` queda visible: si el proceso crashea entre
   * claim y `markAsSent`, el doc queda en `dispatching` para audit. Un
   * reaper (PR follow-up) puede revivirlos via `reclaimStaleDispatching`.
   */
  async claimReminderForDispatch(id: number, userId: string): Promise<Reminder | null> {
    const result = await this.reminders.findOneAndUpdate(
      { id, user_id: userId, status: 'pending' },
      { $set: { status: 'dispatching', dispatching_at: new Date() } },
      { returnDocument: 'after' },
    );
    return result ?? null;
  }

  /**
   * Marca como failed cuando el dispatch falla irreversiblemente (cron sin
   * nextRun, errores no recuperables). El TTL terminal lo purga después.
   */
  async markAsFailed(id: number, userId: string, error?: string): Promise<boolean> {
    const result = await this.reminders.updateOne(
      { id, user_id: userId, status: { $in: ['pending', 'dispatching'] } },
      { $set: { status: 'failed', terminal_at: new Date(), last_error: error?.slice(0, 500) } },
    );
    return result.modifiedCount > 0;
  }

  async countActiveReminders(userId: string): Promise<number> {
    return await this.reminders.countDocuments({ user_id: userId, status: 'pending' });
  }

  // ===========================================================================
  // Recurring tasks
  // ===========================================================================

  async createRecurringTask(
    userId: string,
    channelId: string,
    message: string,
    cronExpression: string,
    nextRun: number,
    timezone: string,
    workspaceId?: string,
    idempotencyKey?: string,
  ): Promise<RecurringTask> {
    if (idempotencyKey) {
      const existing = await this.recurringTasks.findOne({
        user_id: userId,
        idempotency_key: idempotencyKey,
      });
      if (existing) return existing;
    }
    const id = await this.getNextSequence(userId, 'recurring_tasks');
    const task: RecurringTask = {
      id,
      user_id: userId,
      channel_id: channelId,
      message,
      cron_expression: cronExpression,
      timezone,
      enabled: true,
      next_run: nextRun,
      created_at: Date.now(),
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    };
    const result = await this.recurringTasks.insertOne(task as RecurringTask & { _id?: ObjectId });
    task._id = result.insertedId;
    return task;
  }

  async getDueRecurringTasks(): Promise<RecurringTask[]> {
    return await this.recurringTasks
      .find({
        enabled: true,
        next_run: { $lte: Date.now() },
        user_id: { $ne: ORPHANED_USER_ID },
      })
      .sort({ next_run: 1 })
      .toArray();
  }

  async listRecurringTasks(query: RecurringTasksQuery): Promise<PageResult<RecurringTask>> {
    const limit = clampLimit(query.limit);
    const filter: Filter<RecurringTask> = { user_id: query.userId };
    if (query.channelId) filter.channel_id = query.channelId;
    if (query.enabled !== undefined) filter.enabled = query.enabled;

    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      if (c) {
        filter.$or = [
          { next_run: { $gt: c.scheduledTime } },
          { next_run: c.scheduledTime, id: { $gt: c.id } },
        ];
      }
    }

    const items = await this.recurringTasks.find(filter).sort({ next_run: 1, id: 1 }).limit(limit + 1).toArray();
    const hasMore = items.length > limit;
    const sliced = hasMore ? items.slice(0, limit) : items;
    const last = sliced[sliced.length - 1];
    return {
      items: sliced,
      nextCursor: hasMore && last?.id !== undefined ? encodeCursor(last.next_run, last.id) : undefined,
    };
  }

  async getRecurringTask(id: number, userId: string): Promise<RecurringTask | null> {
    return await this.recurringTasks.findOne({ id, user_id: userId });
  }

  async updateRecurringTask(
    id: number,
    userId: string,
    patch: Partial<Pick<RecurringTask, 'message' | 'cron_expression' | 'timezone' | 'next_run' | 'enabled'>>,
  ): Promise<RecurringTask | null> {
    const set: Record<string, unknown> = {};
    if (patch.message !== undefined) set.message = patch.message;
    if (patch.cron_expression !== undefined) set.cron_expression = patch.cron_expression;
    if (patch.timezone !== undefined) set.timezone = patch.timezone;
    if (patch.next_run !== undefined) set.next_run = patch.next_run;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (Object.keys(set).length === 0) return await this.recurringTasks.findOne({ id, user_id: userId });
    const result = await this.recurringTasks.findOneAndUpdate(
      { id, user_id: userId },
      { $set: set },
      { returnDocument: 'after' },
    );
    return result ?? null;
  }

  /**
   * Avanza el `next_run` tras una ejecución exitosa. Guard `enabled: true`
   * evita sobrescribir si el user deshabilitó la task entre find y update.
   */
  async updateRecurringTaskNextRun(
    id: number,
    userId: string,
    nextRun: number,
    lastRun: number,
  ): Promise<boolean> {
    const result = await this.recurringTasks.updateOne(
      { id, user_id: userId, enabled: true },
      { $set: { next_run: nextRun, last_run: lastRun } },
    );
    return result.modifiedCount > 0;
  }

  async setRecurringEnabled(id: number, userId: string, enabled: boolean): Promise<RecurringTask | null> {
    const result = await this.recurringTasks.findOneAndUpdate(
      { id, user_id: userId },
      { $set: { enabled } },
      { returnDocument: 'after' },
    );
    return result ?? null;
  }

  async deleteRecurringTask(id: number, userId: string): Promise<RecurringTask | null> {
    const result = await this.recurringTasks.findOneAndDelete({ id, user_id: userId });
    return result ?? null;
  }

  async countActiveRecurringTasks(userId: string): Promise<number> {
    return await this.recurringTasks.countDocuments({ user_id: userId, enabled: true });
  }

  /**
   * Reset `consecutive_failures` a 0 tras un dispatch exitoso. Audit robustez
   * fix #2: sin esto, un dispatch que recupera tras fallos previos no resetea
   * el contador y dispara el auto-disable en el siguiente fallo.
   */
  async resetTaskFailures(id: number, userId: string): Promise<void> {
    await this.recurringTasks.updateOne(
      { id, user_id: userId },
      { $set: { consecutive_failures: 0 }, $unset: { last_error: '' } },
    );
  }

  /**
   * Incrementa `consecutive_failures`. Si llega al cap, deshabilita la task
   * y retorna `{ disabled: true, failureCount }`. Si no, `{ disabled: false,
   * failureCount }`. Atómico via findOneAndUpdate.
   */
  async incrementTaskFailures(
    id: number,
    userId: string,
    error: string,
    cap: number,
  ): Promise<{ disabled: boolean; failureCount: number } | null> {
    const result = await this.recurringTasks.findOneAndUpdate(
      { id, user_id: userId },
      {
        $inc: { consecutive_failures: 1 },
        $set: { last_error: error.slice(0, 500) },
      },
      { returnDocument: 'after' },
    );
    if (!result) return null;
    const failureCount = result.consecutive_failures ?? 0;
    if (failureCount >= cap) {
      await this.recurringTasks.updateOne(
        { id, user_id: userId },
        { $set: { enabled: false } },
      );
      return { disabled: true, failureCount };
    }
    return { disabled: false, failureCount };
  }

  // ===========================================================================
  // Executions
  // ===========================================================================

  async recordExecution(
    userId: string,
    taskId: number,
    status: Execution['status'],
    ranAt = Date.now(),
    error?: string,
  ): Promise<void> {
    await this.executions.insertOne({
      user_id: userId,
      task_id: taskId,
      ran_at: ranAt,
      status,
      ...(error ? { error } : {}),
    } as Execution & { _id?: ObjectId });
  }

  async listExecutions(query: ExecutionsQuery): Promise<PageResult<Execution>> {
    const cap = clampLimit(query.limit);
    const filter: Filter<Execution> = { user_id: query.userId, task_id: query.taskId };
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      if (c) filter.ran_at = { $lt: c.scheduledTime };
    }
    const items = await this.executions.find(filter).sort({ ran_at: -1 }).limit(cap + 1).toArray();
    const hasMore = items.length > cap;
    const sliced = hasMore ? items.slice(0, cap) : items;
    const last = sliced[sliced.length - 1];
    return {
      items: sliced,
      nextCursor: hasMore && last ? encodeCursor(last.ran_at, last.task_id) : undefined,
    };
  }

  async getNextScheduledTimestamp(userId: string): Promise<number | null> {
    const reminder = await this.reminders.findOne(
      { user_id: userId, status: 'pending' },
      { sort: { scheduled_time: 1 }, projection: { scheduled_time: 1, _id: 0 } },
    );
    const task = await this.recurringTasks.findOne(
      { user_id: userId, enabled: true },
      { sort: { next_run: 1 }, projection: { next_run: 1, _id: 0 } },
    );
    const r = reminder?.scheduled_time;
    const t = task?.next_run;
    if (r === undefined && t === undefined) return null;
    if (r === undefined) return t!;
    if (t === undefined) return r;
    return Math.min(r, t);
  }

  async close(): Promise<void> {
    await this.client.close();
    this.connected = false;
  }
}
