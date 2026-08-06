import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getPlaudClient } from '../lib'

export const downloadRecording: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Download a PLAUD recording audio file. Returns a public or presigned URL to the recording audio.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The recording file ID (32-char hex string)',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const id = args.id as string

    const client = await getPlaudClient(context)
    // The official Plaud MCP get_file tool returns a presigned_url field that is
    // valid for 24 hours. We return it directly as the audio download URL.
    const result = await client.getFileDetail(id) as Record<string, unknown>

    return {
      id,
      audio_url: (result.presigned_url ?? result.audio_url ?? result.audioUrl ?? result.url ?? result.download_url ?? undefined) as string | undefined,
      title: (result.name ?? result.title ?? result.file_name ?? '') as string,
    }
  },
}
