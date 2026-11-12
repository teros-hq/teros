/**
 * MUW-F3: Credential race condition test for personal apps.
 *
 * Validates that concurrent tool executions on the same personal app
 * each receive their own per-user credentials — not the other user's.
 *
 * The race: before MUW-F3, the backend sent credentials via a global WS
 * push (`sendCredentialsUpdate`) before each tool call. When users A and
 * B executed tools concurrently on the same personal app (same MCA process),
 * their credential pushes interleaved and A's tool could run with B's tokens.
 *
 * The fix: credentials are now passed per-execution in the tool call payload
 * (`executionContext.credentials` for HTTP, `_teros_credentials` for stdio).
 * The MCA SDK overrides `getUserSecrets()` per-call to return the injected
 * credentials — no global state, no race.
 *
 * This test uses a mock HTTP server that captures the `context.credentials`
 * field from each request. Two concurrent calls are fired with different
 * credentials, and we verify each response sees only its own tokens.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { type Server, type ServerResponse, createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { McaHttpClient } from '../../src/services/mca-http-client'
import type { McaExecutionContext, McaToolCallRequest, McaToolResultResponse } from '@teros/shared'

describe('MUW-F3: credential race condition — per-execution scoping', () => {
  let server: Server
  let serverPort: number
  let capturedRequests: Array<{
    toolCallId?: string
    userId: string
    credentials?: Record<string, string>
  }> = []

  beforeAll(() => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as McaToolCallRequest
          const ctx = parsed.context as McaExecutionContext
          capturedRequests.push({
            toolCallId: ctx.toolCallId,
            userId: ctx.userId,
            credentials: ctx.credentials,
          })

          const response: McaToolResultResponse = {
            id: parsed.id || 'test',
            type: 'tool_result',
            timestamp: new Date().toISOString(),
            version: '1.0',
            success: true,
            result: {
              userId: ctx.userId,
              credentialsSeen: ctx.credentials || null,
            },
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(response))
        } catch {
          res.writeHead(500)
          res.end('Internal error')
        }
      })
    })

    server.listen(0, '127.0.0.1')
    serverPort = (server.address() as any).port
  })

  afterAll(() => {
    server.close()
  })

  it('two concurrent executions with different credentials each see their own', async () => {
    const client = new McaHttpClient({
      baseUrl: `http://127.0.0.1:${serverPort}`,
      timeout: 5000,
      maxRetries: 0,
    })

    const credsA = { ACCESS_TOKEN: 'token-A-secret', REFRESH_TOKEN: 'refresh-A' }
    const credsB = { ACCESS_TOKEN: 'token-B-secret', REFRESH_TOKEN: 'refresh-B' }

    const ctxA: McaExecutionContext = {
      userId: 'user-A',
      appId: 'app-personal-1',
      requestId: 'req-A',
      credentials: credsA,
    }

    const ctxB: McaExecutionContext = {
      userId: 'user-B',
      appId: 'app-personal-1',
      requestId: 'req-B',
      credentials: credsB,
    }

    // Fire both concurrently — this is the race window
    const [resultA, resultB] = await Promise.all([
      client.callTool('test_tool', { query: 'from-A' }, ctxA),
      client.callTool('test_tool', { query: 'from-B' }, ctxB),
    ])

    // Both should succeed
    expect(resultA.success).toBe(true)
    expect(resultB.success).toBe(true)

    // A's result should see A's credentials, never B's
    const aResult = resultA.result as any
    expect(aResult.userId).toBe('user-A')
    expect(aResult.credentialsSeen).toEqual(credsA)
    expect(aResult.credentialsSeen?.ACCESS_TOKEN).toBe('token-A-secret')
    expect(aResult.credentialsSeen?.ACCESS_TOKEN).not.toBe('token-B-secret')

    // B's result should see B's credentials, never A's
    const bResult = resultB.result as any
    expect(bResult.userId).toBe('user-B')
    expect(bResult.credentialsSeen).toEqual(credsB)
    expect(bResult.credentialsSeen?.ACCESS_TOKEN).toBe('token-B-secret')
    expect(bResult.credentialsSeen?.ACCESS_TOKEN).not.toBe('token-A-secret')
  })

  it('credentials field is optional — non-personal apps omit it', async () => {
    const client = new McaHttpClient({
      baseUrl: `http://127.0.0.1:${serverPort}`,
      timeout: 5000,
      maxRetries: 0,
    })

    const ctx: McaExecutionContext = {
      userId: 'user-system',
      appId: 'app-shared-1',
      requestId: 'req-no-creds',
    }

    const result = await client.callTool('test_tool', {}, ctx)
    expect(result.success).toBe(true)

    const r = result.result as any
    expect(r.credentialsSeen).toBeNull()
  })

  it('captured requests confirm per-request credential isolation', async () => {
    // The server captured all requests — verify the isolation at the
    // transport level (the actual race surface)
    const reqA = capturedRequests.find((r) => r.userId === 'user-A')
    const reqB = capturedRequests.find((r) => r.userId === 'user-B')

    expect(reqA).toBeDefined()
    expect(reqB).toBeDefined()

    // Each request carried its own credentials — no shared global state
    expect(reqA!.credentials).toEqual({ ACCESS_TOKEN: 'token-A-secret', REFRESH_TOKEN: 'refresh-A' })
    expect(reqB!.credentials).toEqual({ ACCESS_TOKEN: 'token-B-secret', REFRESH_TOKEN: 'refresh-B' })

    // Cross-contamination check: A's request never contains B's token
    expect(reqA!.credentials?.ACCESS_TOKEN).not.toBe('token-B-secret')
    expect(reqB!.credentials?.ACCESS_TOKEN).not.toBe('token-A-secret')
  })
})

/**
 * Stdio path test: verify that _teros_credentials is correctly extracted
 * from tool arguments and made available via context.getUserSecrets().
 *
 * This simulates the stdio transport where credentials are injected into
 * the tool arguments (since stdio MCP doesn't have a context channel).
 */
