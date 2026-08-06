import { ScrollText } from '@tamagui/lucide-icons';
import i18n from '../../i18n';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { BillingAuditWindowContent, type BillingAuditWindowProps } from './BillingAuditWindowContent';

export const billingAuditWindowDefinition: WindowTypeDefinition<BillingAuditWindowProps> = {
  type: 'billing-audit',
  displayName: i18n.t('windows.billingAudit'),
  getTitle: () => i18n.t('windows.billingAudit'),
  component: BillingAuditWindowContent,
  defaultProps: {},
  icon: ScrollText as any,
  color: '#06B6D4',
  defaultSize: { width: 720, height: 600 },
  minSize: { width: 480, height: 360 },
  // Persists which user is being audited so the tab restores after reload.
  serialize: (props: BillingAuditWindowProps) => ({
    userId: props.userId,
    subscriptionId: props.subscriptionId,
    userName: props.userName,
  }),
  deserialize: (data: Record<string, any>) => ({
    userId: data.userId,
    subscriptionId: data.subscriptionId,
    userName: data.userName,
  }),
} as any;
