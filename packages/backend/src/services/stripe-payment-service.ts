/**
 * StripePaymentService (FASE 4, Model B).
 *
 * Business logic on top of the {@link StripeApi} port + the billing_customers
 * collection. Teros stays the source of truth for subscriptions and periods;
 * this service maps Teros users to Stripe customers, vaults payment methods, and
 * (FASE 4c) charges the invoices the reset-cron generates.
 *
 * Disabled gracefully when Stripe is not configured: `isEnabled()` is false and
 * every payment method throws STRIPE_NOT_CONFIGURED (fail loud) rather than
 * silently no-op'ing — manual/transfer billing keeps working without Stripe.
 */

import type { Db } from 'mongodb'
import {
  getBillingCustomersCollection,
  type BillingCustomer,
  type BillingInvoice,
} from '../models/billing.js'
import {
  AMOUNT_MISMATCH,
  classifyStripeError,
  NO_PAYMENT_METHOD,
  StripePaymentError,
  type StripeIssue,
} from './_stripe-error.js'
import {
  fromStripeAmount,
  toStripeAmount,
  type StripeApi,
  type StripeCardDetails,
  type StripeEventRef,
  type StripeInvoiceRef,
} from './stripe-api.js'

/** Outcome of a chargeInvoice attempt. */
export interface ChargeResult {
  status: 'paid' | 'failed'
  /** Stripe invoice id (in_…); set once the Stripe invoice exists. */
  stripeInvoiceId?: string
  /** Stripe legal number; set once finalized. */
  invoiceNumber?: string | null
  hostedInvoiceUrl?: string | null
  invoicePdfUrl?: string | null
  /**
   * What Stripe actually collected on the card (whole currency units), read back
   * from the paid invoice. Persisted as billing_invoices.amountCharged so we never
   * again show a quote (`amount`) that diverges from the charge (the €43→€145
   * incident). Set only when status === 'paid'.
   */
  amountPaid?: number
  /** Present when status === 'failed': the classified failure. */
  issue?: StripeIssue
}

/** Fields chargeInvoice needs from a BillingInvoice. */
export type ChargeableInvoice = Pick<
  BillingInvoice,
  '_id' | 'userId' | 'amount' | 'currency' | 'externalReference'
> & { description?: string }

export class StripePaymentService {
  constructor(
    private readonly db: Db,
    private readonly stripe: StripeApi | null,
    private readonly publishableKey: string | null = null,
  ) {}

  isEnabled(): boolean {
    return this.stripe !== null
  }

  /** Publishable key for the frontend Stripe.js / Elements (null if disabled). */
  getPublishableKey(): string | null {
    return this.publishableKey
  }

  private requireStripe(): StripeApi {
    if (!this.stripe) {
      throw new StripePaymentError({
        code: 'STRIPE_NOT_CONFIGURED',
        category: 'config',
        retryable: false,
        message: 'Stripe is not configured on this server.',
      })
    }
    return this.stripe
  }

  /** Run a Stripe call, normalizing any failure to a classified StripePaymentError. */
  private async call<T>(fn: (s: StripeApi) => Promise<T>): Promise<T> {
    const s = this.requireStripe()
    try {
      return await fn(s)
    } catch (err) {
      throw new StripePaymentError(classifyStripeError(err))
    }
  }

  getCustomer(userId: string): Promise<BillingCustomer | null> {
    return getBillingCustomersCollection(this.db).findOne({ _id: userId })
  }

  /** Verify + parse a Stripe webhook payload. Rejects on a bad signature. */
  verifyWebhookEvent(payload: string | Buffer, signature: string): Promise<StripeEventRef> {
    return this.requireStripe().constructWebhookEvent(payload, signature)
  }

  /** Retrieve a Stripe invoice by id (for Mongo↔Stripe reconciliation). */
  getStripeInvoice(stripeInvoiceId: string): Promise<StripeInvoiceRef> {
    return this.call((s) => s.retrieveInvoice(stripeInvoiceId))
  }

