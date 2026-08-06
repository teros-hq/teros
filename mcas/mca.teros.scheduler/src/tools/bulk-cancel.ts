import { z } from 'zod';
import { db, resolveDefaultTimezone } from '../lib';
import {
  cleanupChannelSubscriptions,
  requireUserId,
  structured,
  type SchedulerTool,
  toToolError,
  validateInput,
} from './_shared';

// `before` can arrive as: epoch ms (number), epoch ms as string ("1778..."), or
// ISO 8601 string. Zod union tries members in order — put the most permissive
// last and use a custom check first to avoid `z.string().datetime()` rejecting
// numeric strings before the number variant gets a chance.
const BeforeSchema = z.union([
  z.number().int().positive(),
  z
    .string()
    .min(1)
    .refine(
      (s) => /^\d+$/.test(s) || !Number.isNaN(new Date(s).getTime()),
      'Must be epoch ms (number or numeric string) or ISO 8601 datetime.',
    )
    .transform((s) => (/^\d+$/.test(s) ? Number(s) : new Date(s).getTime())),
]);

const Schema = z
  .object({
    channelId: z.string().optional(),
    before: BeforeSchema.optional(),
    ids: z.array(z.number().int().positive()).max(500).optional(),
    timezone: z.string().optional(),
  })
  .refine(
    (v) => v.channelId !== undefined || v.before !== undefined || (v.ids && v.ids.length > 0),
    { message: 'Provide at least one filter: channelId, before, or ids[].' },
  );

export const bulkCancel: SchedulerTool = {
  description:
    'Bulk-cancel pending reminders of the current user. Filter by channelId, before (ISO or epoch ms), or ids[]. Returns cancelled IDs and cleans subs for channels with no remaining pending.',
  parameters: {
    type: 'object',
    properties: {
      channelId: { type: 'string', description: 'Cancel all pending in this channel.' },
      before: { description: 'Cancel pending scheduled before this time (ISO 8601 or epoch ms).' },
      ids: { type: 'array', items: { type: 'number' }, description: 'Cancel by IDs (max 500).' },
      timezone: { type: 'string', description: 'IANA timezone for humanReadable.' },
    },
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable', destructiveHint: true },
  handler: async (args, context) => {
    try {
      const userId = requireUserId(context);
      const input = validateInput(Schema, args ?? {});

      // Resolver los reminders impactados ANTES del bulk para conocer los
      // channels afectados (necesario para cleanup de subscriptions huérfanas).
      // El método `bulkCancelReminders` ya filtra por user_id internamente.
      const cancelledIds = await db.bulkCancelReminders({
        userId,
        channelId: input.channelId,
        before: input.before,
        ids: input.ids,
      });

      // Cleanup por channel: para cada channel que quedó sin reminders pending
      // del user, borrar la subscription scheduler.reminder. NOTA: lookup
      // post-cancel asegura que solo limpiamos channels que ya no tienen pending.
      if (cancelledIds.length > 0) {
        const channels = new Set<string>();
        if (input.channelId) {
          channels.add(input.channelId);
        } else {
          // Si el bulk no era channel-scoped, hay que enumerar los channels
          // distintos de los IDs cancelados. Como ya los marcamos cancelled,
          // re-query con $in para extraer channels.
          // (Coste aceptable: bulk-cancel está capped por MAX_BULK_CANCEL.)
          const docs = await db.reminders
            .find({ id: { $in: cancelledIds }, user_id: userId }, { projection: { channel_id: 1, _id: 0 } })
            .toArray();
          for (const d of docs) channels.add(d.channel_id);
        }
        for (const channelId of channels) {
          const stillUsed = (
            await db.listReminders({ userId, channelId, status: 'pending', limit: 1 })
          ).items.length > 0;
          if (!stillUsed) {
            await cleanupChannelSubscriptions(context, channelId, ['scheduler.reminder']);
          }
        }
      }

      return structured({
        action: 'bulk-cancelled' as const,
        cancelledCount: cancelledIds.length,
        cancelledIds,
        timezone: input.timezone ?? resolveDefaultTimezone(),
      });
    } catch (error) {
      toToolError(error);
    }
  },
};
