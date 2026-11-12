/**
 * StripeApi — narrow port over the Stripe SDK (FASE 4, Model B).
 *
 * The rest of the billing code depends on THIS interface, never on the `stripe`
 * package directly. Only `stripe-client.ts` imports the SDK and adapts it to
 * this port. Two payoffs:
 *   - tests inject a faithful in-memory fake (no network, no SDK shapes),
 *   - if Stripe is not configured, the port is simply absent and the payment
 *     paths stay disabled (manual billing) — no SDK loaded.
 *
 * Returns are minimal "ref" shapes carrying only the fields the billing code
 * reads. The adapter maps full Stripe responses down to these; the fake
 * produces them directly. Mutations take an idempotency key (Stripe dedups
 * retries); only that key (never auto-retry on the SDK) protects against
 * double-charges — same principle as the MCA HTTP retry policy (GET-only).
 */

/** Options accepted by every mutating call. */
export interface StripeRequestOptions {
  /** Stripe idempotency key — dedups a retried mutation server-side. */
  idempotencyKey?: string
}

export interface StripeCustomerRef {
  id: string
  /** Stripe returns `deleted: true` for a deleted customer on retrieve. */
  deleted?: boolean
}

export interface StripeSetupIntentRef {
  id: string
  /** Client secret the frontend uses to confirm the SetupIntent. */
  client_secret: string | null
}

export interface StripePaymentMethodRef {
  id: string
}

/** A SetupIntent read back after the frontend confirmed it (3DS return path). */
export interface StripeSetupIntentDetails {
  id: string
  /** requires_payment_method | requires_confirmation | requires_action | processing | canceled | succeeded */
  status: string
  /** Vaulted payment method id once the intent succeeded. */
  payment_method: string | null
  /** Customer the intent was minted for (cus_…). */
  customer: string | null
}

export interface CreateTaxIdParams {
  /** Stripe tax id type, e.g. 'eu_vat', 'es_cif', 'gb_vat', 'us_ein'. */
  type: string
  value: string
}

/**
 * Display details of a vaulted payment method, for the profile. Cards are the
 * norm; Link (Stripe's wallet, a card underneath, chargeable off-session) and
 * SEPA are mapped too so a vaulted method never reads as "no card on file"
 * (found 2026-10-15: a Link method was stored and the profile said no card).
 */
export interface StripeCardDetails {
  /** 'card' | 'link' | 'sepa_debit' — absent means 'card' (older callers). */
  type?: string
  /** Card network: 'visa' | 'mastercard' | 'amex' | … (Stripe's lowercase brand); 'link' / 'sepa' otherwise. */
  brand: string
  /** Last 4 digits, e.g. "4242" (empty for Link). */
  last4: string
  /** Expiry month 1-12 (0 when not a card). */
  expMonth: number
  /** Expiry year, 4 digits (0 when not a card). */
  expYear: number
  /** Link: the wallet's email. */
  email?: string | null
}

export interface StripeInvoiceRef {
  id: string
  /** Stripe's legal sequential number (e.g. "TEROS-0001"); null before finalize. */
  number: string | null
  /** draft | open | paid | uncollectible | void */
  status: string | null
  hosted_invoice_url: string | null
  invoice_pdf: string | null
  /** Amounts in the currency's smallest unit (cents). */
  amount_due: number
  amount_paid: number
  paid: boolean
  /**
   * Customer balance swept into this invoice on finalization (cents). MUST be 0
   * for a Teros invoice: Model B keeps Teros the source of truth and never uses
   * Stripe's customer balance, so any non-zero value is inherited/anomalous state
   * that would silently in/deflate the card charge (the €43→€145 incident). The
   * charge guard asserts this is 0 before paying.
   */
  starting_balance: number
  /** Line-item sum before tax/balance (cents) — must equal the quoted amount. */
  subtotal: number
  /** Final amount Stripe will collect on the card (cents): subtotal ± tax. */
  total: number
}

export interface StripeEventRef {
  id: string
  type: string
  data: { object: Record<string, unknown> }
}

export interface CreateCustomerParams {
  email?: string
  name?: string
  metadata?: Record<string, string>
}

export interface UpdateCustomerParams {
  invoice_settings?: { default_payment_method?: string }
  address?: { country?: string }
  metadata?: Record<string, string>
}