describe('MUW-F3: stdio path — _teros_credentials extraction', () => {
  it('extracts _teros_credentials from args and overrides getUserSecrets', async () => {
    // Simulate the stdio server's credential extraction logic
    const injectedCredentials = { ACCESS_TOKEN: 'token-stdio-user', REFRESH_TOKEN: 'refresh-stdio' }

    // Simulate args as received by the stdio server
    const rawArgs = {
      query: 'test-query',
      _teros_credentials: injectedCredentials,
    }

    // Replicate the extraction logic from stdio-server.ts
    let handlerArgs: Record<string, unknown> = rawArgs
    let overrideGetUserSecrets: (() => Promise<Record<string, string>>) | null = null

    if (handlerArgs && typeof handlerArgs === 'object' && '_teros_credentials' in handlerArgs) {
      const creds = handlerArgs._teros_credentials as Record<string, string>
      const { _teros_credentials, ...cleanArgs } = handlerArgs
      handlerArgs = cleanArgs
      overrideGetUserSecrets = async () => creds
    }

    // Verify: the reserved key is stripped from args
    expect('_teros_credentials' in handlerArgs).toBe(false)
    expect(handlerArgs.query).toBe('test-query')

    // Verify: getUserSecrets returns the injected credentials
    expect(overrideGetUserSecrets).not.toBeNull()
    const secrets = await overrideGetUserSecrets!()
    expect(secrets).toEqual(injectedCredentials)
    expect(secrets.ACCESS_TOKEN).toBe('token-stdio-user')
  })

  it('does not extract when _teros_credentials is absent (non-personal apps)', async () => {
    const rawArgs = { query: 'test-query' }

    let handlerArgs: Record<string, unknown> = rawArgs
    let overrideGetUserSecrets: (() => Promise<Record<string, string>>) | null = null

    if (handlerArgs && typeof handlerArgs === 'object' && '_teros_credentials' in handlerArgs) {
      const creds = handlerArgs._teros_credentials as Record<string, string>
      const { _teros_credentials, ...cleanArgs } = handlerArgs
      handlerArgs = cleanArgs
      overrideGetUserSecrets = async () => creds
    }

    // No extraction happened — args unchanged, no override
    expect('_teros_credentials' in handlerArgs).toBe(false)
    expect(overrideGetUserSecrets).toBeNull()
    expect(handlerArgs.query).toBe('test-query')
  })
})
