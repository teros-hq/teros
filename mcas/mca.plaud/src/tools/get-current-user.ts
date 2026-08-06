import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getPlaudClient, mapUser } from '../lib'

export const getCurrentUser: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get the current PLAUD user profile (id, email, name). Useful for health checks and confirming OAuth connectivity.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async (_args, context) => {
    const client = await getPlaudClient(context)
    const raw = await client.getCurrentUser() as Record<string, unknown>
    const user = mapUser(raw)
    return { user }
  },
}
