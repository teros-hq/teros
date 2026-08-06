/**
 * Faithful in-memory boundaries for FASE 4 Stripe tests.
 *
 * Two fakes, shared across 4b/4c/4d/4g so the boundary fidelity lives in ONE
 * place (lesson TER-369: an unfaithful mock hides real bugs):
 *
 *   - FakeStripe: an in-memory StripeApi. Models the invoice lifecycle
 *     (draft → open → paid), idempotency-key dedup on mutations (a replayed key
 *     returns the cached result, never re-runs), and a controllable charge
 *     outcome so dunning paths can be exercised. Throws Stripe-shaped errors
 *     (objects with `type`/`decline_code`) the classifier consumes.
 *
 *   - InMemoryDb: a minimal MongoDB whose collections support the exact
 *     operators the billing code uses: equality / $in / $lt / $lte / $gt /
 *     $gte / $ne / $exists / $or in filters, and $set / $setOnInsert / $inc in
 *     updates, with upsert. find() returns an async cursor.
 */

import { MongoServerError } from 'mongodb'
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
} from '../../src/services/stripe-api'

// ============================================================================
// FakeStripe
// ============================================================================

export interface FakeStripeError {
  type: string
  code?: string
  decline_code?: string
  message?: string
}

interface InvoiceState extends StripeInvoiceRef {
  customer: string
}

export class FakeStripe implements StripeApi {
  calls: Array<{ method: string; args: unknown[]; idempotencyKey?: string }> = []
  private idempotency = new Map<string, unknown>()
  private seq = 0
  private customers = new Map<string, StripeCustomerRef>()
  private pendingItems = new Map<string, number>() // customer → summed amount of open items
  private invoices = new Map<string, InvoiceState>()
  // customer → pending balance (cents). POSITIVE = the customer owes us (a debit),
  // which Stripe SWEEPS into the next invoice on finalization and cannot be opted
  // out per-invoice — the exact mechanic behind the €43→€145 incident. Model B
  // never creates these, but a leftover from the pre-fix path detonates here.
  private customerBalances = new Map<string, number>()

  /** Seed a leftover customer balance (cents) to reproduce the sweep in tests. */
  seedCustomerBalance(customerId: string, cents: number): void {
    this.customerBalances.set(customerId, cents)
  }

  /** Current pending balance (cents) for assertions (0 after a sweep). */
  customerBalance(customerId: string): number {
    return this.customerBalances.get(customerId) ?? 0
  }

  /**
   * Controls payInvoice. Default: succeed. Set to a function that throws a
   * FakeStripeError (or returns void to succeed) to exercise dunning.
   */
  chargeBehavior: (inv: InvoiceState) => void = () => {}

  private next(prefix: string): string {
    this.seq += 1
    return `${prefix}_${this.seq}`
  }

  /** Inject a Stripe invoice state for retrieveInvoice/listInvoices (tests). */
  seedInvoice(id: string, over: Partial<StripeInvoiceRef> & { customer?: string } = {}): void {
    const amountDue = over.amount_due ?? 8900
    const isPaid = over.paid === true || over.status === 'paid'
    this.invoices.set(id, {
      id,
      number: over.number ?? `TEROS-${id}`,
      status: over.status ?? 'open',
      hosted_invoice_url: over.hosted_invoice_url ?? `https://invoice.stripe.test/${id}`,
      invoice_pdf: over.invoice_pdf ?? `https://invoice.stripe.test/${id}.pdf`,
      amount_due: amountDue,
      // A paid invoice paid its amount_due — faithful default so the amount
      // reconciliation doesn't see a spurious mismatch on unrelated tests.
      amount_paid: over.amount_paid ?? (isPaid ? amountDue : 0),
      paid: over.paid ?? over.status === 'paid',
      starting_balance: over.starting_balance ?? 0,
      subtotal: over.subtotal ?? amountDue,
      total: over.total ?? amountDue,
      customer: over.customer ?? 'cus_1',
    })
  }

  /**
   * Drop all cached idempotency keys, simulating Stripe expiring them (~24h).
   * After this, a replayed key re-runs its operation instead of returning the
   * cached result — exactly what makes a stale retry dangerous.
   */
  clearIdempotency(): void {
    this.idempotency.clear()
  }

