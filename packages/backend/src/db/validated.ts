/**
 * Schema validation at the data layer (GOV-2).
 *
 * `withSchemaValidation(db)` returns a Db whose `collection(name)` hands out a
 * validating wrapper for the collections that have a document schema
 * (./schemas.ts DOC_SCHEMAS) and the plain driver Collection for the rest. It
 * is applied once where the backend creates its Db (src/index.ts), so every
 * call site is covered without changes.
 *
 * READS  (findOne, find cursors, findOneAnd* results) — a document that does
 *        not match logs a WARN and is returned unchanged.
 * WRITES (insertOne/Many, replaceOne, findOneAndReplace, updateOne/Many,
 *        findOneAndUpdate, bulkWrite) — checked BEFORE the driver call.
 *        DB_SCHEMA_WRITES=warn (default): log a WARN and write anyway.
 *        DB_SCHEMA_WRITES=error: throw SchemaValidationError, nothing is written
 *        (also logged, since some callers swallow write errors).
 *
 * Logs carry the collection, the operation, the _id when there is one and the
 * failing paths with type-level messages — never field values (PII). Each
 * (kind, collection, issue signature) is logged at most once per 10 minutes,
 * with the number of occurrences suppressed in between, so legacy data does
 * not flood the logs.
 *
 * Details:
 * - Projected reads are validated against a deep-partial copy of the schema
 *   (present fields must have the right type; missing ones are fine).
 *   Projections that compute values (anything other than 0/1/true/false) and
 *   `raw` reads are not validated.
 * - Writes are checked as mongod will see them: `undefined` values are
 *   serialized as null by the driver, so they are checked as null.
 * - Operator updates check each touched path against the schema of that
 *   (dotted) path: $set/$setOnInsert/$min/$max values, $unset/$rename of a
 *   required field, $inc/$mul on a non-number field, $push/$addToSet elements
 *   of a typed array, $currentDate on a non-date field. Paths the schema does
 *   not describe are allowed (passthrough). Pipeline updates are skipped.
 * - Upserts additionally validate the document an insert would create
 *   (equality fields of the filter + the update), so missing required fields
 *   are caught even when the upsert happens to match an existing document.
 * - aggregate, distinct, countDocuments, deletes, indexes, watch, bulk op
 *   builders (initializeOrderedBulkOp) and `db.collections()` are not wrapped.
 *   A cursor's clone() loses the read check (the driver drops transforms).
 */

import type { Collection, Db, Document } from 'mongodb'
import { z } from 'zod'
import { createLogger } from '../lib/logger'
import { DOC_SCHEMAS } from './schemas'

// ---------------------------------------------------------------------------
// Mode, logger, errors
// ---------------------------------------------------------------------------

export type SchemaWriteMode = 'warn' | 'error'

type WarnLogger = { warn: (obj: object, msg: string) => void; debug: (obj: object, msg: string) => void }

let log: WarnLogger = createLogger('db-schema')

function parseMode(value: string | undefined): SchemaWriteMode {
  if (value === 'error') return 'error'
  if (value !== undefined && value !== '' && value !== 'warn') {
    log.warn({ value }, 'DB_SCHEMA_WRITES must be "warn" or "error": using "warn"')
  }
  return 'warn'
}

// Read on first use rather than at import, so a .env loaded by the entry
// point (config.ts, scripts) after this module is imported still counts.
let writeMode: SchemaWriteMode | undefined

/** Current write mode (env DB_SCHEMA_WRITES, read once). */
export function getSchemaWriteMode(): SchemaWriteMode {
  writeMode ??= parseMode(process.env.DB_SCHEMA_WRITES)
  return writeMode
}

/** Override the write mode (tests). */
export function setSchemaWriteMode(mode: SchemaWriteMode): void {
  writeMode = mode
}

/** Swap the logger (tests); null restores the module logger. Also resets the dedupe state. */
export function setSchemaLogger(logger: WarnLogger | null): void {
  log = logger ?? createLogger('db-schema')
  resetSchemaWarnings()
}

export interface SchemaIssue {
  path: string
  code: string
  message: string
}

/** Thrown by writes that do not match the schema when DB_SCHEMA_WRITES=error. */
export class SchemaValidationError extends Error {
  readonly collection: string
  readonly operation: string
  readonly issues: SchemaIssue[]