  /**
   * Idempotently ensure the user has a Stripe customer + a billing_customers
   * mapping. Returns the existing mapping unchanged when one already exists.
   *
   * Race-safe: the Stripe customer is created with idempotencyKey
   * `customer:${userId}`, so two concurrent first-time calls resolve to the
   * SAME Stripe customer; the upsert's $setOnInsert then commits exactly one
   * mapping (the unique stripeCustomerId index can never see a conflict).
   */
  async createOrSyncCustomer(
    userId: string,
    profile: { email?: string; name?: string } = {},
  ): Promise<BillingCustomer> {
    const col = getBillingCustomersCollection(this.db)
    const existing = await col.findOne({ _id: userId })
    if (existing?.stripeCustomerId) return existing

    const customer = await this.call((s) =>
      s.createCustomer(
        {
          email: profile.email,
          name: profile.name,
          metadata: { terosUserId: userId },
        },
        { idempotencyKey: `customer:${userId}` },
      ),
    )

    const now = new Date()
    await col.updateOne(
      { _id: userId },
      {
        $setOnInsert: {
          _id: userId,
          userId,
          stripeCustomerId: customer.id,
          defaultPaymentMethodId: null,
          country: null,
          taxId: null,
          taxIdType: null,
          createdAt: now,
        },
        $set: { updatedAt: now },
      },
      { upsert: true },
    )

    const saved = await col.findOne({ _id: userId })
    if (!saved) {
      // Should be impossible right after an upsert — fail loud if it happens.
      throw new StripePaymentError({
        code: 'CUSTOMER_PERSIST_FAILED',
        category: 'request',
        retryable: false,
        message: `billing_customers mapping missing after upsert for ${userId}`,
      })
    }
    return saved
  }

  /**
   * Create a SetupIntent for vaulting a payment method for future off-session
   * charges. Returns the client secret the frontend confirms with Stripe.js.
   */
  async createSetupIntent(
    userId: string,
    profile: { email?: string; name?: string } = {},
  ): Promise<{ setupIntentId: string; clientSecret: string | null; stripeCustomerId: string }> {
    const customer = await this.createOrSyncCustomer(userId, profile)
    const si = await this.call((s) =>
      s.createSetupIntent({
        customer: customer.stripeCustomerId,
        usage: 'off_session',
      }),
    )
    return {
      setupIntentId: si.id,
      clientSecret: si.client_secret,
      stripeCustomerId: customer.stripeCustomerId,
    }
  }

  /**
   * Attach a vaulted payment method to the user's customer and make it the
   * default for invoice charges. Persists the id so the charge-cron can bill
   * off-session.
   */
  async setDefaultPaymentMethod(userId: string, paymentMethodId: string): Promise<BillingCustomer> {
    const col = getBillingCustomersCollection(this.db)
    const customer = await this.createOrSyncCustomer(userId)

    await this.call((s) => s.attachPaymentMethod(paymentMethodId, customer.stripeCustomerId))
    await this.call((s) =>
      s.updateCustomer(customer.stripeCustomerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      }),
    )

