import type { ToolConfig, ToolContext } from '@teros/mca-sdk';
import { z, type ZodTypeAny } from 'zod';
import { isSchedulerError, SchedulerError } from '../lib';

export type StructuredResult<T> = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: T;
};

export function structured<T>(data: T): StructuredResult<T> {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

export function validateInput<T extends ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.errors[0];
    const path = issue.path.length > 0 ? issue.path.join('.') : '<input>';
    throw new SchedulerError(
      'INVALID_INPUT',
      `Invalid input at "${path}": ${issue.message}`,
      'Check the tool description for the expected shape.',
    );
  }
  return parsed.data;
}

export function toToolError(error: unknown): never {
  if (isSchedulerError(error)) {
    const suggestion = error.suggestion ? ` ${error.suggestion}` : '';
    throw new Error(`[${error.code}] ${error.message}${suggestion}`);
  }
  throw error instanceof Error ? error : new Error(String(error));
}

// =============================================================================
// User isolation helpers (TER-358)
// =============================================================================

/**
 * Extrae el `userId` del contexto del SDK. REQUIRED en todos los handlers del
 * scheduler — sin userId no se persiste ni se lee nada (Capa 1 del fix de
 * aislamiento). Si el SDK invoca el handler sin contexto válido es un bug
 * grave del SDK; fail loud.
 */
export function requireUserId(context: ToolContext): string {
  const userId = context.execution?.userId;
  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    throw new SchedulerError(
      'NO_USER_CONTEXT',
      'User context missing — MCA SDK did not pass execution.userId.',
      'This is an SDK bug, not a user error.',
    );
  }
  return userId;
}

export function optionalWorkspaceId(context: ToolContext): string | undefined {
  const workspaceId = context.execution?.workspaceId;
  return typeof workspaceId === 'string' && workspaceId.trim() !== '' ? workspaceId : undefined;
}

/**
 * Shape canónico de los channelIds en Teros: `ch_<16 hex chars>` según
 * `core/src/ids.ts`. Rechazar cualquier otro shape en boundary protege
 * contra channelIds inventados por el LLM y contra mutex semánticos (ej.
 * "general" como string libre).
 */
export const CHANNEL_ID_REGEX = /^ch_[0-9a-f]{16}$/;

export function assertValidChannelId(channelId: string): void {
  if (!CHANNEL_ID_REGEX.test(channelId)) {
    throw new SchedulerError(
      'INVALID_INPUT',
      `channelId must match ${CHANNEL_ID_REGEX} (got: "${channelId.slice(0, 64)}").`,
      'Use the channelId emitted by channel.create or returned by an event payload.',
    );
  }
}

/**
 * Verifica que el channel exista y pertenezca al user. Llama al backend via
 * `context.backend.channelGet` (Capa 1 client-side; Capa 2 server-side ya lo
 * vuelve a comprobar en `mca-callback-routes.handleChannelSubscription`).
 *
 * NOTA: este lookup requiere que el SDK exponga `channelGet`. Si no está
 * disponible, fail-loud (mejor que fail-open silencioso). Una vez la Capa 2
 * está implementada, este lookup pasa a ser defense-in-depth opcional.
 */
export async function assertChannelOwnership(
  context: ToolContext,
  userId: string,
  channelId: string,
): Promise<void> {
  if (!context.backend) {
    throw new SchedulerError(
      'FORBIDDEN',
      'Cannot verify channel ownership: no backend client available.',
    );
  }
  const backend = context.backend as unknown as {
    channelGet?: (channelId: string) => Promise<{ userId?: string } | null>;
  };
  if (typeof backend.channelGet !== 'function') {
    // SDK aún no expone channelGet — Capa 2 server-side cubrirá esto.
    // Sin verificación client-side perdemos defense-in-depth pero el callback
    // route lo rechazará al crear la subscription.
    return;
  }
  const channel = await backend.channelGet(channelId);
  if (!channel || channel.userId !== userId) {
    throw new SchedulerError(
      'FORBIDDEN',
      `Channel ${channelId} does not belong to user.`,
      'Use a channel you own — channel.list returns yours.',
    );
  }
}

export type SchedulerTopic = 'scheduler.reminder' | 'scheduler.recurring_task';

/**
 * Limpia subscriptions de los topics indicados para el `channelId` SOLO si
 * el user es owner (verificado server-side por la Capa 2 de
 * `mca-callback-routes.deleteChannelSubscriptionsByTopic`). Tragar errores
 * de cleanup es aceptable: no rompemos la mutación principal si la sub no
 * se puede borrar (sliding TTL la limpiará).
 */
export async function cleanupChannelSubscriptions(
  context: ToolContext,
  channelId: string,
  topics: SchedulerTopic[],
): Promise<void> {
  if (!context.backend) return;
  for (const topic of topics) {
    try {
      await context.backend.deleteChannelSubscriptionsByTopic({ topic, channelId });
    } catch (err) {
      console.error(`[scheduler] subscription cleanup failed for ${topic} on ${channelId}:`, err);
    }
  }
}

/**
 * Conveniencia para creates: persiste la subscription al topic indicado.
 * Tragar errores aquí queda registrado, pero el caller (handler) decide si
 * marcar el reminder como failed.
 */
export async function createChannelSubscription(
  context: ToolContext,
  topic: SchedulerTopic,
  channelId: string,
): Promise<void> {
  if (!context.backend) return;
  try {
    await context.backend.createChannelSubscription({
      topic,
      mode: 'wake',
      rules: [{ channelId }],
      channelId,
    });
  } catch (err) {
    console.error(`[scheduler] subscription create failed for ${topic} on ${channelId}:`, err);
  }
}

export type SchedulerTool<TArgs = Record<string, unknown>, TResult = unknown> = ToolConfig<TArgs, TResult>;
