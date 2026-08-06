/**
 * Scheduler Service — executor de reminders y recurring tasks.
 *
 * Tick recursivo (setTimeout) cada `CHECK_INTERVAL_MS` con guard `isChecking`
 * para evitar iteraciones solapadas si una vuelta tarda más que el intervalo.
 *
 * # Defensa en profundidad (TER-358)
 *
 *   - **Capa 3 pre-dispatch**: verifica `channel.userId === doc.user_id`
 *     antes de cada dispatch. Documentos `__orphaned__` quedan excluidos en
 *     el find inicial.
 *   - Capa 4 está en `mca-event-subscription-service` (re-valida payload.userId
 *     contra channel.userId justo antes del wake-up).
 *
 * # Robustez (TER-358 Round 2)
 *
 *   - **Atomic claim** (audit robustez C-1, C-2): reminders se mueven a
 *     `status: 'dispatching'` antes del dispatch via `claimReminderForDispatch`.
 *     Solo un proceso gana. Si dispatch crashea, el doc queda en `dispatching`
 *     para inspección (reaper en follow-up).
 *   - **isChecking guard** (audit C-3): si la iteración previa todavía corre,
 *     skip el tick. Evita N iteraciones solapadas contra Mongo lento.
 *   - **next_run en finally + auto-disable** (audit C-3 recurring): el avance
 *     de `next_run` ocurre SIEMPRE en `finally`, incluso si el dispatch falló.
 *     `consecutive_failures` se incrementa; tras `RECURRING_FAILURE_CAP` la
 *     task se deshabilita. Reset a 0 tras un dispatch exitoso.
 *   - **fail-loud cron** (audit C-4): si `getNextCronRun` lanza o devuelve
 *     null, la task se marca como failed y se deshabilita. Sin fallback +1h.
 *   - **Subscription auto-recreate** (causa #1 del bug reportado): si el
 *     dispatch retorna `channelMatched: 0` para un topic scheduler.*, re-crea
 *     la subscription. Esto cubre el caso de TTL expiration silente.
 *   - **recordExecution wire-up** (audit m-7): cada ejecución se registra
 *     (success/failure + error). `list-executions` deja de ser feature muerta.
 */

import type { Collection, Db } from 'mongodb';
import {
  ORPHANED_USER_ID,
  RECURRING_FAILURE_CAP,
  type Reminder,
  type RecurringTask,
  type ScheduledReminderPayload,
  type ScheduledRecurringTaskPayload,
} from '@teros/shared';
import { getNextCronRun } from '../handlers/domains/scheduler/_helpers';
import type { EventHandler } from '../handlers/event-handler';
import { captureException } from '../lib/sentry';
import type { MCAEventSubscriptionService } from './mca-event-subscription-service';
import type { ChannelManager } from './channel-manager';
import { LEADER_LOCKS, type LeaderElectionService } from './leader-election';

const CHECK_INTERVAL_MS = 30_000; // 30 seconds
const MAX_TICK_DURATION_MS = 5 * 60 * 1000; // log warn si un tick tarda más de 5 min

export type { Reminder, RecurringTask } from '@teros/shared';

export type GetChannelOwnerUserIdFn = (channelId: string) => Promise<string | null>;

/**
 * Billing pre-check for a channel's agent before dispatching. Returns
 * `{ allowed: false }` to skip dispatch (e.g. plan does not include the Teros
 * model, or agent hours are exhausted). UX-only: the structural gate in
 * ProviderService still protects cost at dispatch time. Injected by bootstrap.
 */
export type CanDispatchToChannelFn = (
  channelId: string,
) => Promise<{ allowed: boolean; reason?: string }>;

export class SchedulerService {
  private db: Db;
  private remindersCollection: Collection<Reminder>;
  private recurringTasksCollection: Collection<RecurringTask>;
  private executionsCollection: Collection<{
    user_id?: string;
    task_id: number;
    ran_at: number;
    status: 'success' | 'failure' | 'skipped';
    error?: string;
  }>;
  private eventHandler: EventHandler;
  private mcaEventSubscriptionService?: MCAEventSubscriptionService;
  private getChannelOwnerUserIdFn?: GetChannelOwnerUserIdFn;
  private canDispatchToChannelFn?: CanDispatchToChannelFn;
  private leaderElection?: LeaderElectionService;
  private checkTimeout: ReturnType<typeof setTimeout> | null = null;
  private isChecking = false;
  private stopped = false;

