import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getPlaudClient, mapNoteDetail } from '../lib'

const TRANSCRIPT_WARN_THRESHOLD = 100_000

export const getNote: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get full details for a PLAUD recording: transcript (concatenated), AI summary, and metadata.',
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
    const raw = await client.getFileDetail(id) as Record<string, unknown>

    // Unwrap if the API wraps the detail in a data envelope
    const detail = (raw.data ?? raw) as Record<string, unknown>
    // get_file returns the same shape as get_transcript; note_list is the AI summary.
    const note = mapNoteDetail(detail)

    const result: Record<string, unknown> = { ...note }

    if (note.transcript.length > TRANSCRIPT_WARN_THRESHOLD) {
      result._warning = `Transcript is very long (${note.transcript.length} characters). Consider using get-transcript for segment-level access.`
    }

    return result
  },
}
