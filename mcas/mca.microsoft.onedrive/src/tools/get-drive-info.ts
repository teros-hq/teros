import type { ToolConfig } from '@teros/mca-sdk'
import { createGraphClient } from '../lib'
import type { GraphSecrets } from '../lib'

const BYTES_PER_GB = 1024 ** 3

function toGB(bytes?: number): string | undefined {
  if (typeof bytes !== 'number') return undefined
  return (bytes / BYTES_PER_GB).toFixed(2)
}

export const getDriveInfo: ToolConfig = {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: 'Get information about the OneDrive account, including storage quota and usage.',
  parameters: { type: 'object', properties: {} },
  handler: async (_args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as GraphSecrets
    const { graphRequest, email } = await createGraphClient(
      secrets,
      context.updateUserSecrets?.bind(context),
      'OneDrive',
      'Files.ReadWrite.All',
    )

    const drive = await graphRequest<Record<string, any>>('GET', '/me/drive')

    return {
      account: email,
      id: drive.id,
      driveType: drive.driveType,
      owner: drive.owner?.user?.displayName,
      quota: {
        totalGB: toGB(drive.quota?.total),
        usedGB: toGB(drive.quota?.used),
        remainingGB: toGB(drive.quota?.remaining),
        state: drive.quota?.state,
      },
    }
  },
}
