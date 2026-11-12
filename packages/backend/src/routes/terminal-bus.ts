/**
 * Terminal SSE Bus — Per-session message ring buffer + SSE client registry.
 *
 * Mirrors even-terminal's routes/events.js so the Even phone app's
 * replay/heartbeat expectations are met exactly.
 *
 * Each "session" in the Even Terminal protocol maps to a Teros channel.
 * Events are translated from Teros's broadcastToChannel format to the
 * Even Terminal normalized event vocabulary.
 */

const MAX_MESSAGES_PER_SESSION = 500;

interface BufferedMessage {
  id: number;
  msg: any;
}

interface SessionState {
  messages: BufferedMessage[];
  clients: Set<import('http').ServerResponse>;
  nextId: number;
}

const sessions = new Map<string, SessionState>();

function getBuf(sessionId: string): SessionState {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { messages: [], clients: new Set(), nextId: 1 };
    sessions.set(sessionId, s);
  }
  return s;
}

/** Push a message into the ring buffer and return its sequential id. */
export function pushMessage(sessionId: string, msg: any): number {
  const s = getBuf(sessionId);
  const id = s.nextId++;
  s.messages.push({ id, msg });
  if (s.messages.length > MAX_MESSAGES_PER_SESSION) s.messages.shift();
  return id;
}

/** Get all buffered messages after a given id (for replay on reconnect). */
export function getMessages(sessionId: string, after: number): any[] {
  const s = sessions.get(sessionId);
  if (!s) return [];
  return s.messages.filter((m) => m.id > after).map((m) => ({ id: m.id, ...m.msg }));
}

/** Broadcast a message to all SSE clients subscribed to a session. */
export function broadcast(sessionId: string, msg: any, id: number): void {
  const s = sessions.get(sessionId);
  if (!s || s.clients.size === 0) return;
  const data = JSON.stringify(msg);
  for (const res of [...s.clients]) {
    try {
      res.write(`id: ${id}\ndata: ${data}\n\n`);
    } catch {
      s.clients.delete(res);
    }
  }
}

/**
 * The emit() the provider is constructed with: buffer + broadcast.
 * This is called by the event translator when a Teros channel event
 * is converted to an Even Terminal event.
 */
export function emit(sessionId: string, msg: any): void {
  if (!sessionId) return;
  const id = pushMessage(sessionId, msg);
  broadcast(sessionId, msg, id);
}

/** Register an SSE client for a session. Returns a cleanup function. */
export function addClient(
  sessionId: string,
  res: import('http').ServerResponse,
  needReplay: boolean,
): () => void {
  const s = getBuf(sessionId);
  if (needReplay) {
    for (const entry of s.messages) {
      res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.msg)}\n\n`);
    }
  }
  s.clients.add(res);
  return () => s.clients.delete(res);
}

/** Get the number of buffered messages for a session. */
export function bufferedMessageCount(sessionId: string): number {
  return sessions.get(sessionId)?.messages.length ?? 0;
}

/** Clean up all state for a session (called when a session is destroyed). */
export function clearSession(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (s) {
    for (const res of s.clients) {
      try { res.end(); } catch { /* already closed */ }
    }
    sessions.delete(sessionId);
  }
}