  constructor(
    db: Db,
    eventHandler: EventHandler,
    mcaEventSubscriptionService?: MCAEventSubscriptionService,
  ) {
    this.db = db;
    this.eventHandler = eventHandler;
    this.mcaEventSubscriptionService = mcaEventSubscriptionService;
    this.remindersCollection = db.collection<Reminder>('scheduler_reminders');
    this.recurringTasksCollection = db.collection<RecurringTask>('scheduler_recurring_tasks');
    this.executionsCollection = db.collection('scheduler_executions');
  }

  setMCAEventSubscriptionService(service: MCAEventSubscriptionService): void {
    this.mcaEventSubscriptionService = service;
  }

  setGetChannelOwnerUserIdFn(fn: GetChannelOwnerUserIdFn): void {
    this.getChannelOwnerUserIdFn = fn;
  }

  setCanDispatchToChannelFn(fn: CanDispatchToChannelFn): void {
    this.canDispatchToChannelFn = fn;
  }

  /**
   * Inyecta el leader-election para gatear el tick en multi-instancia. Sin él
   * (single-instance / tests) el tick corre siempre. El atomic claim por
   * task/reminder es la defensa independiente del lock (cubre TTL/fallover).
   */
  setLeaderElection(le: LeaderElectionService): void {
    this.leaderElection = le;
  }

  bindChannelManager(channelManager: ChannelManager): void {
    this.setGetChannelOwnerUserIdFn(async (channelId) => {
      const channel = await channelManager.getChannel(channelId as any);
      return channel?.userId ?? null;
    });
  }

  start(): void {
    console.log('[SchedulerService] starting (recursive tick + isChecking guard)');
    this.stopped = false;
    void this.runTick();
  }

  stop(): void {
    this.stopped = true;
    if (this.checkTimeout) {
      clearTimeout(this.checkTimeout);
      this.checkTimeout = null;
    }
    console.log('[SchedulerService] stopped');
  }

  /**
   * Tick recursivo con guard: el siguiente tick se agenda en el `finally`
   * del current. Si una iteración tarda más que `CHECK_INTERVAL_MS`, la
   * siguiente arranca inmediatamente al terminar — nunca solapamos.
   * (audit robustez C-2 / C-3)
   */
  private async runTick(): Promise<void> {
    if (this.stopped) return;
    if (this.isChecking) {
      // Defensa adicional — no debería ocurrir con setTimeout recursivo.
      console.warn('[SchedulerService] tick already in flight, skipping');
      this.scheduleNextTick();
      return;
    }
    // Leader gating (multi-instancia): solo el líder ejecuta el tick. Sin
    // leaderElection (single-instance / tests) corre siempre. tryAcquire
    // re-adquiere si ya somos dueños (heartbeat implícito); ttl = 2× intervalo
    // para no perder el lock en un tick lento. Fail-closed: si no podemos
    // confirmar liderazgo, saltamos este tick y reintentamos en el siguiente.
    if (this.leaderElection) {
      let acquired = false;
      try {
        acquired = await this.leaderElection.tryAcquire(
          LEADER_LOCKS.Scheduler,
          CHECK_INTERVAL_MS * 2,
        );
      } catch (err) {
        console.error('[SchedulerService] leader acquire failed, skipping tick:', err);
      }
      if (!acquired) {
        this.scheduleNextTick();
        return;
      }
    }
    this.isChecking = true;
    const tickStart = Date.now();
    try {
      await this.checkReminders();
      await this.checkRecurringTasks();
    } catch (error) {
      console.error('[SchedulerService] tick error:', error);
      captureException(error, { context: 'scheduler-tick' });
    } finally {
      const tickDuration = Date.now() - tickStart;
      if (tickDuration > MAX_TICK_DURATION_MS) {
        console.warn(`[SchedulerService] slow tick: ${tickDuration}ms`);
      }
      this.isChecking = false;
      this.scheduleNextTick();
    }
  }

