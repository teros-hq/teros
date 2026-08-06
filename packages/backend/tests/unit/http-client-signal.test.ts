/**
 * HttpClient signal cabling tests (Phase 2.0 — TER-348).
 *
 * Regression tests for the latent bug where `RequestOptions.signal` was
 * declared but ignored in `request()` and `fetchRaw()`. After Phase 2.0,
 * `options.signal` is honored end-to-end via the `linkAbort` helper.
 *
 * Strategy: mock `globalThis.fetch` to control timing precisely without
 * a real HTTP server.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { HttpClient, HttpClientError, linkAbort } from '../../src/lib/HttpClient'

describe('linkAbort helper', () => {
  it('does nothing when parent signal is undefined', () => {
    const child = new AbortController()
    linkAbort(child, undefined)
    expect(child.signal.aborted).toBe(false)
  })

  it('aborts child immediately when parent is already aborted', () => {
    const parent = new AbortController()
    parent.abort('test-reason')
    const child = new AbortController()
    linkAbort(child, parent.signal)
    expect(child.signal.aborted).toBe(true)
    expect(child.signal.reason).toBe('test-reason')
  })

  it('forwards future aborts from parent to child', () => {
    const parent = new AbortController()
    const child = new AbortController()
    linkAbort(child, parent.signal)
    expect(child.signal.aborted).toBe(false)
    parent.abort('later-reason')
    expect(child.signal.aborted).toBe(true)
    expect(child.signal.reason).toBe('later-reason')
  })

  it('does not propagate child abort back to parent (one-way only)', () => {
    const parent = new AbortController()
    const child = new AbortController()
    linkAbort(child, parent.signal)
    child.abort('child-only')
    expect(parent.signal.aborted).toBe(false)
  })
})

describe('HttpClient with options.signal', () => {
  const realFetch = globalThis.fetch
  let fetchCalls: Array<{ url: string; init: RequestInit }> = []

  beforeEach(() => {
    fetchCalls = []
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('passes options.signal through to fetch', async () => {
    globalThis.fetch = async (url: any, init: any) => {
      fetchCalls.push({ url, init })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const client = new HttpClient({ baseUrl: 'https://example.test' })
    const ctl = new AbortController()
    await client.get('/path', { signal: ctl.signal })

    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].init.signal).toBeInstanceOf(AbortSignal)
    // The signal passed to fetch is the internal combined controller's signal,
    // not the caller's signal directly. But it MUST react to caller aborts.
    expect(fetchCalls[0].init.signal!.aborted).toBe(false)
  })

  it('short-circuits with 499 ABORTED when caller signal is pre-aborted', async () => {
    globalThis.fetch = async () => {
      throw new Error('fetch should not be called when signal is pre-aborted')
    }

    const client = new HttpClient({ baseUrl: 'https://example.test' })
    const ctl = new AbortController()
    ctl.abort('user-cancelled')

    let caught: HttpClientError | null = null
    try {
      await client.get('/path', { signal: ctl.signal })
    } catch (e) {
      caught = e as HttpClientError
    }

    expect(caught).toBeInstanceOf(HttpClientError)
    expect(caught!.statusCode).toBe(499)
    expect(caught!.code).toBe('ABORTED')
    expect(caught!.message).toContain('aborted by caller before sending')
  })

  it('aborts mid-flight fetch and returns 499 ABORTED (no retry on caller abort)', async () => {
    let fetchAttempts = 0
    globalThis.fetch = async (_url: any, init: any) => {
      fetchAttempts += 1
      // Simulate a slow fetch that respects AbortSignal
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal
        signal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    }

    const client = new HttpClient({
      baseUrl: 'https://example.test',
      maxRetries: 3,  // even with retries, caller-abort should NOT retry
    })
    const ctl = new AbortController()
    const promise = client.get('/path', { signal: ctl.signal })
    // Abort after a microtask so fetch starts first
    setTimeout(() => ctl.abort('user-clicked-stop'), 10)

    let caught: HttpClientError | null = null
    try {
      await promise
    } catch (e) {
      caught = e as HttpClientError
    }

    expect(caught).toBeInstanceOf(HttpClientError)
    expect(caught!.statusCode).toBe(499)
    expect(caught!.code).toBe('ABORTED')
    // Caller-abort is final — NO retry attempts after the first
    expect(fetchAttempts).toBe(1)
  })

  it('preserves timeout-only abort behavior (504 TIMEOUT with retries)', async () => {
    let fetchAttempts = 0
    globalThis.fetch = async (_url: any, init: any) => {
      fetchAttempts += 1
      // Slow fetch that aborts on its own signal (the internal timeout)
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal
        signal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    }

    const client = new HttpClient({
      baseUrl: 'https://example.test',
      timeout: 50,
      maxRetries: 2,
    })

    let caught: HttpClientError | null = null
    try {
      await client.get('/path')  // No caller signal
    } catch (e) {
      caught = e as HttpClientError
    }

    expect(caught).toBeInstanceOf(HttpClientError)
    expect(caught!.statusCode).toBe(504)
    expect(caught!.code).toBe('TIMEOUT')
    // Timeout retries are honored: 1 initial + 2 retries = 3 attempts
    expect(fetchAttempts).toBe(3)
  })

  it('fetchRaw also respects options.signal', async () => {
    let fetchAttempts = 0
    globalThis.fetch = async (_url: any, init: any) => {
      fetchAttempts += 1
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal
        signal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    }

    const client = new HttpClient({ baseUrl: 'https://example.test' })
    const ctl = new AbortController()
    const promise = client.fetchRaw('POST', '/raw', undefined, { signal: ctl.signal })
    setTimeout(() => ctl.abort(), 10)

    let caught: HttpClientError | null = null
    try {
      await promise
    } catch (e) {
      caught = e as HttpClientError
    }

    expect(caught).toBeInstanceOf(HttpClientError)
    expect(caught!.statusCode).toBe(499)
    expect(fetchAttempts).toBe(1)
  })
})