  /** Apply idempotency: a repeated key returns the cached result verbatim. */
  private memo<T>(opts: StripeRequestOptions | undefined, run: () => T): T {
    const key = opts?.idempotencyKey
    if (key && this.idempotency.has(key)) return this.idempotency.get(key) as T
    const result = run()
    if (key) this.idempotency.set(key, result)
    return result
  }

  private record(method: string, args: unknown[], opts?: StripeRequestOptions): void {
    this.calls.push({ method, args, idempotencyKey: opts?.idempotencyKey })
  }

  async createCustomer(
    params: CreateCustomerParams,
    opts?: StripeRequestOptions,
  ): Promise<StripeCustomerRef> {
    this.record('createCustomer', [params], opts)
    return this.memo(opts, () => {
      const ref: StripeCustomerRef = { id: this.next('cus') }
      this.customers.set(ref.id, ref)
      return ref
    })
  }

  async retrieveCustomer(id: string): Promise<StripeCustomerRef> {
    this.record('retrieveCustomer', [id])
    return this.customers.get(id) ?? { id, deleted: true }
  }

  async updateCustomer(
    id: string,
    params: UpdateCustomerParams,
    opts?: StripeRequestOptions,
  ): Promise<StripeCustomerRef> {
    this.record('updateCustomer', [id, params], opts)
    return { id }
  }

  async createSetupIntent(
    params: CreateSetupIntentParams,
    opts?: StripeRequestOptions,
  ): Promise<StripeSetupIntentRef> {
    this.record('createSetupIntent', [params], opts)
    const id = this.next('seti')
    return { id, client_secret: `${id}_secret` }
  }

  async attachPaymentMethod(
    paymentMethodId: string,
    customerId: string,
    opts?: StripeRequestOptions,
  ): Promise<StripePaymentMethodRef> {
    this.record('attachPaymentMethod', [paymentMethodId, customerId], opts)
    return { id: paymentMethodId }
  }

  /** Card returned by retrievePaymentMethod. Tests override via `setCard`. */
  card: StripeCardDetails | null = { brand: 'visa', last4: '4242', expMonth: 4, expYear: 2027 }

  setCard(card: StripeCardDetails | null): void {
    this.card = card
  }

  async retrievePaymentMethod(
    paymentMethodId: string,
    opts?: StripeRequestOptions,
  ): Promise<StripeCardDetails | null> {
    this.record('retrievePaymentMethod', [paymentMethodId], opts)
    return this.card
  }

  async createInvoiceItem(
    params: CreateInvoiceItemParams,
    opts?: StripeRequestOptions,
  ): Promise<{ id: string }> {
    this.record('createInvoiceItem', [params], opts)
    return this.memo(opts, () => {
      // Faithful to the current Stripe API: an item created WITH `invoice` lands on
      // that invoice; WITHOUT it the item is left pending (stranded — the exact
      // shape of the €0-invoice bug). chargeInvoice now always passes `invoice`.
      if (params.invoice) {
        const inv = this.invoices.get(params.invoice)
        if (inv) {
          // Line item lands on the invoice. tax_behavior:'inclusive' (what
          // chargeInvoice sends) means the amount already includes any tax, so
          // subtotal == total == the item sum; the balance is swept later, at
          // finalize, onto amount_due.
          inv.subtotal += params.amount
          inv.total += params.amount
          inv.amount_due += params.amount
        }
      } else {
        this.pendingItems.set(
          params.customer,
          (this.pendingItems.get(params.customer) ?? 0) + params.amount,
        )
      }
      return { id: this.next('ii') }
    })
  }

  async createInvoice(
    params: CreateInvoiceParams,
    opts?: StripeRequestOptions,
  ): Promise<StripeInvoiceRef> {
    this.record('createInvoice', [params], opts)
    return this.memo(opts, () => {
      const amount = this.pendingItems.get(params.customer) ?? 0
      this.pendingItems.delete(params.customer)
      const id = this.next('in')
      const inv: InvoiceState = {
        id,
        number: null,
        status: 'draft',
        hosted_invoice_url: null,
        invoice_pdf: null,
        amount_due: amount,
        amount_paid: 0,
        paid: false,
        starting_balance: 0,
        subtotal: amount,
        total: amount,
        customer: params.customer,
      }
      this.invoices.set(id, inv)
      return { ...inv }
    })
  }

