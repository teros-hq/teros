const filesReadInSession = new Set<string>();

export function markRead(filePath: string): void {
  filesReadInSession.add(filePath);
}

export function hasRead(filePath: string): boolean {
  return filesReadInSession.has(filePath);
}

export function clearSession(): void {
  filesReadInSession.clear();
}

export function sessionSize(): number {
  return filesReadInSession.size;
}
