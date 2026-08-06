import { resolve } from 'node:path';

const filesReadInSession = new Set<string>();

export function markRead(filePath: string): void {
  filesReadInSession.add(resolve(filePath));
}

export function hasRead(filePath: string): boolean {
  return filesReadInSession.has(resolve(filePath));
}

export function clearSession(): void {
  filesReadInSession.clear();
}

export function sessionSize(): number {
  return filesReadInSession.size;
}
