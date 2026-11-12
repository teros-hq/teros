import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { ToolConfig } from '@teros/mca-sdk'
import {
  assertSize,
  createGraphClient,
  encodePathSegments,
  formatItem,
  normalizePath,
} from '../lib'
import type { GraphSecrets } from '../lib'

const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024
const CHUNK_SIZE = 5 * 320 * 1024

export const uploadFile: ToolConfig = {
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  description:
    'Upload a local file to OneDrive. Files below 4 MB upload directly; larger files use a chunked upload session — a failed chunk aborts the whole upload rather than resuming. Overwrites an existing file with the same name.',
  parameters: {
    type: 'object',
    properties: {
      localPath: { type: 'string', description: 'Absolute path of the local file to upload' },
      destinationPath: {
        type: 'string',
        description:
          'Destination folder path relative to the drive root, e.g. "Documents". Pass literal folder names, not pre-encoded ones. Defaults to the root.',
      },
      fileName: {
        type: 'string',
        description:
          'Name to store the file under, as a literal name rather than a pre-encoded one. Defaults to the local file name.',
      },
    },
    required: ['localPath'],
  },
  handler: async (args, context) => {
    const a = (args ?? {}) as Record<string, unknown>
    const localPath = a.localPath as string

    if (!existsSync(localPath)) {
      throw new Error(`Local file not found: ${localPath}`)
    }

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

    const content = readFileSync(localPath)
    const size = content.length
    assertSize(size, `"${localPath}"`)

    const fileName = encodeURIComponent((a.fileName as string) || basename(localPath))
    const folder = encodePathSegments(normalizePath((a.destinationPath as string) || ''))
    const target = `/me/drive/root:${folder}/${fileName}:`

    if (size < SIMPLE_UPLOAD_LIMIT) {
      const item = await graphRequest<Record<string, any>>(
        'PUT',
        `${target}/content?@microsoft.graph.conflictBehavior=replace`,
        undefined,
        {
          headers: { 'Content-Type': 'application/octet-stream' },
          rawBody: content,
        },
      )
      return { success: true, account: email, item: formatItem(item) }
    }

    const session = await graphRequest<Record<string, any>>(
      'POST',
      `${target}/createUploadSession`,
      { item: { '@microsoft.graph.conflictBehavior': 'replace' } },
    )

    let uploaded: any = null

    for (let start = 0; start < size; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE, size) - 1
      const chunk = content.subarray(start, end + 1)

      const response = await fetch(session.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Range': `bytes ${start}-${end}/${size}`,
        },
        body: chunk,
      })

      if (!response.ok) {
        throw new Error(
          `Upload session failed at bytes ${start}-${end} (${response.status}). The session was not committed.`,
        )
      }

      if (response.status === 200 || response.status === 201) {
        uploaded = await response.json()
      }
    }

    if (!uploaded) {
      throw new Error('Upload session completed without returning the created item.')
    }

    return { success: true, account: email, item: formatItem(uploaded) }
  },
}
