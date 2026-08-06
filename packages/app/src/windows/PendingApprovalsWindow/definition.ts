import i18n from '../../i18n';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { PendingApprovalsWindowContent } from './PendingApprovalsWindowContent';

export interface PendingApprovalsWindowProps {
  // No props needed for now
}

export const pendingApprovalsWindowDefinition: WindowTypeDefinition<PendingApprovalsWindowProps> =
  {
    type: 'pending-approvals',
    displayName: i18n.t('windows.pendingApprovals'),
    getTitle: () => i18n.t('windows.pendingApprovals'),
    component: PendingApprovalsWindowContent,
    defaultProps: {},
    icon: '🔔' as any,
    color: '#F59E0B',
    defaultSize: { width: 600, height: 500 },
  } as any;
