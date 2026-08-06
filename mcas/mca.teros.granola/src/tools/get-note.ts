import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk'
import { getGranolaClient } from '../lib'

/**
 * Get full details of a Granola meeting note by ID.
 *
 * The API only returns notes that have an AI summary and transcript generated.
 * Set includeTranscript=true to include the full transcript segments.
 */
export const getNote: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get full details of a Granola meeting note by ID, including summary, attendees, calendar event, and optionally the transcript. The API only returns notes that have an AI summary and transcript generated.',
  parameters: {
    type: 'object',
    properties: {
      noteId: {
        type: 'string',
        description: 'Note ID (format: not_XXXXXXXXXXXXXX)',
      },
      includeTranscript: {
        type: 'boolean',
        description: 'Whether to include the full transcript segments',
        default: false,
      },
    },
    required: ['noteId'],
  },
  handler: async (args, context) => {
    const noteId = args.noteId as string
    const includeTranscript = (args.includeTranscript as boolean) ?? false

    const client = await getGranolaClient(context)
    const note = await client.getNote(noteId, includeTranscript)

    return note
  },
}
