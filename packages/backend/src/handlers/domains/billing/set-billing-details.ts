/**
 * billing.set-billing-details — the caller's tax location (+ optional tax id).
 *
 * Country drives Stripe Tax (automatic_tax is enabled on the invoice only when
 * the customer has a country) and the legal invoice header; the tax id (VAT /
 * CIF / …) is attached to the Stripe customer. Collected in the card form.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { StripePaymentService } from '../../../services/stripe-payment-service'
import { StripePaymentError } from '../../../services/_stripe-error'

interface SetBillingDetailsData {
  country?: string
  taxId?: string | null
  taxIdType?: string | null
}

const COUNTRY_RE = /^[A-Za-z]{2}$/
const TAX_ID_TYPE_RE = /^[a-z]{2}_[a-z_]{2,20}$/
const MAX_TAX_ID_LEN = 40

export function createSetBillingDetailsHandler(stripe: StripePaymentService) {
  return async function setBillingDetails(ctx: WsHandlerContext, rawData: unknown) {
    if (!stripe.isEnabled()) {
      throw new HandlerError('STRIPE_NOT_CONFIGURED', 'Card payments are not enabled on this server.')
    }
    const data = (rawData ?? {}) as SetBillingDetailsData
    if (typeof data.country !== 'string' || !COUNTRY_RE.test(data.country.trim())) {
      throw new HandlerError('MISSING_FIELDS', 'country (ISO-3166-1 alpha-2) is required')
    }
    const taxId = typeof data.taxId === 'string' && data.taxId.trim() ? data.taxId.trim() : null
    if (taxId && taxId.length > MAX_TAX_ID_LEN) {
      throw new HandlerError('INVALID_INPUT', `taxId must be at most ${MAX_TAX_ID_LEN} characters`)
    }
    const taxIdType = typeof data.taxIdType === 'string' && data.taxIdType.trim() ? data.taxIdType.trim() : null
    if (taxId && (!taxIdType || !TAX_ID_TYPE_RE.test(taxIdType))) {
      throw new HandlerError('INVALID_INPUT', 'taxIdType (e.g. eu_vat, es_cif) is required with taxId')
    }
    try {
      const customer = await stripe.setBillingDetails(ctx.userId, { country: data.country, taxId, taxIdType })
      return { ok: true, country: customer.country, taxId: customer.taxId, taxIdType: customer.taxIdType }
    } catch (err) {
      if (err instanceof StripePaymentError) {
        throw new HandlerError(err.issue.code, err.issue.message)
      }
      throw err
    }
  }
}
