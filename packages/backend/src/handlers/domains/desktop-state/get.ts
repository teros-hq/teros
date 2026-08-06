import { HandlerError } from '../../../ws-framework/WsRouter';
import type { WsHandlerContext } from '@teros/shared';
import type { DesktopStateService } from '../../../services/desktop-state-service';

interface GetDesktopStateData {
  workspaceId: string;
}

export function createGetDesktopStateHandler(service: DesktopStateService) {
  return async function getDesktopState(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetDesktopStateData;
    const { workspaceId } = data;

    if (!workspaceId) {
      throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId is required');
    }

    const doc = await service.get(ctx.userId, workspaceId);
    return { state: doc?.state ?? null };
  };
}
