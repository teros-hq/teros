/**
 * SimpleEventBus — Lightweight in-process event bus.
 *
 * Used by TerosClient to forward transport events to subscribers
 * and maintain backward-compatible `.on()` / `.off()` / `.emit()` API.
 */

export interface EventBus {
  emit<T>(event: string, data: T): void
  on<T>(event: string, handler: (data: T) => void): void
  off<T>(event: string, handler: (data: T) => void): void
  removeAllListeners(event?: string): void
}

export class SimpleEventBus implements EventBus {
  private handlers: Record<string, ((...args: unknown[]) => void)[]> = {}

  on<T>(event: string, handler: (data: T) => void): void {
    if (!this.handlers[event]) this.handlers[event] = []
    this.handlers[event].push(handler as (...args: unknown[]) => void)
  }

  off<T>(event: string, handler: (data: T) => void): void {
    if (!this.handlers[event]) return
    this.handlers[event] = this.handlers[event].filter((h) => h !== handler)
  }

  emit<T>(event: string, data: T): void {
    if (!this.handlers[event]) return
    for (const h of this.handlers[event]) {
      try { h(data) } catch (err) { console.error(`SimpleEventBus: handler error for "${event}"`, err) }
    }
  }

  removeAllListeners(event?: string): void {
    if (event) {
      delete this.handlers[event]
    } else {
      this.handlers = {}
    }
  }
}