  constructor(collection: string, operation: string, issues: SchemaIssue[]) {
    super(
      `Schema validation failed: ${operation} on ${collection}: ` +
        issues.map((i) => `${i.path} (${i.message})`).join('; '),
    )
    this.name = 'SchemaValidationError'
    this.collection = collection
    this.operation = operation
    this.issues = issues
  }
}

// ---------------------------------------------------------------------------
// Reporting (deduped)
// ---------------------------------------------------------------------------

const DEDUPE_WINDOW_MS = 10 * 60 * 1000
const DEDUPE_MAX_KEYS = 1000
const seen = new Map<string, { at: number; suppressed: number }>()

/** Forget which warnings were already logged (tests). */
export function resetSchemaWarnings(): void {
  seen.clear()
}

const MESSAGES = {
  read: 'Document read from the database does not match its schema',
  write: 'Write does not match the collection schema (DB_SCHEMA_WRITES=warn: written anyway)',
  // Also logged when rejecting: some callers swallow write errors
  rejected: 'Write rejected: it does not match the collection schema (DB_SCHEMA_WRITES=error)',
} as const

function report(kind: keyof typeof MESSAGES, collection: string, operation: string, id: unknown, issues: SchemaIssue[]) {
  const signature = `${kind}|${collection}|${issues
    .map((i) => `${i.path}:${i.code}`)
    .sort()
    .join(',')}`
  const now = Date.now()
  const entry = seen.get(signature)
  if (entry && now - entry.at < DEDUPE_WINDOW_MS) {
    entry.suppressed++
    return
  }
  if (seen.size >= DEDUPE_MAX_KEYS) seen.clear()
  seen.set(signature, { at: now, suppressed: 0 })
  log.warn(
    {
      collection,
      operation,
      ...(id !== undefined && id !== null ? { _id: String(id) } : {}),
      issues,
      suppressed: entry?.suppressed ?? 0,
    },
    MESSAGES[kind],
  )
}

/** zod issue → path + a message that never contains the offending value. */
function toIssue(issue: z.ZodIssue, prefix: string): SchemaIssue {
  const path = [prefix, ...issue.path.map(String)].filter(Boolean).join('.') || '(root)'
  switch (issue.code) {
    case 'invalid_type':
      return {
        path,
        code: issue.received === 'undefined' ? 'required' : issue.code,
        message: issue.received === 'undefined' ? 'required' : `expected ${issue.expected}, received ${issue.received}`,
      }
    case 'invalid_enum_value':
      return { path, code: issue.code, message: `expected one of ${issue.options.join(' | ')}` }
    case 'invalid_union':
      return { path, code: issue.code, message: 'matches none of the allowed types' }
    case 'invalid_date':
      return { path, code: issue.code, message: 'invalid date' }
    default:
      return { path, code: issue.code, message: issue.code }
  }
}

function check(schema: z.ZodTypeAny, value: unknown, prefix = ''): SchemaIssue[] {
  const result = schema.safeParse(value)
  return result.success ? [] : result.error.issues.map((i) => toIssue(i, prefix))
}

// ---------------------------------------------------------------------------
// Compiled schemas (built once)
// ---------------------------------------------------------------------------

interface Compiled {
  full: z.AnyZodObject
  /** For projected reads: every field optional, at every depth. */
  partial: z.ZodTypeAny
}

const COMPILED = new Map<string, Compiled>(
  Object.entries(DOC_SCHEMAS).map(([name, full]) => [name, { full, partial: full.deepPartial() }]),
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** What mongod will store: the driver serializes `undefined` as null. */
function asStored(value: unknown): unknown {
  if (value === undefined) return null
  if (Array.isArray(value)) return value.map(asStored)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) out[key] = asStored(value[key])
    return out
  }
  return value
}

function stored(value: unknown, options: { ignoreUndefined?: boolean } | undefined): unknown {
  return options?.ignoreUndefined ? value : asStored(value)
}

function isOperatorObject(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false
  const keys = Object.keys(value)
  return keys.length > 0 && keys.every((k) => k.startsWith('$'))
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let s = schema
  while (s instanceof z.ZodOptional || s instanceof z.ZodNullable || s instanceof z.ZodDefault) {
    s = s._def.innerType
  }
  return s
}

interface ResolvedPath {
  schema: z.ZodTypeAny
  /** Set when the last segment is a key of an object schema. */
  parent?: z.AnyZodObject
  key?: string
}

