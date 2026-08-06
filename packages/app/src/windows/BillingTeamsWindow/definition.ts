import { Building2 } from '@tamagui/lucide-icons';
import i18n from '../../i18n';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { BillingTeamsWindowContent, type BillingTeamsWindowProps } from './BillingTeamsWindowContent';

// No persistable props — the window opens on the team list and drills into a
// team via internal state (same as billing-requests).
export const billingTeamsWindowDefinition: WindowTypeDefinition<BillingTeamsWindowProps> = {
  type: 'billing-teams',
  displayName: i18n.t('windows.billingTeams'),
  getTitle: () => i18n.t('windows.billingTeams'),
  component: BillingTeamsWindowContent,
  defaultProps: {},
  icon: Building2 as any,
  color: '#06B6D4',
  defaultSize: { width: 780, height: 640 },
  minSize: { width: 520, height: 400 },
} as any;
