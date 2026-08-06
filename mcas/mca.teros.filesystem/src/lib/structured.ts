export interface StructuredToolResult<T = unknown> {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: T;
  nextCursor?: string;
}

export function wrap<T>(data: T, nextCursor?: string): StructuredToolResult<T> {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    ...(nextCursor !== undefined && { nextCursor }),
  };
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
    const offset = Number(decoded.o);
    return Number.isFinite(offset) && offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
}

export function paginate<T>(
  items: T[],
  offset: number,
  limit: number,
): { page: T[]; nextCursor?: string } {
  const page = items.slice(offset, offset + limit);
  const hasMore = offset + limit < items.length;
  return hasMore ? { page, nextCursor: encodeCursor(offset + limit) } : { page };
}
