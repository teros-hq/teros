import { HandlerError } from '../../../ws-framework/WsRouter';
import type { WsHandlerContext } from '@teros/shared';
import type { DesktopStateService } from '../../../services/desktop-state-service';

interface SaveDesktopStateData {
  workspaceId: string;
  state: Record<string, string>;
}

export function createSaveDesktopStateHandler(service: DesktopStateService) {
  return async function saveDesktopState(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as SaveDesktopStateData;
    const { workspaceId, state } = data;

    if (!workspaceId) {
      throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId is required');
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new HandlerError('INVALID_STATE', 'state must be a plain object');
    }

    await service.save(ctx.userId, workspaceId, state);
    return { ok: true };
  };
}
