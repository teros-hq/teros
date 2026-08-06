import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getPlaudClient, mapSegments, mapNoteDetail } from '../lib'

export const getTranscript: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get raw transcript segments for a PLAUD recording. Returns each segment with text and optional timing. Use this instead of get-note when you only need the transcript and want to save token budget.',
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
    const raw = await client.getTranscript(id) as Record<string, unknown>

    // Unwrap if the API wraps the detail in a data envelope
    const detail = (raw.data ?? raw) as Record<string, unknown>
    // The get_transcript MCP tool may return either a full note-like object or
    // a slim object with just segments. We map defensively for both shapes.
    // Plaud's official detail shape stores transcript segments in `source_list`.
    const segments = mapSegments(detail.source_list ?? detail.segments ?? detail.transcript_segments ?? detail.content_list ?? [])
    const metadata = mapNoteDetail(detail)

    return {
      id: metadata.id || id,
      title: metadata.title,
      duration_seconds: metadata.duration_seconds,
      segments,
    }
  },
}
