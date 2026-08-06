/**
 * Stripe SDK adapter (FASE 4) — the ONLY file that imports the `stripe` package.
 *
 * Constructs a real Stripe client from the system secret and maps its full
 * responses down to the narrow {@link StripeApi} port the billing code uses.
 * If no Stripe secret is configured, `createStripeClient` returns null and the
 * payment paths stay disabled (manual/transfer billing keeps working).
 *
 * Network retries use Stripe's built-in `maxNetworkRetries`, which replays with
 * the SAME idempotency key — safe for mutations (no double-charge). We never add
 * our own retry layer on top.
 */

import Stripe from 'stripe'
import type { StripeSecret } from '../secrets/types.js'
import type {
  CreateCustomerParams,
  CreateInvoiceItemParams,
  CreateInvoiceParams,
  CreateSetupIntentParams,
  ListInvoicesParams,
  StripeApi,
  StripeCardDetails,
  StripeCustomerRef,
  StripeEventRef,
  StripeInvoiceRef,
  StripePaymentMethodRef,
  StripeRequestOptions,
  StripeSetupIntentRef,
  UpdateCustomerParams,
} from './stripe-api.js'

function toInvoiceRef(inv: Stripe.Invoice): StripeInvoiceRef {
  return {
    id: inv.id as string,
    number: inv.number ?? null,
    status: inv.status ?? null,
    hosted_invoice_url: inv.hosted_invoice_url ?? null,
    invoice_pdf: inv.invoice_pdf ?? null,
    amount_due: inv.amount_due,
    amount_paid: inv.amount_paid,
    // v22 dropped Invoice.paid — a fully-collected invoice is status 'paid'.
    paid: inv.status === 'paid',
    // starting_balance = the customer balance Stripe applied to this invoice on
    // finalization (0 for a healthy Teros invoice). subtotal/total let the charge
    // guard assert the card total matches the quote and classify any divergence.
    starting_balance: inv.starting_balance ?? 0,
    subtotal: inv.subtotal ?? 0,
    total: inv.total ?? 0,
  }
}

function toCustomerRef(c: Stripe.Customer | Stripe.DeletedCustomer): StripeCustomerRef {
  const deleted = (c as Stripe.DeletedCustomer).deleted === true ? true : undefined
  return { id: c.id, deleted }
}

class StripeSdkAdapter implements StripeApi {
  private readonly webhookSecret: string

  constructor(
    private readonly stripe: Stripe,
    webhookSecret: string,
  ) {
    this.webhookSecret = webhookSecret
  }

  async createCustomer(
    params: CreateCustomerParams,
    opts?: StripeRequestOptions,
  ): Promise<StripeCustomerRef> {
    const c = await this.stripe.customers.create(params, opts)
    return toCustomerRef(c)
  }

  async retrieveCustomer(id: string): Promise<StripeCustomerRef> {
    const c = await this.stripe.customers.retrieve(id)
    return toCustomerRef(c)
  }

  async updateCustomer(
    id: string,
    params: UpdateCustomerParams,
    opts?: StripeRequestOptions,
  ): Promise<StripeCustomerRef> {
    const c = await this.stripe.customers.update(id, params, opts)
    return toCustomerRef(c)
  }

  async createSetupIntent(
    params: CreateSetupIntentParams,
    opts?: StripeRequestOptions,
  ): Promise<StripeSetupIntentRef> {
    const si = await this.stripe.setupIntents.create(params, opts)
    return { id: si.id, client_secret: si.client_secret ?? null }
  }

  async attachPaymentMethod(
    paymentMethodId: string,
    customerId: string,
    opts?: StripeRequestOptions,
  ): Promise<StripePaymentMethodRef> {
    const pm = await this.stripe.paymentMethods.attach(
      paymentMethodId,
      { customer: customerId },
      opts,
    )
    return { id: pm.id }
  }

  async retrievePaymentMethod(
    paymentMethodId: string,
    opts?: StripeRequestOptions,
  ): Promise<StripeCardDetails | null> {
    const pm = await this.stripe.paymentMethods.retrieve(paymentMethodId, undefined, opts)
    const card = pm.card
    if (!card) return null
    return {
      brand: card.brand,
      last4: card.last4,
      expMonth: card.exp_month,
      expYear: card.exp_year,
    }
  }

  async createInvoiceItem(
    params: CreateInvoiceItemParams,
    opts?: StripeRequestOptions,
  ): Promise<{ id: string }> {
    const item = await this.stripe.invoiceItems.create(params, opts)
    return { id: item.id as string }
  }

  async createInvoice(
    params: CreateInvoiceParams,
    opts?: StripeRequestOptions,
  ): Promise<StripeInvoiceRef> {
    const inv = await this.stripe.invoices.create(params, opts)
    return toInvoiceRef(inv)
  }

  async finalizeInvoice(id: string, opts?: StripeRequestOptions): Promise<StripeInvoiceRef> {
    const inv = await this.stripe.invoices.finalizeInvoice(id, undefined, opts)
    return toInvoiceRef(inv)
  }

  async payInvoice(
    id: string,
    params: { off_session?: boolean },
    opts?: StripeRequestOptions,
  ): Promise<StripeInvoiceRef> {
    const inv = await this.stripe.invoices.pay(id, params, opts)
    return toInvoiceRef(inv)
  }

  async voidInvoice(id: string, opts?: StripeRequestOptions): Promise<StripeInvoiceRef> {
    const inv = await this.stripe.invoices.voidInvoice(id, undefined, opts)
    return toInvoiceRef(inv)
  }

  async retrieveInvoice(id: string): Promise<StripeInvoiceRef> {
    const inv = await this.stripe.invoices.retrieve(id)
    return toInvoiceRef(inv)
  }

  async listInvoices(params: ListInvoicesParams): Promise<{ data: StripeInvoiceRef[] }> {
    const list = await this.stripe.invoices.list(params as Stripe.InvoiceListParams)
    return { data: list.data.map(toInvoiceRef) }
  }

  async constructWebhookEvent(
    payload: string | Buffer,
    signature: string,
  ): Promise<StripeEventRef> {
    // Async verification works under every runtime's crypto provider (Node's
    // NodeCryptoProvider and the WebCrypto SubtleCryptoProvider, which is
    // async-only); the sync constructEvent throws under the latter.
    const event = await this.stripe.webhooks.constructEventAsync(
      payload,
      signature,
      this.webhookSecret,
    )
    return {
      id: event.id,
      type: event.type,
      data: { object: event.data.object as unknown as Record<string, unknown> },
    }
  }
}

/**
 * Build a StripeApi from the system `stripe` secret, or return null when Stripe
 * is not configured (so the backend boots and bills manually without it).
 */
export function createStripeClient(secret: StripeSecret | undefined): StripeApi | null {
  if (!secret?.secretKey || !secret.webhookSecret) return null

  // StripeConfig isn't re-exported on the Stripe namespace — derive it from the
  // constructor so the type stays correct across SDK versions.
  type StripeConfig = NonNullable<ConstructorParameters<typeof Stripe>[1]>
  const config: StripeConfig = {
    // Replays use the same idempotency key — safe for mutations.
    maxNetworkRetries: 2,
    typescript: true,
  }
  if (secret.apiVersion) {
    config.apiVersion = secret.apiVersion as StripeConfig['apiVersion']
  }

  const stripe = new Stripe(secret.secretKey, config)
  return new StripeSdkAdapter(stripe, secret.webhookSecret)
}