  async finalizeInvoice(id: string, opts?: StripeRequestOptions): Promise<StripeInvoiceRef> {
    this.record('finalizeInvoice', [id], opts)
    // Idempotent like Stripe: re-finalizing returns the same (already-open) invoice
    // without re-sweeping the balance a second time.
    return this.memo(opts, () => {
      const inv = this.requireInvoice(id)
      if (inv.status === 'draft') {
        // THE SWEEP: on finalization Stripe applies the customer's pending balance
        // to this invoice (starting_balance) and adds it to amount_due — this cannot
        // be turned off per-invoice. A positive (debit) balance inflates the charge.
        const bal = this.customerBalances.get(inv.customer) ?? 0
        inv.starting_balance = bal
        inv.amount_due = inv.subtotal + bal
        this.customerBalances.set(inv.customer, 0) // consumed by this invoice
        inv.status = 'open'
        inv.number = inv.number ?? `TEROS-${this.next('n').split('_')[1].padStart(4, '0')}`
        inv.hosted_invoice_url = `https://invoice.stripe.test/${id}`
        inv.invoice_pdf = `https://invoice.stripe.test/${id}.pdf`
      }
      return { ...inv }
    })
  }

  async voidInvoice(id: string, opts?: StripeRequestOptions): Promise<StripeInvoiceRef> {
    this.record('voidInvoice', [id], opts)
    const inv = this.requireInvoice(id)
    // Stripe rejects voiding a paid invoice (money already moved).
    if (inv.status === 'paid') {
      throw stripeError({ type: 'StripeInvalidRequestError', message: 'Invoice is already paid' })
    }
    // Voiding RETURNS the swept balance to the customer (Fallo 4): it is not lost,
    // which is exactly why the next period would re-sweep it absent remediation.
    if (inv.starting_balance !== 0) {
      this.customerBalances.set(
        inv.customer,
        (this.customerBalances.get(inv.customer) ?? 0) + inv.starting_balance,
      )
    }
    inv.status = 'void'
    return { ...inv }
  }

  async payInvoice(
    id: string,
    _params: { off_session?: boolean },
    opts?: StripeRequestOptions,
  ): Promise<StripeInvoiceRef> {
    this.record('payInvoice', [id, _params], opts)
    const inv = this.requireInvoice(id)
    // Stripe rejects paying a voided invoice — the charge guard voids before paying,
    // so a live pay() on a void invoice would be a bug we want to surface.
    if (inv.status === 'void') {
      throw stripeError({ type: 'StripeInvalidRequestError', message: 'Invoice is voided' })
    }
    // Idempotency: a replayed key returns the cached (already-paid) result and
    // does NOT re-run chargeBehavior — exactly like Stripe.
    const key = opts?.idempotencyKey
    if (key && this.idempotency.has(key)) return this.idempotency.get(key) as StripeInvoiceRef

    this.chargeBehavior(inv) // may throw a FakeStripeError
    inv.status = 'paid'
    inv.paid = true
    inv.amount_paid = inv.amount_due
    const result = { ...inv }
    if (key) this.idempotency.set(key, result)
    return result
  }

  async retrieveInvoice(id: string): Promise<StripeInvoiceRef> {
    this.record('retrieveInvoice', [id])
    return { ...this.requireInvoice(id) }
  }

  async listInvoices(params: ListInvoicesParams): Promise<{ data: StripeInvoiceRef[] }> {
    this.record('listInvoices', [params])
    let data = [...this.invoices.values()]
    if (params.customer) data = data.filter((i) => i.customer === params.customer)
    if (params.status) data = data.filter((i) => i.status === params.status)
    return { data: data.map((i) => ({ ...i })) }
  }

  constructWebhookEvent(): Promise<StripeEventRef> {
    throw new Error('FakeStripe.constructWebhookEvent: use the real adapter in webhook tests')
  }

