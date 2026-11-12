/**
 * Handler-side guards for the MUW v2.2 app model (MUW-REQ-13):
 *   - a private app of another member does not exist for the caller
 *     (reads → ACCESS_DENIED);
 *   - mutations need the owner or a workspace owner/admin.
 *
 * @spec MUW-REQ-13
 */
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { App } from '../../../types/database'
import type { McaService } from '../../../services/mca-service'

/** @spec MUW-REQ-13 */
export function assertAppVisible(mcaService: McaService, app: Pick<App, 'appId' | 'scope' | 'installedBy'>, userId: string): void {
  if (!mcaService.isAppVisibleTo(app, userId)) {
    throw new HandlerError('ACCESS_DENIED', `You don't have access to app ${app.appId}`)
  }
}

/** @spec MUW-REQ-13 */
export async function assertAppManageable(
  mcaService: McaService,
  app: Pick<App, 'appId' | 'ownerId' | 'scope' | 'installedBy'>,
  userId: string,
): Promise<void> {
  assertAppVisible(mcaService, app, userId)
  if (!(await mcaService.canManageApp(app, userId))) {
    throw new HandlerError('ACCESS_DENIED', `Only the owner of app ${app.appId} or a workspace admin can change it`)
  }
}
