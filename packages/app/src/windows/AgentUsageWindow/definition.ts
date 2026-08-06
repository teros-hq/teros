/**
 * Agent Usage Window Definition
 *
 * Admin window for the agent usage instrumentation subsystem
 * (sessions + tool executions + hourly rollups). Coexists with
 * `UsageWindow`, which reads from `llm_usage` and is cost-centric. This
 * window is activity-centric.
 *
 * Backend actions consumed:
 *   - admin-api.agent-usage-tokens-per-hour
 *   - admin-api.agent-usage-list-sessions
 *   - admin-api.agent-usage-tool-executions-list
 *   - admin-api.agent-usage-health
 *
 * Auth: requireSystemAdmin enforced server-side (users.role ∈ admin|super).
 */

import { Activity } from '@tamagui/lucide-icons'
import type { WindowTypeDefinition } from '../../services/windowRegistry'
import { AgentActivityContent, type AgentActivityProps } from './AgentActivityContent'

// Accepts the optional drill/deep-link props (period + fixed bucket range).
export type AgentUsageWindowProps = AgentActivityProps

export const agentUsageWindowDefinition: WindowTypeDefinition<AgentUsageWindowProps> = {
  type: 'agent-usage',
  displayName: 'Agent Activity',
  icon: Activity,
  color: '#3B82F6',
  component: AgentActivityContent,

  defaultSize: { width: 1100, height: 760 },
  minSize: { width: 700, height: 480 },

  getTitle: () => 'Agent Activity',
  getSubtitle: () => 'Sessions, tools & hourly activity',

  serialize: () => ({}),
  deserialize: () => ({}),
}
