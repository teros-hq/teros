/**
 * McaHttpClient signal propagation tests (Phase 2.0 — TER-348).
 *
 * Validates that `ToolCallOptions.signal` propagates end-to-end:
 *   McaHttpClient.callTool({signal}) → HttpClient → fetch → server.
 *
 * Uses a real Node HTTP server (no mocks) so we exercise the actual
 * `req.on('close')` flow that the McaHttpServer relies on in production.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { McaHttpClient, McaHttpError } from '../../src/services/mca-http-client'

describe('McaHttpClient signal propagation', () => {
  let server: Server
  let serverPort: number
  let serverReqs: Array<{ closed: boolean; closedAt?: number }> = []
  // Capture the real native fetch once — other test files (notably
  // `ImagePipeline.test.ts`) replace `globalThis.fetch` with vi.fn() at
  // module load time without restoring, and that leaks into bun's shared
  // process. We force the real fetch back before every test in this file.
  let nativeFetch: typeof fetch

  beforeAll(() => {
    // Bun's built-in fetch is always callable as a fallback; `Bun.fetch`
    // is identical to the global at startup. Read it via a property
    // that won't be hijacked by vi mocks.
    nativeFetch = (typeof Bun !== 'undefined' && (Bun as any).fetch) || fetch
  })

  beforeEach(async () => {
    globalThis.fetch = nativeFetch
    serverReqs = []
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const entry = { closed: false, closedAt: undefined as number | undefined }
      serverReqs.push(entry)
      const startedAt = Date.now()
      req.on('close', () => {
        if (!res.writableEnded) {
          entry.closed = true
          entry.closedAt = Date.now() - startedAt
        }
      })
      // Slow tool — never responds within test window. Lets caller abort.
      // Read body to satisfy POST contract then hang.
      req.on('data', () => {})
      req.on('end', () => {
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
          }
        }, 5000)
      })
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') serverPort = addr.port
        resolve()
      })
    })
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('propagates abort signal to fetch and server detects req.on(close)', async () => {
    const client = new McaHttpClient({
      baseUrl: `http://127.0.0.1:${serverPort}`,
      timeout: 30_000,
      maxRetries: 0,
    })

    const ctl = new AbortController()
    const promise = client.callTool(
      'slow-tool',
      { input: 'value' },
      {
        userId: 'user_test',
        appId: 'app_test',
        mcaId: 'mca.test',
        requestId: 'req_test',
      },
      { signal: ctl.signal },
    )

    // Abort after ~100ms so the request reaches the server first
    setTimeout(() => ctl.abort('user-stop'), 100)

    let caught: McaHttpError | null = null
    try {
      await promise
    } catch (e) {
      caught = e as McaHttpError
    }

    expect(caught).toBeInstanceOf(McaHttpError)
    expect(caught!.statusCode).toBe(499)
    expect(caught!.code).toBe('ABORTED')

    // Server should have detected the close after ~100ms
    // Allow some time for the close event to propagate
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(serverReqs).toHaveLength(1)
    expect(serverReqs[0].closed).toBe(true)
    // Close should have fired within reasonable window (under 1s)
    expect(serverReqs[0].closedAt!).toBeLessThan(1000)
  })

  it('does not abort the server when caller does not provide signal', async () => {
    const client = new McaHttpClient({
      baseUrl: `http://127.0.0.1:${serverPort}`,
      timeout: 300,  // short timeout so test doesn't hang on the 5s server delay
      maxRetries: 0,
    })

    let caught: McaHttpError | null = null
    try {
      await client.callTool(
        'slow-tool',
        {},
        { userId: 'u', appId: 'a', mcaId: 'm', requestId: 'r' },
      )
    } catch (e) {
      caught = e as McaHttpError
    }

    // Timeout-only path: 504 TIMEOUT (not 499 ABORTED) because there's no caller signal
    expect(caught).toBeInstanceOf(McaHttpError)
    expect(caught!.statusCode).toBe(504)
    expect(caught!.code).toBe('TIMEOUT')
  })
})