  private scheduleNextTick(): void {
    if (this.stopped) return;
    this.checkTimeout = setTimeout(() => void this.runTick(), CHECK_INTERVAL_MS);
  }

  /**
   * Capa 3 — verifica que `channel.userId === expectedUserId` antes del
   * dispatch. Sin resolver inyectado, log warn y trust Capa 4.
   */
  private async verifyOwnership(
    channelId: string,
    expectedUserId: string | undefined,
  ): Promise<boolean> {
    if (!expectedUserId || expectedUserId === ORPHANED_USER_ID) return false;
    if (!this.getChannelOwnerUserIdFn) {
      console.warn(
        '[SchedulerService] getChannelOwnerUserIdFn not set — Capa 3 ownership check skipped. ' +
          'Capa 4 (mca-event-subscription-service) will still enforce.',
      );
      return true;
    }
    const ownerUserId = await this.getChannelOwnerUserIdFn(channelId);
    if (ownerUserId !== expectedUserId) {
      console.error(
        `[SchedulerService] Capa 3 ownership mismatch: channel ${channelId} owner=${ownerUserId} expected=${expectedUserId}. Skipping dispatch.`,
      );
      captureException(new Error('scheduler-ownership-mismatch'), {
        context: 'scheduler-ownership-mismatch',
        channelId,
        expectedUserId,
        actualOwnerUserId: ownerUserId,
      });
      return false;
    }
    return true;
  }

  /**
   * Auto-recreate de la subscription si el dispatch no encontró subscribers.
   * Causa #1 del bug reportado por la compañera: TTL sliding expira la sub
   * en periodos largos sin eventos, y al dispatchar después nadie escucha.
   *
   * Sin opt-in en MCAEventSubscriptionService, el dispatch silenciosamente
   * pierde el evento. Aquí re-creamos via la misma API que usa el handler de
   * create-reminder/create-recurring-task del MCA.
   */
  private async ensureSubscriptionForChannel(
    topic: 'scheduler.reminder' | 'scheduler.recurring_task',
    channelId: string,
  ): Promise<void> {
    if (!this.mcaEventSubscriptionService) return;
    try {
      await this.mcaEventSubscriptionService.createChannelSubscription({
        topic,
        channelId,
        rules: [{ channelId }],
        mode: 'wake',
      });
      console.log(
        `[SchedulerService] re-created subscription ${topic} for channel ${channelId} (likely TTL-expired)`,
      );
    } catch (err) {
      console.error('[SchedulerService] failed to re-create subscription:', err);
      captureException(err, { context: 'scheduler-resubscribe', topic, channelId });
    }
  }

  /**
   * Check for pending reminders that are due. Atomic claim → ownership check
   * → dispatch → markAsSent. Si falla → markAsFailed (no retry intentos).
   */
  private async checkReminders(): Promise<void> {
    const now = Date.now();
    const pendingReminders = await this.remindersCollection
      .find({
        status: 'pending',
        scheduled_time: { $lte: now },
        user_id: { $ne: ORPHANED_USER_ID },
      })
      .sort({ scheduled_time: 1 })
      .toArray();

    for (const reminder of pendingReminders) {
      await this.processReminder(reminder);
    }
  }