  private requireInvoice(id: string): InvoiceState {
    const inv = this.invoices.get(id)
    if (!inv) throw stripeError({ type: 'StripeInvalidRequestError', message: `No such invoice: ${id}` })
    return inv
  }
}

/** Build a thrown Stripe-shaped error (what the SDK rejects with). */
export function stripeError(e: FakeStripeError): FakeStripeError {
  return e
}

// ============================================================================
// InMemoryDb — minimal MongoDB faithful to the operators billing uses.
// ============================================================================

type Doc = Record<string, any>

function matchValue(actual: any, cond: any): boolean {
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    for (const [op, val] of Object.entries(cond)) {
      switch (op) {
        case '$in':
          if (!(val as any[]).some((v) => eq(actual, v))) return false
          break
        case '$nin':
          if ((val as any[]).some((v) => eq(actual, v))) return false
          break
        case '$ne':
          if (eq(actual, val)) return false
          break
        case '$lt':
          if (!(actual != null && actual < (val as any))) return false
          break
        case '$lte':
          if (!(actual != null && actual <= (val as any))) return false
          break
        case '$gt':
          if (!(actual != null && actual > (val as any))) return false
          break
        case '$gte':
          if (!(actual != null && actual >= (val as any))) return false
          break
        case '$exists':
          if ((actual !== undefined) !== (val as boolean)) return false
          break
        default:
          throw new Error(`InMemoryDb: unsupported operator ${op}`)
      }
    }
    return true
  }
  return eq(actual, cond)
}

function eq(a: any, b: any): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  return a === b
}

function matchDoc(doc: Doc, filter: Doc): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$or') {
      if (!(cond as Doc[]).some((sub) => matchDoc(doc, sub))) return false
      continue
    }
    if (!matchValue(doc[key], cond)) return false
  }
  return true
}

export class InMemoryCollection {
  docs: Doc[] = []

  // Reads return COPIES (like real Mongo) so a caller can't mutate stored state
  // by reference — a live-ref read would hide bugs (e.g. reading a field the
  // caller's own updateOne just changed in place).
  async findOne(filter: Doc = {}): Promise<Doc | null> {
    const found = this.docs.find((d) => matchDoc(d, filter))
    return found ? { ...found } : null
  }

