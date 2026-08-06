import i18n from '../../i18n';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { BillingRequestsWindowContent } from './BillingRequestsWindowContent';

export interface BillingRequestsWindowProps {
  // No props needed.
}

export const billingRequestsWindowDefinition: WindowTypeDefinition<BillingRequestsWindowProps> = {
  type: 'billing-requests',
  displayName: i18n.t('windows.billingRequests'),
  getTitle: () => i18n.t('windows.billingRequests'),
  component: BillingRequestsWindowContent,
  defaultProps: {},
  icon: '💳' as any,
  color: '#5E6AD2',
  defaultSize: { width: 640, height: 560 },
} as any;
