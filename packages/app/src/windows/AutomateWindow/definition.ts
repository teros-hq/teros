/**
 * Automate Window Type Definition
 *
 * Automations: a trigger (schedule, webhook, event) coupled with an action
 * (create task, message a channel, start flow). Listed in the launcher's
 * "work" section and the navbar. Gated by `automate_v1`.
 */

import { Zap } from '@tamagui/lucide-icons'
import i18n from '../../i18n'
import { lazyWithRetry } from '../../lib/lazyWithRetry'
import type { WindowTypeDefinition } from '../../services/windowRegistry'

const AutomateWindowContent = lazyWithRetry(() =>
  import('./AutomateWindowContent').then((m) => ({ default: m.AutomateWindowContent })),
)

export type AutomateWindowProps = Record<string, never>

export const automateWindowDefinition: WindowTypeDefinition<AutomateWindowProps> = {
  type: 'automate',
  audience: 'user',
  displayName: 'Automate',
  icon: Zap,
  phIcon: 'lightning',
  color: '#F59E0B',
  component: AutomateWindowContent,

  defaultSize: { width: 900, height: 640 },
  minSize: { width: 480, height: 320 },

  isLauncher: true,
  allowMultiple: false,

  // Gated by automate_v1 — the window is hidden while the flag is off.
  featureFlag: 'automate_v1',

  getTitle: () => i18n.t('automate.title', 'Automate'),
  getSubtitle: () =>
    i18n.t('automate.launcherSub', 'Schedules, webhooks and events that create work'),

  serialize: () => ({}),
  deserialize: () => ({}),
}