/** Schema of a dotted update path, or undefined when the schema does not describe it. */
function resolvePath(root: z.AnyZodObject, path: string): ResolvedPath | undefined {
  let current: ResolvedPath = { schema: root }
  for (const segment of path.split('.')) {
    const s = unwrap(current.schema)
    if (s instanceof z.ZodObject) {
      const next = (s.shape as Record<string, z.ZodTypeAny>)[segment]
      if (!next) return undefined
      current = { schema: next, parent: s, key: segment }
    } else if (s instanceof z.ZodArray && (/^\d+$/.test(segment) || segment.startsWith('$'))) {
      current = { schema: s.element }
    } else {
      return undefined
    }
  }
  return current
}

function isRequired(resolved: ResolvedPath): boolean {
  return !!resolved.parent && !!resolved.key && !resolved.parent.shape[resolved.key].isOptional()
}

function setPath(doc: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.')
  let target = doc
  for (const segment of segments.slice(0, -1)) {
    if (!isPlainObject(target[segment])) target[segment] = {}
    target = target[segment] as Record<string, unknown>
  }
  target[segments[segments.length - 1]] = value
}

function addFilterEqualities(filter: unknown, doc: Record<string, unknown>): void {
  if (!isPlainObject(filter)) return
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' && Array.isArray(value)) {
      for (const clause of value) addFilterEqualities(clause, doc)
    } else if (key.startsWith('$')) {
      // $or / $nor / $expr…: nothing certain to copy into the inserted document
    } else if (isOperatorObject(value)) {
      if ('$eq' in value) setPath(doc, key, value.$eq)
    } else {
      setPath(doc, key, value)
    }
  }
}

function eachValues(value: unknown): unknown[] {
  return isPlainObject(value) && Array.isArray(value.$each) ? value.$each : [value]
}

/** The document an upsert would insert: filter equalities + the update. */
function upsertDocument(filter: unknown, update: Record<string, unknown>): Record<string, unknown> {
  const doc: Record<string, unknown> = {}
  addFilterEqualities(filter, doc)
  for (const [op, fields] of Object.entries(update)) {
    if (!isPlainObject(fields)) continue
    for (const [path, value] of Object.entries(fields)) {
      switch (op) {
        case '$set':
        case '$setOnInsert':
        case '$min':
        case '$max':
        case '$inc':
          setPath(doc, path, value)
          break
        case '$mul':
          setPath(doc, path, 0)
          break
        case '$currentDate':
          setPath(doc, path, new Date())
          break
        case '$push':
        case '$addToSet':
          setPath(doc, path, eachValues(value))
          break
      }
    }
  }
  return doc
}

