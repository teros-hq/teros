import type { WindowTypeDefinition } from '../../store/tilingStore';
import { PendingApprovalsWindowContent } from './PendingApprovalsWindowContent';

export interface PendingApprovalsWindowProps {
  // No props needed for now
}

export const pendingApprovalsWindowDefinition: WindowTypeDefinition<PendingApprovalsWindowProps> =
  {
    type: 'pending-approvals',
    title: 'Permisos pendientes',
    component: PendingApprovalsWindowContent,
    defaultProps: {},
    icon: '🔔',
  };