  private async processReminder(reminder: Reminder): Promise<void> {
    if (reminder.id === undefined) return;
    const reminderId = reminder.id;
    // El `id` de los reminders es un counter PER-USER (igual que las recurring
    // tasks): dos usuarios pueden compartir `id`. Todos los writes (claim +
    // transiciones terminales) DEBEN filtrar por user_id, o el CAS reclamaría
    // el reminder de OTRO usuario (incluso uno no vencido) y lo dispararía
    // antes de tiempo, dejando el nuestro atascado. Misma clase que el bug de
    // recurring tasks (cross-user por filtrar solo por id).
    if (!reminder.user_id) {
      console.error(
        `[SchedulerService] reminder ${reminderId} has no user_id — skipping (cannot scope writes safely)`,
      );
      return;
    }
    const userId = reminder.user_id;
    let dispatched = false;
    let dispatchError: string | undefined;

    try {
      // Atomic claim (CAS): pending → dispatching. Solo un proceso gana.
      // Scopeado por user_id + scheduled_time para no reclamar el reminder de
      // otro usuario ni uno aún no vencido.
      const claimed = await this.remindersCollection.findOneAndUpdate(
        { id: reminderId, user_id: userId, status: 'pending', scheduled_time: { $lte: Date.now() } },
        { $set: { status: 'dispatching', dispatching_at: new Date() } },
        { returnDocument: 'after' },
      );
      if (!claimed) {
        // Otro proceso (o la misma iteración previa) ya lo cogió.
        return;
      }

      // Capa 3: verify ownership.
      const ok = await this.verifyOwnership(claimed.channel_id, claimed.user_id);
      if (!ok) {
        // Skip dispatch. Marcamos como failed para que no quede atascado.
        await this.remindersCollection.updateOne(
          { id: reminderId, user_id: userId, status: 'dispatching' },
          {
            $set: {
              status: 'failed',
              terminal_at: new Date(),
              last_error: 'ownership-mismatch',
            },
          },
        );
        return;
      }

      // Billing hard gate (UX): mark failed instead of dispatching a turn that
      // the structural gate would block, so the user sees a clear billing
      // failure rather than an error bubble from a scheduled reminder.
      if (this.canDispatchToChannelFn) {
        const gate = await this.canDispatchToChannelFn(claimed.channel_id);
        if (!gate.allowed) {
          await this.remindersCollection.updateOne(
            { id: reminderId, user_id: userId, status: 'dispatching' },
            {
              $set: {
                status: 'failed',
                terminal_at: new Date(),
                last_error: gate.reason ?? 'billing-denied',
              },
            },
          );
          return;
        }
      }

      if (this.mcaEventSubscriptionService) {
        const payload: ScheduledReminderPayload = {
          userId: claimed.user_id!,
          channelId: claimed.channel_id,
          message: claimed.message,
          reminderId,
        };
        const result = await this.mcaEventSubscriptionService.dispatch({
          topic: 'scheduler.reminder',
          payload: payload as unknown as Record<string, unknown>,
        });

        if (result.channelMatched === 0 && result.agentMatched === 0) {
          // Causa #1 del bug de la compañera: la sub se expiró por TTL.
          // Re-crear y reintentar una vez.
          console.warn(
            `[SchedulerService] reminder ${reminderId} dispatched but no subscribers matched. Re-creating subscription.`,
          );
          await this.ensureSubscriptionForChannel('scheduler.reminder', claimed.channel_id);
          const retry = await this.mcaEventSubscriptionService.dispatch({
            topic: 'scheduler.reminder',
            payload: payload as unknown as Record<string, unknown>,
          });
          dispatched = retry.channelMatched > 0 || retry.agentMatched > 0;
          if (!dispatched) {
            dispatchError = 'no-subscribers-after-resubscribe';
          }
        } else {
          dispatched = true;
        }
      } else {
        // Fallback legacy: invocar EventHandler directo.
        const result = await this.eventHandler.handleScheduledEvent({
          channelId: claimed.channel_id,
          message: claimed.message,
          eventType: 'reminder',
          wakeUpAgent: true,
          metadata: { source: 'scheduler', reminderId },
        });
        dispatched = result.success;
        if (!dispatched) dispatchError = result.error;
      }
    } catch (error) {
      dispatchError = error instanceof Error ? error.message : String(error);
      console.error(`[SchedulerService] reminder ${reminderId} dispatch threw:`, error);
      captureException(error, {
        context: 'scheduler-process-reminder',
        reminderId,
        userId: reminder.user_id,
      });
    } finally {
      // Transición terminal: sent o failed. Filter `dispatching` para evitar
      // pisar un cancel que llegó entre claim y este punto.
      if (dispatched) {
        await this.remindersCollection.updateOne(
          { id: reminderId, user_id: userId, status: 'dispatching' },
          { $set: { status: 'sent', terminal_at: new Date() } },
        );
        console.log(`[SchedulerService] sent reminder ${reminderId}`);
      } else {
        await this.remindersCollection.updateOne(
          { id: reminderId, user_id: userId, status: 'dispatching' },
          {
            $set: {
              status: 'failed',
              terminal_at: new Date(),
              last_error: (dispatchError ?? 'unknown').slice(0, 500),
            },
          },
        );
        console.error(`[SchedulerService] reminder ${reminderId} marked failed: ${dispatchError}`);
      }
    }
  }