export interface CreateInvoiceItemParams {
  customer: string
  /**
   * Invoice to attach the item to. Effectively REQUIRED: the current Stripe API
   * no longer auto-pulls pending items into a new invoice, so an item without an
   * `invoice` is stranded and the invoice finalizes at €0. chargeInvoice always
   * sets it; optional only so older callers/tests keep typing.
   */
  invoice?: string
  /** Amount in the smallest currency unit (cents). */
  amount: number
  currency: string
  /**
   * How this amount relates to tax. Teros prices are tax-INCLUSIVE (decision:
   * the quoted price is exactly what the card pays; IVA is carved out inside it,
   * never added on top), so `amount_due === amount` regardless of the customer's
   * tax location. Set to 'inclusive' on every charged item.
   */
  tax_behavior?: 'inclusive' | 'exclusive'
  description?: string
  metadata?: Record<string, string>
}

export interface CreateInvoiceParams {
  customer: string
  collection_method?: 'charge_automatically' | 'send_invoice'
  auto_advance?: boolean
  default_payment_method?: string
  automatic_tax?: { enabled: boolean }
  description?: string
  metadata?: Record<string, string>
}

export interface CreateSetupIntentParams {
  customer: string
  usage?: 'off_session' | 'on_session'
  payment_method_types?: string[]
}

export interface ListInvoicesParams {
  customer?: string
  status?: string
  /** Unix-seconds range filter, Stripe `created` operator object. */
  created?: { gte?: number; lte?: number }
  limit?: number
}

export interface StripeApi {
  createCustomer(
    params: CreateCustomerParams,
    opts?: StripeRequestOptions,
  ): Promise<StripeCustomerRef>

  retrieveCustomer(id: string): Promise<StripeCustomerRef>

  updateCustomer(
    id: string,
    params: UpdateCustomerParams,
    opts?: StripeRequestOptions,
  ): Promise<StripeCustomerRef>

  createSetupIntent(
    params: CreateSetupIntentParams,
    opts?: StripeRequestOptions,
  ): Promise<StripeSetupIntentRef>

  /** Read a SetupIntent back (status + vaulted payment method), for the redirect return path. */
  retrieveSetupIntent(id: string): Promise<StripeSetupIntentDetails>

  /** Attach a tax id (VAT / CIF / …) to a customer; drives Stripe Tax and the invoice header. */
  createCustomerTaxId(
    customerId: string,
    params: CreateTaxIdParams,
    opts?: StripeRequestOptions,
  ): Promise<{ id: string }>

  attachPaymentMethod(
    paymentMethodId: string,
    customerId: string,
    opts?: StripeRequestOptions,
  ): Promise<StripePaymentMethodRef>

  /** Retrieve a payment method's card details for display. Null if not a card. */
  retrievePaymentMethod(
    paymentMethodId: string,
    opts?: StripeRequestOptions,
  ): Promise<StripeCardDetails | null>

  createInvoiceItem(
    params: CreateInvoiceItemParams,
    opts?: StripeRequestOptions,
  ): Promise<{ id: string }>

  createInvoice(
    params: CreateInvoiceParams,
    opts?: StripeRequestOptions,
  ): Promise<StripeInvoiceRef>

  finalizeInvoice(id: string, opts?: StripeRequestOptions): Promise<StripeInvoiceRef>

  payInvoice(
    id: string,
    params: { off_session?: boolean },
    opts?: StripeRequestOptions,
  ): Promise<StripeInvoiceRef>

  /**
   * Void a finalized-but-unpaid invoice so it can never be collected. Used by the
   * charge guard to fail loud when the amount Stripe would charge diverges from
   * the quoted amount (e.g. a swept customer balance) — voiding stops the card
   * charge from ever landing. Only valid on an `open` invoice; a `paid` one must
   * NOT be voided (Stripe throws).
   */
  voidInvoice(id: string, opts?: StripeRequestOptions): Promise<StripeInvoiceRef>

  retrieveInvoice(id: string): Promise<StripeInvoiceRef>

  listInvoices(params: ListInvoicesParams): Promise<{ data: StripeInvoiceRef[] }>

  /**
   * Verify + parse a webhook payload. Rejects on a bad signature. Async so it
   * works under every crypto provider (WebCrypto's is async-only).
   */
  constructWebhookEvent(payload: string | Buffer, signature: string): Promise<StripeEventRef>
}

// ============================================================================
// Money helpers — Teros stores prices in whole currency units (EUR), Stripe in
// the smallest unit (cents). Centralized so the conversion never drifts.
// ============================================================================

/** EUR (whole units) → Stripe amount (cents). Rounds to avoid float drift. */
export function toStripeAmount(majorUnits: number): number {
  return Math.round(majorUnits * 100)
}

/** Stripe amount (cents) → EUR (whole units). */
export function fromStripeAmount(minorUnits: number): number {
  return minorUnits / 100
}
