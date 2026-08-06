/**
 * Shared test doubles + async helpers for the domain-API contract tests.
 */
import { ConnectionState } from '../transport/types'
import type { EventHandler, RequestOptions, StateChangeHandler, Transport } from '../transport/types'

export interface Call {
  action: string
  payload?: Record<string, unknown>
  options?: RequestOptions
}

/**
 * Captures every request() the API issues and returns a configurable response.
 * Faithful to the boundary: request() resolves a real promise (async), and the
 * domain APIs only ever touch request()/subscribe()/unsubscribe().
 */
export class CapturingTransport implements Transport {
  calls: Call[] = []
  response: unknown = {}
  rejectWith: Error | null = null

  request<T = unknown>(action: string, payload?: Record<string, unknown>, options?: RequestOptions): Promise<T> {
    this.calls.push({ action, payload, options })
    if (this.rejectWith) return Promise.reject(this.rejectWith)
    return Promise.resolve(this.response as T)
  }
  subscribe<T>(_e: string, _h: EventHandler<T>): void {}
  unsubscribe<T>(_e: string, _h: EventHandler<T>): void {}
  getState(): ConnectionState {
    return ConnectionState.CONNECTED
  }
  onStateChange(_h: StateChangeHandler): void {}
  offStateChange(_h: StateChangeHandler): void {}

  last(): Call {
    if (this.calls.length === 0) throw new Error('no request was made')
    return this.calls[this.calls.length - 1]!
  }
}

/** Drain the microtask queue (promise continuations) under fake timers. */
export const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

/** Track a promise's settlement without consuming it. */
export function track(p: Promise<unknown>) {
  const s = { v: 'pending' as 'pending' | 'resolved' | 'rejected' }
  p.then(
    () => {
      s.v = 'resolved'
    },
    () => {
      s.v = 'rejected'
    },
  )
  return s
}