  /**
   * Check for recurring tasks that are due. Para cada task: ownership →
   * dispatch → recordExecution → avanzar next_run (en finally siempre).
   * `consecutive_failures` tracking + auto-disable tras N fallos.
   */
  private async checkRecurringTasks(): Promise<void> {
    const now = Date.now();
    const dueTasks = await this.recurringTasksCollection
      .find({
        enabled: true,
        next_run: { $lte: now },
        user_id: { $ne: ORPHANED_USER_ID },
      })
      .sort({ next_run: 1 })
      .toArray();

    for (const task of dueTasks) {
      await this.processRecurringTask(task);
    }
  }

  private async processRecurringTask(task: RecurringTask): Promise<void> {
    if (task.id === undefined) return;
    const taskId = task.id;
    // El `id` de las recurring tasks es un counter PER-USER (TER-358): dos
    // usuarios pueden tener legítimamente el mismo `id`. Sin `user_id` en el
    // filtro, un `updateOne({ id })` puede impactar la task de OTRO usuario,
    // dejando la nuestra sin avanzar `next_run` → re-dispatch cada tick (bucle
    // infinito). Todos los writes de abajo se scopean por `user_id`. Incidente
    // prod 2026-06-03: id=4 corrió 2.212 veces cada 30s.
    if (!task.user_id) {
      console.error(
        `[SchedulerService] recurring task ${taskId} has no user_id — skipping (cannot scope writes safely)`,
      );
      return;
    }
    const userId = task.user_id;
    const ranAt = Date.now();

    // 1) Computar el próximo next_run ANTES de dispatchar. Si el cron está roto,
    // deshabilitar (fail-loud) y salir sin reclamar el slot.
    let nextRun: number;
    try {
      nextRun = getNextCronRun(task.cron_expression, task.timezone);
    } catch (cronErr) {
      const err = cronErr instanceof Error ? cronErr.message : String(cronErr);
      console.error(
        `[SchedulerService] recurring task ${taskId} cron unparseable, disabling:`,
        err,
      );
      await this.recurringTasksCollection.updateOne(
        { id: taskId, user_id: userId },
        { $set: { enabled: false, last_error: `cron: ${err}`.slice(0, 500) } },
      );
      return;
    }

    // 2) Atomic claim (CAS): avanzar next_run ANTES del dispatch. El filtro
    // `next_run <= ranAt` garantiza que solo UN proceso/tick reclame este slot;
    // si otra instancia ya lo avanzó (ventana de fallover multi-instancia) o el
    // usuario deshabilitó la task, el claim devuelve null y salimos sin dispatch.
    // Semántica at-most-once-por-slot: un crash entre claim y dispatch se salta
    // ese slot — preferible a duplicar ejecuciones (lo opuesto al incidente).
    const claimed = await this.recurringTasksCollection.findOneAndUpdate(
      { id: taskId, user_id: userId, enabled: true, next_run: { $lte: ranAt } },
      { $set: { next_run: nextRun, last_run: ranAt } },
      { returnDocument: 'after' },
    );
    if (!claimed) return;

    // 3) Dispatch — ya somos dueños del slot (next_run avanzado).
    let success = false;
    let execError: string | undefined;

    try {
      const ok = await this.verifyOwnership(task.channel_id, userId);
      if (!ok) {
        execError = 'ownership-mismatch';
        return;
      }

      // Billing hard gate (UX): skip this occurrence; next_run already advanced,
      // so it retries automatically once the user has hours/plan again.
      if (this.canDispatchToChannelFn) {
        const gate = await this.canDispatchToChannelFn(task.channel_id);
        if (!gate.allowed) {
          execError = gate.reason ?? 'billing-denied';
          return;
        }
      }

      if (this.mcaEventSubscriptionService) {
        const payload: ScheduledRecurringTaskPayload = {
          userId: task.user_id!,
          channelId: task.channel_id,
          message: task.message,
          taskId,
          cronExpression: task.cron_expression,
        };
        const result = await this.mcaEventSubscriptionService.dispatch({
          topic: 'scheduler.recurring_task',
          payload: payload as unknown as Record<string, unknown>,
        });

        if (result.channelMatched === 0 && result.agentMatched === 0) {
          console.warn(
            `[SchedulerService] recurring task ${taskId} dispatched but no subscribers matched. Re-creating subscription.`,
          );
          await this.ensureSubscriptionForChannel('scheduler.recurring_task', task.channel_id);
          const retry = await this.mcaEventSubscriptionService.dispatch({
            topic: 'scheduler.recurring_task',
            payload: payload as unknown as Record<string, unknown>,
          });
          success = retry.channelMatched > 0 || retry.agentMatched > 0;
          if (!success) execError = 'no-subscribers-after-resubscribe';
        } else {
          success = true;
        }
      } else {
        const result = await this.eventHandler.handleScheduledEvent({
          channelId: task.channel_id,
          message: task.message,
          eventType: 'recurring_task',
          wakeUpAgent: true,
          metadata: {
            source: 'scheduler',
            taskId,
            cronExpression: task.cron_expression,
          },
        });
        success = result.success;
        if (!success) execError = result.error;
      }
    } catch (error) {
      execError = error instanceof Error ? error.message : String(error);
      console.error(`[SchedulerService] recurring task ${taskId} dispatch threw:`, error);
      captureException(error, {
        context: 'scheduler-process-recurring-task',
        taskId,
        userId: task.user_id,
      });
    } finally {
      // 4) Registrar execution (audit m-7). next_run ya fue avanzado por el claim.
      try {
        await this.executionsCollection.insertOne({
          user_id: userId,
          task_id: taskId,
          ran_at: ranAt,
          status: success ? 'success' : 'failure',
          ...(execError ? { error: execError.slice(0, 500) } : {}),
        });
      } catch (recErr) {
        console.error('[SchedulerService] failed to record execution:', recErr);
      }

      // 5) Tracking de fallos. next_run/last_run ya se avanzaron en el claim
      // (paso 2), aquí solo se ajustan consecutive_failures/last_error.
      if (success) {
        await this.recurringTasksCollection.updateOne(
          { id: taskId, user_id: userId, enabled: true },
          { $set: { consecutive_failures: 0 }, $unset: { last_error: '' } },
        );
        console.log(
          `[SchedulerService] task ${taskId} success, next: ${new Date(nextRun).toISOString()}`,
        );
      } else {
        // Incrementar failures (no atasco: next_run ya avanzó). Si supera el
        // cap, deshabilitar.
        const result = await this.recurringTasksCollection.findOneAndUpdate(
          { id: taskId, user_id: userId },
          {
            $inc: { consecutive_failures: 1 },
            $set: { last_error: (execError ?? 'unknown').slice(0, 500) },
          },
          { returnDocument: 'after' },
        );
        const failureCount = result?.consecutive_failures ?? 0;
        if (failureCount >= RECURRING_FAILURE_CAP) {
          await this.recurringTasksCollection.updateOne(
            { id: taskId, user_id: userId },
            { $set: { enabled: false } },
          );
          console.error(
            `[SchedulerService] task ${taskId} disabled after ${failureCount} consecutive failures`,
          );
          captureException(new Error('scheduler-task-disabled-after-failures'), {
            context: 'scheduler-task-disabled',
            taskId,
            failureCount,
            lastError: execError,
          });
        } else {
          console.warn(
            `[SchedulerService] task ${taskId} failed (${failureCount}/${RECURRING_FAILURE_CAP}): ${execError}`,
          );
        }
      }
    }
  }

  /**
   * Global stats — cross-user para dashboards admin. La tool `get-stats` del
   * MCA es per-user.
   */
  async getStats(): Promise<{ pendingReminders: number; enabledTasks: number }> {
    try {
      const pendingReminders = await this.remindersCollection.countDocuments({ status: 'pending' });
      const enabledTasks = await this.recurringTasksCollection.countDocuments({ enabled: true });
      return { pendingReminders, enabledTasks };
    } catch (error) {
      console.error('[SchedulerService] error getting stats:', error);
      return { pendingReminders: 0, enabledTasks: 0 };
    }
  }
}
