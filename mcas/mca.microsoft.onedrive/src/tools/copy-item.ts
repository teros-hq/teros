import type { ToolConfig } from '@teros/mca-sdk'
import {
  buildGraphError,
  createGraphClient,
  destinationRef,
  formatItem,
  requireItemRef,
} from '../lib'
import type { GraphSecrets } from '../lib'

const DEFAULT_POLL_INTERVAL_MS = 1000
const MAX_POLL_ATTEMPTS = 30
const MAX_POLL_INTERVAL_MS = 10_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clampPollIntervalMs(ms: number): number {
  return Math.min(Math.max(ms, 0), MAX_POLL_INTERVAL_MS)
}

export const copyItem: ToolConfig = {
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  description:
    'Copy a OneDrive file or folder to another folder. Waits for the copy to finish before returning. Specify the item with itemId or path, and the destination with destinationFolderId or destinationPath; with neither destination, the copy is placed at the drive root.',
  parameters: {
    type: 'object',
    properties: {
      itemId: { type: 'string', description: 'Item ID to copy. Takes precedence over path.' },
      path: {
        type: 'string',
        description:
          'Path of the item to copy, relative to the drive root. Pass literal file and folder names, not pre-encoded ones.',
      },
      destinationFolderId: {
        type: 'string',
        description: 'Destination folder ID. Takes precedence over destinationPath.',
      },
      destinationPath: {
        type: 'string',
        description:
          'Destination folder path relative to the drive root. Pass literal folder names, not pre-encoded ones. Omitting both destination arguments copies to the drive root.',
      },
      newName: { type: 'string', description: 'Optional new name for the copy' },
      pollIntervalMs: {
        type: 'number',
        description: 'Milliseconds between progress checks (default: 1000)',
      },
    },
  },
  handler: async (args, context) => {
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

    const a = (args ?? {}) as Record<string, unknown>
    const base = requireItemRef(a)
    const newName = a.newName as string | undefined
    const pollIntervalMs = clampPollIntervalMs(
      typeof a.pollIntervalMs === 'number' ? a.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS,
    )

    const body: Record<string, unknown> = { parentReference: destinationRef(a) }
    if (newName) body.name = newName

    const response: Response = await graphRequest<Response>('POST', `${base}/copy`, body, {
      responseType: 'raw',
    })

    if (!response.ok) {
      throw await buildGraphError(response)
    }

    const monitorUrl = response.headers.get('location')
    if (!monitorUrl) {
      throw new Error('Graph accepted the copy but returned no monitor URL.')
    }

    const skipAuth = new URL(monitorUrl).hostname !== 'graph.microsoft.com'

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(pollIntervalMs)

      const progress = await graphRequest<Record<string, any>>('GET', monitorUrl, undefined, {
        skipAuth,
      })

      if (progress?.status === 'completed') {
        const item = await graphRequest<Record<string, any>>(
          'GET',
          `/me/drive/items/${encodeURIComponent(progress.resourceId)}`,
        )
        return { success: true, account: email, status: 'completed', item: formatItem(item) }
      }

      if (progress?.status === 'failed') {
        throw new Error(`Copy failed: ${progress.error?.message ?? 'unknown reason'}`)
      }
    }

    throw new Error(
      `Copy did not finish within ${MAX_POLL_ATTEMPTS} checks. It may still complete in OneDrive.`,
    )
  },
}
