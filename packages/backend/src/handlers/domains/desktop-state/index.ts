/**
 * desktop-state domain — registers desktop state persistence handlers
 *
 * Actions:
 *   desktop-state.get  → Get persisted desktop state for (userId, workspaceId)
 *   desktop-state.save → Save desktop state for (userId, workspaceId)
 */

import type { Db } from 'mongodb';
import type { WsRouter } from '../../../ws-framework/WsRouter';
import { DesktopStateService } from '../../../services/desktop-state-service';
import { createGetDesktopStateHandler } from './get';
import { createSaveDesktopStateHandler } from './save';

export interface DesktopStateDomainDeps {
  db: Db;
  desktopStateService?: DesktopStateService | null;
}

export function register(router: WsRouter, deps: DesktopStateDomainDeps): void {
  const service = deps.desktopStateService ?? new DesktopStateService(deps.db);
  router.register('desktop-state.get', createGetDesktopStateHandler(service));
  router.register('desktop-state.save', createSaveDesktopStateHandler(service));
}