    const now = new Date()
    await col.updateOne(
      { _id: userId },
      { $set: { defaultPaymentMethodId: paymentMethodId, updatedAt: now } },
    )
    const updated = await col.findOne({ _id: userId })
    return updated as BillingCustomer
  }

  /**
   * Card details of the user's default payment method, for display in the
   * profile ("Visa ···· 4242 · exp 04/27"). Returns null when there is no
   * vaulted method, Stripe is disabled, or the retrieve fails — the UI then
   * shows the "add a card" state. Best-effort: never throws.
   */
  async getDefaultCard(userId: string): Promise<StripeCardDetails | null> {
    if (!this.stripe) return null
    try {
      // getCustomer (a Mongo read) is inside the try too: the contract is
      // "never throws", and get-subscription calls this in a Promise.all, so a
      // Mongo hiccup here would otherwise reject the whole subscription view.
      const customer = await this.getCustomer(userId)
      if (!customer?.defaultPaymentMethodId) return null
      // A const local keeps the non-null narrowing inside the .call() closure
      // (a property access would be re-widened to string | null there).
      const pmId = customer.defaultPaymentMethodId
      return await this.call((s) => s.retrievePaymentMethod(pmId))
    } catch (err) {
      console.warn(`[billing] getDefaultCard failed for ${userId}:`, err)
      return null
    }
  }

  /**
   * Charge a Teros invoice via Stripe Invoices (legal numbering + PDF + tax).
   *
   * Crash-/retry-safe by construction: the invoice item, Stripe invoice and
   * finalize use idempotency keys WITHOUT the attempt number, so a re-run after
   * a crash reuses the SAME Stripe invoice (never duplicates a charge); only the
   * pay call is keyed per attempt, so each dunning retry is a distinct payment
   * attempt against that one invoice. When the Teros invoice already carries a
   * Stripe invoice id (externalReference), the create/finalize step is skipped
   * entirely.
   *
   * Returns a ChargeResult instead of throwing so the charge-cron can record
   * dunning state; the classified issue rides along on failure.
   */
  async chargeInvoice(invoice: ChargeableInvoice, attempt: number): Promise<ChargeResult> {
    const customer = await this.getCustomer(invoice.userId)
    if (!customer?.defaultPaymentMethodId) {
      return {
        status: 'failed',
        issue: {
          code: NO_PAYMENT_METHOD,
          category: 'card',
          retryable: true,
          message: 'No payment method on file. Add a card to be charged.',
        },
      }
    }

    const id = invoice._id
    const expected = toStripeAmount(invoice.amount)
    let stripeInvoiceId = invoice.externalReference ?? undefined
    let invoiceNumber: string | null | undefined
    let hostedInvoiceUrl: string | null | undefined
    let invoicePdfUrl: string | null | undefined

    try {
      // Resolve the FINALIZED Stripe invoice we will guard and (maybe) pay — one
      // guard + one pay covers BOTH how it can arrive: create+finalize (fresh) or
      // retrieve (reuse of an externalReference a crashed prior attempt persisted).
      // The reuse path is exactly where a swept balance already landed on amount_due
      // at finalize time, so it MUST pass through the same guard.
      let ref: StripeInvoiceRef
      if (!stripeInvoiceId) {
        // Create FIRST, then attach the line item explicitly (`invoice: created.id`):
        // the current Stripe API does not auto-pull pending items, so an item without
        // an `invoice` strands and the invoice finalizes at €0. tax_behavior:'inclusive'
        // keeps amount_due === the quote (IVA carved out inside it, never added on top).
        const created = await this.call((s) =>
          s.createInvoice(
            {
              customer: customer.stripeCustomerId,
              collection_method: 'charge_automatically',
              auto_advance: false,
              default_payment_method: customer.defaultPaymentMethodId ?? undefined,
              // Stripe Tax needs a customer tax location; only enable when known.
              automatic_tax: { enabled: Boolean(customer.country) },
              description: invoice.description,
              metadata: { terosInvoiceId: id },
            },
            { idempotencyKey: `inv:${id}` },
          ),
        )
        await this.call((s) =>
          s.createInvoiceItem(
            {
              customer: customer.stripeCustomerId,
              invoice: created.id,
              amount: expected,
              currency: invoice.currency.toLowerCase(),
              tax_behavior: 'inclusive',
              description: invoice.description,
              metadata: { terosInvoiceId: id },
            },
            { idempotencyKey: `ii:${id}` },
          ),
        )
        ref = await this.call((s) => s.finalizeInvoice(created.id, { idempotencyKey: `fin:${id}` }))
        stripeInvoiceId = ref.id
      } else {
        ref = await this.call((s) => s.retrieveInvoice(stripeInvoiceId as string))
        // externalReference is persisted only AFTER finalize, so a reused invoice is
        // normally open/paid/void; finalize a stray draft defensively.
        if (ref.status === 'draft') {
          ref = await this.call((s) =>
            s.finalizeInvoice(stripeInvoiceId as string, { idempotencyKey: `fin:${id}` }),
          )
        }
      }
      invoiceNumber = ref.number
      hostedInvoiceUrl = ref.hosted_invoice_url
      invoicePdfUrl = ref.invoice_pdf
      const refs = { stripeInvoiceId, invoiceNumber, hostedInvoiceUrl, invoicePdfUrl }

      // A prior guard already refused this charge (voided it): stay refused,
      // idempotently, without touching the card.
      if (ref.status === 'void' || ref.status === 'uncollectible') {
        return { status: 'failed', ...refs, issue: this.amountMismatchIssue(expected, ref) }
      }

      // A prior attempt already paid (its response was lost). NEVER re-pay or void a
      // paid invoice. Reconcile what was really collected; if it diverges from the
      // quote (a historical overcharge), the reconciliation-cron alerts on it.
      if (ref.status === 'paid') {
        return { status: 'paid', ...refs, amountPaid: fromStripeAmount(ref.amount_paid) }
      }

      // Anything other than 'open' here is unexpected (finalize yields 'open'). Fail
      // loud rather than pay an invoice in a status we don't understand.
      if (ref.status !== 'open') {
        throw new StripePaymentError({
          code: 'UNEXPECTED_INVOICE_STATUS',
          category: 'request',
          retryable: false,
          message: `Unexpected Stripe invoice status '${ref.status}' for ${stripeInvoiceId}`,
        })
      }

      // GUARD (ref.status === 'open'): the card total must equal the quote and no
      // customer balance may be swept in (Model B never uses Stripe balances). If it
      // diverges, VOID so the charge can never land, and fail loud (integrity: ops-
      // visible, no dunning, no account block — our bug, not the user's).
      if (ref.starting_balance !== 0 || ref.amount_due !== expected) {
        try {
          await this.call((s) => s.voidInvoice(stripeInvoiceId as string))
        } catch (voidErr) {
          // TOCTOU: the invoice was paid between our retrieve and the void → Stripe
          // rejects the void. Re-read; if it is now paid, the money already moved —
          // reconcile it (reconciliation-cron flags the divergence). If it is still
          // unpaid, the void genuinely failed (transient) and the invoice is STILL
          // open — do NOT claim it was voided; rethrow so the caller classifies it
          // retryable and the next attempt re-voids, instead of a false integrity-hold
          // that leaves an open invoice orphaned in Stripe.
          const after = await this.call((s) =>
            s.retrieveInvoice(stripeInvoiceId as string),
          ).catch(() => null)
          if (after?.status === 'paid') {
            return { status: 'paid', ...refs, amountPaid: fromStripeAmount(after.amount_paid) }
          }
          throw voidErr
        }
        return { status: 'failed', ...refs, issue: this.amountMismatchIssue(expected, ref) }
      }

      const paid = await this.call((s) =>
        s.payInvoice(stripeInvoiceId as string, { off_session: true }, {
          idempotencyKey: `pay:${id}:${attempt}`,
        }),
      )
      return {
        status: 'paid',
        ...refs,
        invoiceNumber: invoiceNumber ?? paid.number,
        hostedInvoiceUrl: hostedInvoiceUrl ?? paid.hosted_invoice_url,
        invoicePdfUrl: invoicePdfUrl ?? paid.invoice_pdf,
        amountPaid: fromStripeAmount(paid.amount_paid),
      }
    } catch (err) {
      return {
        status: 'failed',
        issue: err instanceof StripePaymentError ? err.issue : classifyStripeError(err),
        // Keep the Stripe invoice id a partial attempt produced (TER-622) so the next
        // retry reuses it instead of minting a second invoice past key expiry.
        stripeInvoiceId,
        invoiceNumber,
        hostedInvoiceUrl,
        invoicePdfUrl,
      }
    }
  }

  /**
   * Build the integrity issue raised when a charge would collect an amount that
   * diverges from the quote (a swept customer balance, or line-item drift). The
   * invoice has been voided by the caller, so no card was charged.
   */
  private amountMismatchIssue(expectedCents: number, ref: StripeInvoiceRef): StripeIssue {
    const detail =
      ref.starting_balance !== 0
        ? `a customer balance of ${fromStripeAmount(ref.starting_balance)} was swept into the invoice`
        : `subtotal ${fromStripeAmount(ref.subtotal)} ≠ quote ${fromStripeAmount(expectedCents)}`
    return {
      code: AMOUNT_MISMATCH,
      category: 'integrity',
      retryable: false,
      message: `Refused: Stripe would collect ${fromStripeAmount(ref.amount_due)} but the quote is ${fromStripeAmount(expectedCents)} (${detail}). The invoice was voided; no card was charged.`,
    }
  }
}
