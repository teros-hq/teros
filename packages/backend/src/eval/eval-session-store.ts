/**
 * In-memory session store for the behavioural eval runner (F4 · C3).
 *
 * `ConversationManager` needs a concrete `SessionStore`. `@teros/core`'s
 * `InMemorySessionStore` has the right in-memory logic but does NOT extend the
 * abstract `SessionStore` (its `getSession` returns `null`, the base declares
 * `undefined`, and it lacks the base's concrete compaction methods) — so it is
 * not assignable. This thin subclass extends `SessionStore` (inheriting the
 * concrete compaction methods) and DELEGATES every abstract op to a private
 * `InMemorySessionStore`, adapting the one incompatibility (`null → undefined`).
 *
 * Isolated per eval turn (fresh instance) so goldens never share state.
 */

import {
  InMemorySessionStore,
  type Message,
  type MessageWithParts,
  type Part,
  type Session,
  SessionStore,
} from "@teros/core"

export class EvalSessionStore extends SessionStore {
  private readonly inner = new InMemorySessionStore()

  async getSession(sessionId: string): Promise<Session | undefined> {
    return (await this.inner.getSession(sessionId)) ?? undefined
  }
  writeSession(session: Session): Promise<void> {
    return this.inner.writeSession(session)
  }
  deleteSession(sessionId: string): Promise<void> {
    return this.inner.deleteSession(sessionId)
  }
  listSessions(userId: string): Promise<Session[]> {
    return this.inner.listSessions(userId)
  }
  touchSession(sessionId: string): Promise<void> {
    return this.inner.touchSession(sessionId)
  }
  writeMessage(message: Message): Promise<void> {
    return this.inner.writeMessage(message)
  }
  getMessagesWithParts(sessionId: string): Promise<MessageWithParts[]> {
    return this.inner.getMessagesWithParts(sessionId)
  }
  updateUserMessageQueueState(
    messageId: string,
    state: "pending" | "running" | "done",
  ): Promise<void> {
    return this.inner.updateUserMessageQueueState(messageId, state)
  }
  listPendingQueueMessages(channelIds: string[]): Promise<MessageWithParts[]> {
    return this.inner.listPendingQueueMessages(channelIds)
  }
  writePart(part: Part): Promise<void> {
    return this.inner.writePart(part)
  }
  listParts(messageId: string): Promise<Part[]> {
    return this.inner.listParts(messageId)
  }
}