  find(filter: Doc = {}) {
    const rows = this.docs.filter((d) => matchDoc(d, filter))
    let sorted = rows
    const api = {
      sort(spec: Doc) {
        const [[k, dir]] = Object.entries(spec)
        sorted = [...sorted].sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (dir as number))
        return api
      },
      skip(n: number) {
        sorted = sorted.slice(n)
        return api
      },
      limit(n: number) {
        sorted = sorted.slice(0, n)
        return api
      },
      async toArray() {
        return sorted.map((d) => ({ ...d }))
      },
      [Symbol.asyncIterator]() {
        let i = 0
        return {
          next: () =>
            Promise.resolve(
              i < sorted.length
                ? { value: { ...sorted[i++] }, done: false }
                : { value: undefined, done: true },
            ),
        }
      },
      async close() {},
    }
    return api
  }

  async insertOne(doc: Doc): Promise<{ insertedId: any }> {
    // Enforce _id uniqueness like Mongo. Throw a REAL MongoServerError (code
    // 11000) so isMongoDuplicateKey's `instanceof MongoServerError` check sees
    // it — a plain {code:11000} would be silently rejected (faithful boundary).
    if (doc._id !== undefined && this.docs.some((d) => eq(d._id, doc._id))) {
      const err = new MongoServerError({ message: 'E11000 duplicate key error' })
      err.code = 11000
      throw err
    }
    this.docs.push({ ...doc })
    return { insertedId: doc._id }
  }

  // Distinct values of `field` across docs matching `filter` — mirrors Mongo's
  // collection.distinct(), used by backfill migrations that key off a set.
  async distinct(field: string, filter: Doc = {}): Promise<any[]> {
    const seen = new Set<any>()
    for (const d of this.docs) {
      if (matchDoc(d, filter) && d[field] !== undefined) seen.add(d[field])
    }
    return [...seen]
  }

  async updateOne(
    filter: Doc,
    update: Doc,
    opts: { upsert?: boolean } = {},
  ): Promise<{ matchedCount: number; modifiedCount: number; upsertedCount: number; upsertedId: any }> {
    const existing = this.docs.find((d) => matchDoc(d, filter))
    if (existing) {
      applyUpdate(existing, update, false)
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null }
    }
    if (opts.upsert) {
      const doc: Doc = {}
      // Seed equality fields from the filter (Mongo upsert semantics).
      for (const [k, v] of Object.entries(filter)) {
        if (typeof v !== 'object' || v instanceof Date) doc[k] = v
      }
      applyUpdate(doc, update, true)
      this.docs.push(doc)
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: doc._id }
    }
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null }
  }

  async updateMany(
    filter: Doc,
    update: Doc,
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const matches = this.docs.filter((d) => matchDoc(d, filter))
    for (const d of matches) applyUpdate(d, update, false)
    return { matchedCount: matches.length, modifiedCount: matches.length }
  }

  async deleteMany(filter: Doc = {}): Promise<{ deletedCount: number }> {
    const before = this.docs.length
    this.docs = this.docs.filter((d) => !matchDoc(d, filter))
    return { deletedCount: before - this.docs.length }
  }

  async deleteOne(filter: Doc = {}): Promise<{ deletedCount: number }> {
    const idx = this.docs.findIndex((d) => matchDoc(d, filter))
    if (idx === -1) return { deletedCount: 0 }
    this.docs.splice(idx, 1)
    return { deletedCount: 1 }
  }

  async countDocuments(filter: Doc = {}): Promise<number> {
    return this.docs.filter((d) => matchDoc(d, filter)).length
  }

  /**
   * Faithful to the mongodb v6 driver: returns the document directly (not
   * `{ value }`), the after-image when returnDocument:'after' (default here),
   * the before-image when 'before', and creates+returns on upsert. The `$inc`
   * is applied atomically server-side in real Mongo — the single-threaded fake
   * is trivially atomic, which is enough to exercise the counter semantics.
   */
  async findOneAndUpdate(
    filter: Doc,
    update: Doc,
    opts: { upsert?: boolean; returnDocument?: 'before' | 'after' } = {},
  ): Promise<Doc | null> {
    const existing = this.docs.find((d) => matchDoc(d, filter))
    if (existing) {
      const before = { ...existing }
      applyUpdate(existing, update, false)
      return opts.returnDocument === 'before' ? before : { ...existing }
    }
    if (opts.upsert) {
      const doc: Doc = {}
      for (const [k, v] of Object.entries(filter)) {
        if (typeof v !== 'object' || v instanceof Date) doc[k] = v
      }
      applyUpdate(doc, update, true)
      this.docs.push(doc)
      return opts.returnDocument === 'before' ? null : { ...doc }
    }
    return null
  }

  /**
   * Stub: returns an empty result for any pipeline. The billing paths exercised
   * by the Stripe-reconcile tests don't depend on aggregation output (no active
   * subs, no duplicate invoices); the hours-reconciliation tests use a dedicated
   * faithful fake elsewhere.
   */
  aggregate(_pipeline: Doc[]) {
    return { async toArray() { return [] as Doc[] } }
  }
}

function applyUpdate(doc: Doc, update: Doc, isInsert: boolean): void {
  if (update.$setOnInsert && isInsert) Object.assign(doc, update.$setOnInsert)
  if (update.$set) Object.assign(doc, update.$set)
  if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] ?? 0) + (v as number)
  if (update.$unset) for (const k of Object.keys(update.$unset)) delete doc[k]
}

export class InMemoryDb {
  private collections = new Map<string, InMemoryCollection>()

  collection(name: string): InMemoryCollection {
    let col = this.collections.get(name)
    if (!col) {
      col = new InMemoryCollection()
      this.collections.set(name, col)
    }
    return col
  }

  /** Seed a collection's docs (test setup convenience). */
  seed(name: string, docs: Doc[]): void {
    this.collection(name).docs.push(...docs.map((d) => ({ ...d })))
  }
}
