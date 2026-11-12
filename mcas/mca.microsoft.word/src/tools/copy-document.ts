import type { ToolConfig } from '@teros/mca-sdk'
import type { GraphSecrets } from '../lib'
import {
  buildGraphError,
  createGraphClient,
  encodePathSegments,
  formatItem,
  itemAction,
  itemRef,
  normalizePath,
} from '../lib'

const DEFAULT_POLL_INTERVAL_MS = 1000
const MAX_POLL_ATTEMPTS = 30
const MAX_POLL_INTERVAL_MS = 10_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clampPollIntervalMs(ms: number): number {
  return Math.min(Math.max(ms, 0), MAX_POLL_INTERVAL_MS)
}

/** copy-document — copies a .docx to a new folder, optionally renaming it. */
export const copyDocument: ToolConfig = {
  description:
    'Copy a Word document to another folder in OneDrive. Waits for the copy to finish before returning. The original is left untouched.',
  parameters: {
    type: 'object',
    properties: {
      itemId: {
        type: 'string',
        description: 'OneDrive item id of the .docx to copy. Takes precedence over path.',
      },
      path: {
        type: 'string',
        description:
          'Path to the .docx relative to the drive root. Pass literal names, not pre-encoded ones.',
      },
      destinationPath: {
        type: 'string',
        description:
          'Destination folder path relative to the drive root. Pass literal names, not pre-encoded ones.',
      },
      newName: {
        type: 'string',
        description:
          'Optional new file name for the copy. If omitted, the copy keeps the original name.',
      },
    },
    required: ['destinationPath'],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const secrets = { ...(await context.getSystemSecrets()), ...(await context.getUserSecrets()) } as GraphSecrets
    const { graphRequest, email } = await createGraphClient(
      secrets,
      context.updateUserSecrets?.bind(context),
      'Word',
      'Files.ReadWrite.All',
    )

    const a = (args ?? {}) as Record<string, unknown>
    const ref = itemRef(a)

    const destinationPath = typeof a.destinationPath === 'string' ? a.destinationPath.trim() : ''
    if (!destinationPath) {
      throw new Error('Specify destinationPath — the folder to copy the document into.')
    }
    const newName = typeof a.newName === 'string' ? a.newName.trim() : ''
    const pollIntervalMs = clampPollIntervalMs(
      typeof a.pollIntervalMs === 'number' ? a.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS,
    )

    // Build the parentReference path Graph expects: /drive/root:/folder/subfolder
    const encoded = encodePathSegments(normalizePath(destinationPath))
    const body: Record<string, unknown> = {
      parentReference: { path: `/drive/root:/${encoded}` },
    }
    if (newName) body.name = newName

    // Graph returns 202 Accepted with a Location header pointing to a monitor URL.
    const response: Response = await graphRequest<Response>(
      'POST',
      itemAction(ref, '/copy'),
      body,
      { responseType: 'raw' },
    )

    if (!response.ok) {
      throw await buildGraphError(response)
    }

    const monitorUrl = response.headers.get('location')
    if (!monitorUrl) {
      throw new Error('Graph accepted the copy but returned no monitor URL.')
    }

    // The monitor URL may be on a different host (e.g. a CDN) — skip auth if so.
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
        return {
          success: true,
          account: email,
          status: 'completed',
          item: formatItem(item),
        }
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
