/**
 * app.form-response — User response to an inline form (request-user-input tool)
 *
 *
 * Payload: { formRequestId, values?, notes?, dismissed? }. Values are validated
 * server-side against the persisted form spec; on validation failure the form
 * stays pending and the errors are returned so the client can surface them.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'

interface FormResponseData {
  formRequestId: string
  values?: unknown
  notes?: string
  dismissed?: boolean
}

export type HandleFormResponse = (
  formRequestId: string,
  payload: { values?: unknown; notes?: string; dismissed?: boolean },
) => Promise<{ channelId: string; idempotent?: boolean; errors?: string[] } | null>

export function createFormResponseHandler(handleFormResponse: HandleFormResponse) {
  return async function formResponse(_ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as FormResponseData
    const { formRequestId, values, notes, dismissed } = data

    if (!formRequestId) {
      throw new HandlerError('MISSING_REQUEST_ID', 'formRequestId is required')
    }

    console.log(`[app.form-response] ${formRequestId} = ${dismissed ? 'dismissed' : 'submitted'}`)

    const result = await handleFormResponse(formRequestId, { values, notes, dismissed })

    if (!result) {
      throw new HandlerError('UNKNOWN_FORM_REQUEST', `No pending form: ${formRequestId}`)
    }
    if (result.errors?.length) {
      // Validation failure — the form stays pending; the client renders the
      // errors inline and the user can correct and resubmit.
      return { formRequestId, accepted: false, errors: result.errors }
    }
    return { formRequestId, accepted: true, idempotent: result.idempotent ?? false }
  }
}
