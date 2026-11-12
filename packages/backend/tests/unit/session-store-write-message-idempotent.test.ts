/**
 * MongoSessionStore.writeMessage idempotency (2026-10-28): MessageProcessor
 * writes an assistant message TWICE — next() opens it (empty), finish()
 * persists the completed info — and the old blind insertOne left a second,
 * always-empty doc behind on every turn (300k+ junk docs, 47% of
 * session_messages, on RAW at diagnosis). writeMessage must upsert on
 * info.id so the finish() write updates the same doc instead of inserting.
 */

import { describe, expect, it } from 'bun:test'
import { MongoSessionStore } from '../../src/session/MongoSessionStore'

function makeDb() {
  const docs: any[] = []
  const find = (filter: any) => ({
    sort: () => ({ toArray: async () => docs.filter(d => match(d, filter)) }),
    toArray: async () => docs.filter(d => match(d, filter)),
  })
  // Dot-notation filter (info.id) support
  const getPath = (obj: any, p: string) =>
    p.split('.').reduce((o: any, k: string) => (o == null ? undefined : o[k]), obj)
  const match = (d: any, f: any) =>
    Object.entries(f).every(([k, v]) => getPath(d, k) === v)
  return {
    docs,
    collection: (_name: string) => ({
      findOne: async (f: any) => docs.find(d => match(d, f)) ?? null,
      find,
      insertOne: async (d: any) => { docs.push(d); return { acknowledged: true } },
      updateOne: async (f: any, u: any, o: any) => {
        const i = docs.findIndex(d => match(d, f))
        if (i >= 0) {
          // $setOnInsert only applies on INSERT (MongoDB semantics) — never on update
          const set = u.$set ?? {}
          docs[i] = { ...docs[i], ...set }
          return { acknowledged: true, matchedCount: 1, upsertedId: null }
        }
        if (o?.upsert) {
          docs.push({ ...u.$setOnInsert, ...u.$set })
          return { acknowledged: true, matchedCount: 0, upsertedId: 'x' }
        }
        return { acknowledged: true, matchedCount: 0, upsertedId: null }
      },
      deleteMany: async () => ({ deletedCount: 0 }),
      updateMany: async () => ({ modifiedCount: 0 }),
    }),
  }
}

const mkMsg = (id: string, extra: any = {}) => ({
  id,
  sessionID: 'ch_1',
  role: 'assistant',
  time: { created: 1 },
  ...extra,
} as any)

describe('MongoSessionStore.writeMessage — idempotent by info.id', () => {
  it('writing the same assistant message twice updates in place, never duplicates', async () => {
    const db = makeDb()
    const store = new MongoSessionStore(db as any)

    // next() opens the message
    await store.writeMessage(mkMsg('msg_1', { mode: 'build' }))
    // finish() persists the completed info — same id
    await store.writeMessage(mkMsg('msg_1', { mode: 'done', tokens: { input: 10 } }))

    expect(db.docs).toHaveLength(1)
    expect(db.docs[0].info.id).toBe('msg_1')
    expect(db.docs[0].info.mode).toBe('done')
    expect(db.docs[0].info.tokens.input).toBe(10)
    expect(db.docs[0].parts).toEqual([])
  })

  it('distinct messages still insert separately', async () => {
    const db = makeDb()
    const store = new MongoSessionStore(db as any)

    await store.writeMessage(mkMsg('msg_a'))
    await store.writeMessage(mkMsg('msg_b'))

    expect(db.docs).toHaveLength(2)
  })

  it('a later writeMessage never clobbers streamed parts', async () => {
    const db = makeDb()
    const store = new MongoSessionStore(db as any)

    await store.writeMessage(mkMsg('msg_1'))
    // Parts stream in via writePart (simulated: parts present on the doc)
    db.docs[0].parts = [{ id: 'part_1', type: 'text', text: 'hi' }]
    // finish() re-writes the message info — parts must survive
    await store.writeMessage(mkMsg('msg_1', { mode: 'done' }))

    expect(db.docs).toHaveLength(1)
    expect(db.docs[0].parts).toHaveLength(1)
    expect(db.docs[0].parts[0].id).toBe('part_1')
  })
})
