/**
 * Unit tests — FeedbackService
 *
 * Covers:
 *   - ensureIndexes: creates expected indexes on feedback collections
 *   - upsertMessageFeedback: insert + update, comment trimming, broadcast event
 *   - getMessageFeedback: returns current feedback or null
 *   - logMessageAction: persists copy/report actions, broadcasts event
 *   - createConversationFeedback: persists conversation-level feedback
 *
 * Db is fully mocked in-memory — no real MongoDB.
 */

import { describe, expect, it, mock } from 'bun:test'
import { FeedbackService } from '../../src/services/feedback-service'

// ---------------------------------------------------------------------------
// In-memory collection mock
// ---------------------------------------------------------------------------

interface InMemoryCol<T extends Record<string, any>> {
  docs: T[]
  indexes: Array<{ keys: Record<string, number>; options?: Record<string, any> }>
  createIndex: ReturnType<typeof mock>
  findOne: ReturnType<typeof mock>
  findOneAndUpdate: ReturnType<typeof mock>
  insertOne: ReturnType<typeof mock>
}

function makeCol<T extends Record<string, any>>(initial: T[] = []): InMemoryCol<T> {
  const docs: T[] = initial.map((d) => ({ ...d }))
  const indexes: InMemoryCol<T>['indexes'] = []

  return {
    docs,
    indexes,
    createIndex: mock(async (keys: Record<string, number>, options?: Record<string, any>) => {
      indexes.push({ keys, options })
    }),
    findOne: mock(async (filter: any) => {
      return docs.find((d) => matches(d, filter)) ?? null
    }),
    findOneAndUpdate: mock(async (filter: any, update: any, opts?: any) => {
      const idx = docs.findIndex((d) => matches(d, filter))
      const $set = update.$set ?? {}
      if (idx >= 0) {
        docs[idx] = { ...docs[idx], ...$set }
        return opts?.returnDocument === 'after' ? docs[idx] : docs[idx]
      }
      if (opts?.upsert) {
        // Reproduce Mongo upsert semantics: seed the new doc from the filter's
        // equality fields + $setOnInsert + $set, then return the after-doc.
        const seed: Record<string, any> = {}
        for (const [k, v] of Object.entries(filter)) {
          if (v === null || typeof v !== 'object') seed[k] = v
        }
        const created = { ...seed, ...(update.$setOnInsert ?? {}), ...$set } as T
        docs.push(created)
        return opts?.returnDocument === 'after' ? created : null
      }
      return null
    }),
    insertOne: mock(async (doc: T) => {
      docs.push({ ...doc })
      return { insertedId: doc.feedbackId ?? doc.actionId ?? doc.conversationFeedbackId }
    }),
  }
}

function matches(doc: any, filter: any): boolean {
  return Object.entries(filter).every(([k, cond]) => {
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      return Object.entries(cond as any).every(([op, v]) => {
        if (op === '$eq') return doc[k] === v
        if (op === '$ne') return doc[k] !== v
        throw new Error(`op no soportado: ${op}`)
      })
    }
    return doc[k] === cond
  })
}

// ---------------------------------------------------------------------------
// Mock Db builder
// ---------------------------------------------------------------------------

function makeDb(collections: {
  message_feedback?: any[]
  message_actions?: any[]
  conversation_feedback?: any[]
} = {}) {
  const cols: Record<string, InMemoryCol<any>> = {
    message_feedback: makeCol(collections.message_feedback ?? []),
    message_actions: makeCol(collections.message_actions ?? []),
    conversation_feedback: makeCol(collections.conversation_feedback ?? []),
  }

  return {
    collection: mock((name: string) => cols[name]),
    _cols: cols,
  } as any
}

function makePubSub() {
  const broadcasts: any[] = []
  return {
    broadcasts,
    broadcastToTopic: mock((topic: string, payload: any) => {
      broadcasts.push({ topic, payload })
    }),
  }
}

// ---------------------------------------------------------------------------
// ensureIndexes
// ---------------------------------------------------------------------------

describe('FeedbackService.ensureIndexes', () => {
  it('creates unique indexes on message_feedback and conversation_feedback', async () => {
    const db = makeDb()
    const svc = new FeedbackService(db, null)
    await svc.ensureIndexes()

    const fbIndexes = db._cols.message_feedback.indexes
    expect(fbIndexes).toContainEqual({
      keys: { messageId: 1, userId: 1 },
      options: { unique: true, background: true },
    })
    expect(fbIndexes).toContainEqual({
      keys: { conversationId: 1, createdAt: -1 },
      options: { background: true },
    })
    expect(fbIndexes).toContainEqual({
      keys: { agentId: 1, createdAt: -1 },
      options: { background: true },
    })

    const actionIndexes = db._cols.message_actions.indexes
    expect(actionIndexes).toContainEqual({
      keys: { messageId: 1, createdAt: -1 },
      options: { background: true },
    })
    expect(actionIndexes).toContainEqual({
      keys: { conversationId: 1, createdAt: -1 },
      options: { background: true },
    })

    const convIndexes = db._cols.conversation_feedback.indexes
    expect(convIndexes).toContainEqual({
      keys: { conversationId: 1, userId: 1 },
      options: { unique: true, background: true },
    })
    expect(convIndexes).toContainEqual({
      keys: { workspaceId: 1, createdAt: -1 },
      options: { background: true },
    })
  })
})