function dedupeIssues(issues: SchemaIssue[]): SchemaIssue[] {
  const byKey = new Map<string, SchemaIssue>()
  for (const issue of issues) byKey.set(`${issue.path}|${issue.code}`, issue)
  return [...byKey.values()]
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkDocument(schema: z.AnyZodObject, doc: unknown, options: Document | undefined): SchemaIssue[] {
  return check(schema, stored(doc, options))
}

type OperatorCheck = (
  resolved: ResolvedPath,
  path: string,
  value: unknown,
  options: Document | undefined,
  op: string,
) => SchemaIssue[]

const checkValue: OperatorCheck = (resolved, path, value, options) =>
  check(resolved.schema, stored(value, options), path)

const checkNotRequired =
  (message: string): OperatorCheck =>
  (resolved, path) =>
    isRequired(resolved) ? [{ path, code: 'required', message }] : []

const checkNumeric: OperatorCheck = (resolved, path, _value, _options, op) =>
  resolved.schema.safeParse(1).success
    ? []
    : [{ path, code: 'invalid_type', message: `${op} on a field that is not a number` }]

const checkCurrentDate: OperatorCheck = (resolved, path, value) =>
  isPlainObject(value) && value.$type === 'timestamp' ? [] : check(resolved.schema, new Date(), path)

const checkArrayElements: OperatorCheck = (resolved, path, value, options, op) => {
  const s = unwrap(resolved.schema)
  if (s instanceof z.ZodArray) {
    return eachValues(value).flatMap((element) => check(s.element, stored(element, options), `${path}.$`))
  }
  return resolved.schema.safeParse([]).success
    ? []
    : [{ path, code: 'invalid_type', message: `${op} on a field that is not an array` }]
}

/** Per update operator: how a touched path is checked. Unlisted operators ($pull, $pop…) are not. */
const OPERATOR_CHECKS: Record<string, OperatorCheck> = {
  $set: checkValue,
  $setOnInsert: checkValue,
  $min: checkValue,
  $max: checkValue,
  $unset: checkNotRequired('required field cannot be unset'),
  $rename: checkNotRequired('required field cannot be renamed away'),
  $inc: checkNumeric,
  $mul: checkNumeric,
  $currentDate: checkCurrentDate,
  $push: checkArrayElements,
  $addToSet: checkArrayElements,
}

/** Issues of an update document (pipeline updates are not checked). */
function checkUpdate(
  collection: string,
  schema: z.AnyZodObject,
  filter: unknown,
  update: unknown,
  options: Document | undefined,
): SchemaIssue[] {
  if (Array.isArray(update)) {
    log.debug({ collection }, 'Pipeline update: schema validation skipped')
    return []
  }
  if (!isPlainObject(update)) return []
  const upsert = options?.upsert === true
  const issues: SchemaIssue[] = []

  for (const [op, fields] of Object.entries(update)) {
    const checkOperator = OPERATOR_CHECKS[op]
    if (!checkOperator || !isPlainObject(fields)) continue
    if (op === '$setOnInsert' && !upsert) continue
    for (const [path, value] of Object.entries(fields)) {
      const resolved = resolvePath(schema, path)
      if (resolved) issues.push(...checkOperator(resolved, path, value, options, op))
    }
  }

  if (upsert) issues.push(...checkDocument(schema, upsertDocument(filter, update), options))
  return dedupeIssues(issues)
}

function enforceWrite(collection: string, operation: string, id: unknown, issues: SchemaIssue[]): void {
  if (issues.length === 0) return
  if (getSchemaWriteMode() === 'error') {
    report('rejected', collection, operation, id, issues)
    throw new SchemaValidationError(collection, operation, issues)
  }
  report('write', collection, operation, id, issues)
}

function filterId(filter: unknown): unknown {
  if (!isPlainObject(filter)) return undefined
  const id = filter._id
  return id === undefined || isOperatorObject(id) ? undefined : id
}

function isSimpleProjection(projection: Document): boolean {
  return Object.values(projection).every((v) => v === 0 || v === 1 || v === true || v === false)
}

function checkRead<D>(collection: string, compiled: Compiled, operation: string, doc: D, options?: Document): D {
  if (!isPlainObject(doc) || options?.raw) return doc
  let schema: z.ZodTypeAny = compiled.full
  const projection = options?.projection as Document | undefined
  if (projection && Object.keys(projection).length > 0) {
    if (!isSimpleProjection(projection)) return doc
    schema = compiled.partial
  }
  const issues = check(schema, doc)
  if (issues.length > 0) report('read', collection, operation, doc._id, issues)
  return doc
}

// ---------------------------------------------------------------------------
// Collection wrapper
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: stands in for the driver's overloaded method signatures
type AnyFn = (...args: any[]) => unknown

interface Ctx {
  coll: Collection<Document>
  name: string
  compiled: Compiled
}

const READ_RESULT_OPS = new Set(['findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete'])

function checkBulkOp(ctx: Ctx, op: Document): SchemaIssue[] {
  const { name, compiled } = ctx
  if (op.insertOne) return checkDocument(compiled.full, op.insertOne.document, op.insertOne)
  if (op.replaceOne) return checkDocument(compiled.full, op.replaceOne.replacement, op.replaceOne)
  const update = op.updateOne ?? op.updateMany
  if (update) return checkUpdate(name, compiled.full, update.filter, update.update, update)
  return []
}

const METHODS: Record<string, (ctx: Ctx) => AnyFn> = {
  findOne:
    ({ coll, name, compiled }) =>
    async (filter?: Document, options?: Document) =>
      checkRead(name, compiled, 'findOne', await coll.findOne(filter ?? {}, options), options),

  find:
    ({ coll, name, compiled }) =>
    (filter?: Document, options?: Document) => {
      const cursor = coll.find(filter ?? {}, options)
      if (options?.raw) return cursor
      // The transform runs on every document however the cursor is consumed
      // (toArray, for await, next, forEach, stream) and keeps chaining
      // (sort/limit/project) working; the projection is read when the
      // document arrives, so a later .project() is honoured.
      return cursor.map((doc: Document) =>
        checkRead(name, compiled, 'find', doc, {
          projection: (cursor as unknown as { findOptions?: Document }).findOptions?.projection,
        }),
      )
    },

  insertOne:
    ({ coll, name, compiled }) =>
    async (doc: Document, options?: Document) => {
      enforceWrite(name, 'insertOne', doc?._id, checkDocument(compiled.full, doc, options))
      return coll.insertOne(doc, options)
    },

  insertMany:
    ({ coll, name, compiled }) =>
    async (docs: Document[], options?: Document) => {
      for (const doc of docs) {
        enforceWrite(name, 'insertMany', doc?._id, checkDocument(compiled.full, doc, options))
      }
      return coll.insertMany(docs, options)
    },

  replaceOne:
    ({ coll, name, compiled }) =>
    async (filter: Document, replacement: Document, options?: Document) => {
      enforceWrite(name, 'replaceOne', filterId(filter), checkDocument(compiled.full, replacement, options))
      return coll.replaceOne(filter, replacement, options)
    },

  updateOne:
    ({ coll, name, compiled }) =>
    async (filter: Document, update: Document, options?: Document) => {
      enforceWrite(name, 'updateOne', filterId(filter), checkUpdate(name, compiled.full, filter, update, options))
      return coll.updateOne(filter, update as Document, options)
    },

  updateMany:
    ({ coll, name, compiled }) =>
    async (filter: Document, update: Document, options?: Document) => {
      enforceWrite(name, 'updateMany', filterId(filter), checkUpdate(name, compiled.full, filter, update, options))
      return coll.updateMany(filter, update as Document, options)
    },

  bulkWrite: (ctx) => async (ops: Document[], options?: Document) => {
    for (const op of ops) enforceWrite(ctx.name, 'bulkWrite', undefined, checkBulkOp(ctx, op))
    return ctx.coll.bulkWrite(ops as never, options)
  },
}

for (const operation of READ_RESULT_OPS) {
  METHODS[operation] =
    ({ coll, name, compiled }) =>
    async (...args: Document[]) => {
      const options: Document | undefined = operation === 'findOneAndDelete' ? args[1] : args[2]
      if (operation === 'findOneAndUpdate') {
        enforceWrite(name, operation, filterId(args[0]), checkUpdate(name, compiled.full, args[0], args[1], options))
      } else if (operation === 'findOneAndReplace') {
        enforceWrite(name, operation, filterId(args[0]), checkDocument(compiled.full, args[1], options))
      }
      const result = (await (coll[operation as keyof Collection] as AnyFn).apply(coll, args)) as Document | null
      const doc = options?.includeResultMetadata ? result?.value : result
      checkRead(name, compiled, operation, doc, options)
      return result
    }
}

function passthrough(target: object, prop: string | symbol): unknown {
  const value = Reflect.get(target, prop, target)
  return typeof value === 'function' ? value.bind(target) : value
}

function wrapCollection<T extends Document>(coll: Collection<T>, name: string, compiled: Compiled): Collection<T> {
  const ctx: Ctx = { coll: coll as unknown as Collection<Document>, name, compiled }
  return new Proxy(coll, {
    get(target, prop) {
      if (typeof prop === 'string' && Object.hasOwn(METHODS, prop)) return METHODS[prop](ctx)
      return passthrough(target, prop)
    },
  })
}

/** The validating wrapper for one collection (raw collection when it has no schema). */
export function validatedCollection<T extends Document>(coll: Collection<T>): Collection<T> {
  const compiled = COMPILED.get(coll.collectionName)
  return compiled ? wrapCollection(coll, coll.collectionName, compiled) : coll
}

// ---------------------------------------------------------------------------
// Db wrapper
// ---------------------------------------------------------------------------

const wrappedDbs = new WeakSet<Db>()

/**
 * A Db whose `collection()` validates the collections that have a schema.
 * Everything else (client, admin, command, createCollection, sessions…) is the
 * underlying Db's own; idempotent.
 */
export function withSchemaValidation(db: Db): Db {
  if (wrappedDbs.has(db)) return db
  const collection = (name: string, options?: Document) => {
    const coll = db.collection(name, options)
    const compiled = COMPILED.get(name)
    return compiled ? wrapCollection(coll, name, compiled) : coll
  }
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'collection') return collection
      return passthrough(target, prop)
    },
  })
  wrappedDbs.add(proxy)
  return proxy
}
