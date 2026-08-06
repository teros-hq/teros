/**
 * Scheduler — tipos canónicos compartidos entre MCA, backend executor y WsRouter.
 *
 * Estos tipos son fuente única de verdad para los documentos almacenados en
 * las collections `scheduler_reminders`, `scheduler_recurring_tasks` y
 * `scheduler_executions`. Se consumen desde:
 *
 *   - `mcas/mca.teros.scheduler/src/db.ts`                          (CRUD del MCA)
 *   - `packages/backend/src/services/scheduler-service.ts`          (executor)
 *   - `packages/backend/src/handlers/domains/scheduler/_helpers.ts` (WsRouter mirror)
 *
 * Histórico: cada uno de esos tres sitios mantenía su propia versión del
 * shape, lo que produjo drift documentado en el audit TER-358 (p.ej.
 * `_helpers.ts` tenía `timezone?` en `RecurringTask` pero `scheduler-service.ts`
 * no). Cualquier cambio al schema debe hacerse aquí.
 *
 * Notas de aislamiento (TER-358):
 *
 *   - `user_id` es REQUIRED en cualquier documento creado a partir de v1.1.0.
 *     Se marca opcional aquí solo para tolerar documentos legacy entre la
 *     llegada de este código y el primer arranque del MCA (que ejecuta la
 *     migración `user_id_backfill_v1`). Las queries del MCA NUNCA aceptan
 *     `user_id` opcional — siempre se exige al boundary del handler.
 *   - `workspace_id` queda opcional indefinidamente; se persiste si la app
 *     está instalada en un workspace pero todavía no se usa para visibilidad
 *     compartida.
 *   - `ORPHANED_USER_ID` es el sentinel que la migración pone a documentos
 *     cuyo `channel_id` ya no existe en `channels` (el user dueño no se
 *     puede resolver). Las queries normales lo excluyen.
 */

/**
 * Sentinel asignado por la migración `user_id_backfill_v1` a documentos
 * cuyo channel no se pudo resolver para extraer el `userId` dueño.
 * Excluido en queries normales del MCA y del executor.
 */
export const ORPHANED_USER_ID = '__orphaned__';

/**
 * Cap para `consecutive_failures` de recurring tasks: tras N fallos seguidos
 * el executor pone `enabled: false` y registra una Execution failure final.
 * Evita runaway loops contra un downstream caído.
 */
export const RECURRING_FAILURE_CAP = 5;

/**
 * TTL para reminders en estado terminal (`sent`/`cancelled`/`failed`).
 * El índice TTL los purga automáticamente tras este periodo. Valor en
 * segundos, default 30 días.
 */
export const TERMINAL_REMINDER_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Estados del reminder:
 *
 *   - `pending`     — programado, esperando turno.
 *   - `dispatching` — el executor lo está procesando (atomic claim). Si el
 *                     proceso crashea antes de marcar `sent`, queda visible
 *                     para auditoría y futuro lease-reclaim por TTL.
 *   - `sent`        — entregado al subscriber.
 *   - `cancelled`   — cancelado por el user.
 *   - `failed`      — dispatch falló N veces consecutivas; deshabilitado.
 */
export type ReminderStatus = 'pending' | 'dispatching' | 'sent' | 'cancelled' | 'failed';

export interface Reminder {
  _id?: unknown;
  id?: number;
  /**
   * REQUIRED en docs nuevos. Opcional aquí solo para tolerar legacy
   * pre-migración. Las queries del MCA exigen `userId` no nulo al boundary.
   */
  user_id?: string;
  workspace_id?: string;
  channel_id: string;
  message: string;
  scheduled_time: number;
  created_at: number;
  status: ReminderStatus;
  /** IANA timezone usada en el momento de programar. */
  timezone?: string;
  /**
   * Timestamp del momento en que el executor claimeó el reminder (status →
   * `dispatching`). Set por `claimReminderForDispatch`. Útil para reaper de
   * docs huérfanos en `dispatching` tras crash del executor.
   */
  dispatching_at?: Date;
  /**
   * Timestamp de la transición a estado terminal (`sent`/`cancelled`/`failed`).
   * Indexado con TTL para purge automático tras N días.
   */
  terminal_at?: Date;
  /** Último error si pasó a `failed`. Limitado a 500 chars. */
  last_error?: string;
  /**
   * Idempotency key opcional. Si el handler recibe esta key en input y ya
   * existe un reminder con `{user_id, idempotency_key}` matching, retorna el
   * existente en lugar de crear duplicado. Útil cuando el LLM reintenta tras
   * un 5xx transitorio. Cap 128 chars.
   */
  idempotency_key?: string;
}

export interface RecurringTask {
  _id?: unknown;
  id?: number;
  user_id?: string;
  workspace_id?: string;
  channel_id: string;
  message: string;
  cron_expression: string;
  timezone: string;
  enabled: boolean;
  last_run?: number;
  next_run: number;
  created_at: number;
  /**
   * Número de dispatches que fallaron consecutivamente. Si llega al cap,
   * el executor pone `enabled: false` y registra un `Execution{status:'failure'}`.
   * Reset a 0 al primer dispatch exitoso. Persisted by the executor backend.
   */
  consecutive_failures?: number;
  /** Último error capturado por el executor (string compacto para debug). */
  last_error?: string;
  /** Idempotency key opcional. Ver `Reminder.idempotency_key`. */
  idempotency_key?: string;
}

export type ExecutionStatus = 'success' | 'failure' | 'skipped';

export interface Execution {
  _id?: unknown;
  user_id?: string;
  task_id: number;
  ran_at: number;
  status: ExecutionStatus;
  error?: string;
}

export interface PageResult<T> {
  items: T[];
  nextCursor?: string;
}

/**
 * Query shape para listar reminders. `userId` es REQUIRED — sin él la query
 * sería cross-tenant. El executor backend NO usa este shape: hace `find`
 * direct sin filtrar por user (recorre tareas de todos los users para
 * disparar).
 */
export interface RemindersQuery {
  userId: string;
  channelId?: string;
  status?: ReminderStatus;
  scheduledBefore?: number;
  scheduledAfter?: number;
  limit?: number;
  cursor?: string;
}

export interface RecurringTasksQuery {
  userId: string;
  channelId?: string;
  enabled?: boolean;
  limit?: number;
  cursor?: string;
}

export interface BulkCancelFilter {
  userId: string;
  channelId?: string;
  before?: number;
  ids?: number[];
}

export interface ExecutionsQuery {
  userId: string;
  taskId: number;
  limit?: number;
  cursor?: string;
}

/**
 * Payload del evento que `SchedulerService` (backend executor) emite a
 * `MCAEventSubscriptionService` al disparar un reminder o recurring task.
 * Incluye `userId` para que la Capa 4 (dispatch) pueda re-validar
 * `channel.userId === payload.userId` antes del wake-up del agente.
 */
export interface ScheduledReminderPayload {
  userId: string;
  channelId: string;
  message: string;
  reminderId: number;
}

export interface ScheduledRecurringTaskPayload {
  userId: string;
  channelId: string;
  message: string;
  taskId: number;
  cronExpression: string;
}