// ---------------------------------------------------------------------------
// upsertMessageFeedback
// ---------------------------------------------------------------------------

describe('FeedbackService.upsertMessageFeedback', () => {
  it('inserts a new message feedback document', async () => {
    const db = makeDb()
    const pubSub = makePubSub()
    const svc = new FeedbackService(db, pubSub as any)

    const feedback = await svc.upsertMessageFeedback({
      messageId: 'msg_1',
      conversationId: 'ch_1',
      workspaceId: 'work_1',
      userId: 'user_1',
      agentId: 'agent_1',
      rating: 'up',
    })

    expect(feedback.messageId).toBe('msg_1')
    expect(feedback.userId).toBe('user_1')
    expect(feedback.rating).toBe('up')
    expect(feedback.feedbackId.startsWith('fb_')).toBe(true)
    expect(feedback.createdAt).toBeDefined()
    expect(db._cols.message_feedback.docs).toHaveLength(1)

    expect(pubSub.broadcasts).toHaveLength(1)
    expect(pubSub.broadcasts[0].topic).toBe('channel:ch_1')
    expect(pubSub.broadcasts[0].payload.type).toBe('conversation.message.feedback.created')
    expect(pubSub.broadcasts[0].payload.rating).toBe('up')
  })

  it('updates existing feedback for the same (messageId, userId)', async () => {
    const db = makeDb()
    const pubSub = makePubSub()
    const svc = new FeedbackService(db, pubSub as any)

    const first = await svc.upsertMessageFeedback({
      messageId: 'msg_1',
      conversationId: 'ch_1',
      workspaceId: 'work_1',
      userId: 'user_1',
      agentId: 'agent_1',
      rating: 'up',
    })

    const second = await svc.upsertMessageFeedback({
      messageId: 'msg_1',
      conversationId: 'ch_1',
      workspaceId: 'work_1',
      userId: 'user_1',
      agentId: 'agent_1',
      rating: 'down',
      reasons: ['inaccurate'],
      comment: 'Wrong answer',
    })

    expect(second.feedbackId).toBe(first.feedbackId)
    expect(second.rating).toBe('down')
    expect(second.reasons).toEqual(['inaccurate'])
    expect(second.comment).toBe('Wrong answer')
    expect(db._cols.message_feedback.docs).toHaveLength(1)

    expect(pubSub.broadcasts).toHaveLength(2)
  })

  it('uses a single atomic upsert (no find-then-insert race) for first-time feedback', async () => {
    const db = makeDb()
    const svc = new FeedbackService(db, null)

    await svc.upsertMessageFeedback({
      messageId: 'msg_1',
      conversationId: 'ch_1',
      workspaceId: 'work_1',
      userId: 'user_1',
      agentId: 'agent_1',
      rating: 'up',
    })

    const col = db._cols.message_feedback
    // Exactly one write op, and it must be the atomic upsert — never a
    // separate insertOne that could collide on the unique (messageId,userId) index.
    expect(col.findOneAndUpdate).toHaveBeenCalledTimes(1)
    expect(col.insertOne).toHaveBeenCalledTimes(0)

    const [filter, update, opts] = col.findOneAndUpdate.mock.calls[0]
    expect(filter).toEqual({ messageId: 'msg_1', userId: 'user_1' })
    expect(opts.upsert).toBe(true)
    expect(opts.returnDocument).toBe('after')
    expect(update.$set.rating).toBe('up')
    expect(update.$setOnInsert.feedbackId.startsWith('fb_')).toBe(true)
    expect(update.$setOnInsert.createdAt).toBeDefined()
    // Immutable creation fields must not be in $set (would clobber on every update).
    expect(update.$set.feedbackId).toBeUndefined()
    expect(update.$set.createdAt).toBeUndefined()
  })

  it('converges to one document when two first-time votes race for the same (messageId, userId)', async () => {
    const db = makeDb()
    const svc = new FeedbackService(db, null)

    const [a, b] = await Promise.all([
      svc.upsertMessageFeedback({
        messageId: 'msg_1',
        conversationId: 'ch_1',
        workspaceId: 'work_1',
        userId: 'user_1',
        agentId: 'agent_1',
        rating: 'up',
      }),
      svc.upsertMessageFeedback({
        messageId: 'msg_1',
        conversationId: 'ch_1',
        workspaceId: 'work_1',
        userId: 'user_1',
        agentId: 'agent_1',
        rating: 'down',
      }),
    ])

    // No duplicate-key blow-up, single row, same identity for both callers.
    expect(db._cols.message_feedback.docs).toHaveLength(1)
    expect(a.feedbackId).toBe(b.feedbackId)
  })

  it('trims and caps comments at 2000 characters', async () => {
    const db = makeDb()
    const svc = new FeedbackService(db, null)

    const longComment = 'x'.repeat(3000)
    const feedback = await svc.upsertMessageFeedback({
      messageId: 'msg_1',
      conversationId: 'ch_1',
      workspaceId: 'work_1',
      userId: 'user_1',
      agentId: 'agent_1',
      rating: 'down',
      comment: `  ${longComment}  `,
    })

    expect(feedback.comment).toHaveLength(2000)
    expect(feedback.comment.startsWith('x')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// getMessageFeedback
// ---------------------------------------------------------------------------

describe('FeedbackService.getMessageFeedback', () => {
  it('returns the existing feedback for a message/user', async () => {
    const db = makeDb()
    const svc = new FeedbackService(db, null)

    await svc.upsertMessageFeedback({
      messageId: 'msg_1',
      conversationId: 'ch_1',
      workspaceId: 'work_1',
      userId: 'user_1',
      agentId: 'agent_1',
      rating: 'up',
    })

    const found = await svc.getMessageFeedback('msg_1', 'user_1')
    expect(found?.rating).toBe('up')
  })

  it('returns null when no feedback exists', async () => {
    const db = makeDb()
    const svc = new FeedbackService(db, null)
    const found = await svc.getMessageFeedback('msg_missing', 'user_1')
    expect(found).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// logMessageAction
// ---------------------------------------------------------------------------

describe('FeedbackService.logMessageAction', () => {
  it('logs a copy action', async () => {
    const db = makeDb()
    const pubSub = makePubSub()
    const svc = new FeedbackService(db, pubSub as any)

    const action = await svc.logMessageAction({
      messageId: 'msg_1',
      conversationId: 'ch_1',
      workspaceId: 'work_1',
      userId: 'user_1',
      action: 'copy',
    })

    expect(action.action).toBe('copy')
    expect(action.actionId.startsWith('act_')).toBe(true)
    expect(db._cols.message_actions.docs).toHaveLength(1)

    expect(pubSub.broadcasts).toHaveLength(1)
    expect(pubSub.broadcasts[0].payload.type).toBe('conversation.message.action.executed')
    expect(pubSub.broadcasts[0].payload.action).toBe('copy')
  })

  it('logs a report action with context', async () => {
    const db = makeDb()
    const svc = new FeedbackService(db, null)

    const action = await svc.logMessageAction({
      messageId: 'msg_1',
      conversationId: 'ch_1',
      workspaceId: 'work_1',
      userId: 'user_1',
      action: 'report',
      context: { bugReportId: 'bug_123', attachmentUrl: 'https://example.com/shot.png' },
    })

    expect(action.action).toBe('report')
    expect(action.context).toEqual({
      bugReportId: 'bug_123',
      attachmentUrl: 'https://example.com/shot.png',
    })
  })
})

// ---------------------------------------------------------------------------
// createConversationFeedback
// ---------------------------------------------------------------------------

describe('FeedbackService.createConversationFeedback', () => {
  it('creates conversation feedback with a numeric rating', async () => {
    const db = makeDb()
    const svc = new FeedbackService(db, null)

    const feedback = await svc.createConversationFeedback({
      conversationId: 'ch_1',
      workspaceId: 'work_1',
      userId: 'user_1',
      rating: 5,
      solvedProblem: true,
      comment: 'Great help',
    })

    expect(feedback.conversationFeedbackId.startsWith('cfb_')).toBe(true)
    expect(feedback.rating).toBe(5)
    expect(feedback.solvedProblem).toBe(true)
    expect(feedback.comment).toBe('Great help')
    expect(db._cols.conversation_feedback.docs).toHaveLength(1)
  })

  it('trims and caps comments at 2000 characters', async () => {
    const db = makeDb()
    const svc = new FeedbackService(db, null)

    const longComment = 'x'.repeat(2500)
    const feedback = await svc.createConversationFeedback({
      conversationId: 'ch_1',
      workspaceId: 'work_1',
      userId: 'user_1',
      rating: 'down',
      comment: `  ${longComment}  `,
    })

    expect(feedback.comment).toHaveLength(2000)
  })
})
