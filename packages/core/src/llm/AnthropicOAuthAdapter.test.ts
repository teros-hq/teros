/**
 * AnthropicOAuthAdapter.convertMessages — orphan tool_use defense (TER-452 #163).
 *
 * Bug: the OAuth adapter (Claude Max) silently DROPPED tool_use parts whose status
 * wasn't completed/error (i.e. running / pending_approval). Anthropic requires every
 * `tool_use` to be paired with its `tool_result`; a silently-dropped tool_use leaves
 * the model's history inconsistent → corrupted conversation.
 *
 * Fix (#163): fail LOUD — throw an INV-1 violation rather than skip, so an
 * un-remediated orphan surfaces instead of silently corrupting history. Orphans are
 * meant to be remediated upstream (synthesizeOrphans / assertInvariantINV1, covered
 * by synthesizeOrphans.test.ts); this adapter is the last line of defense — same
 * posture as AnthropicLLMAdapter.
 *
 * `convertMessages` is private and pure for tool-only messages (the image/document
 * pipelines are skipped when no file parts are present), so we exercise it directly
 * via a cast — no network, no OAuth token needed beyond constructing the adapter.
 */
import { describe, expect, it } from 'bun:test'
import { AnthropicOAuthAdapter } from './AnthropicOAuthAdapter'
import type { MessageWithParts, ToolState } from '../session/types'

function assistantToolMsg(state: ToolState): MessageWithParts {
  return {
    info: { role: 'assistant' } as MessageWithParts['info'],
    parts: [{ type: 'tool', tool: 'is-valid', callID: 'call_1', state }],
  } as MessageWithParts
}

function convert(msgs: MessageWithParts[]): Promise<unknown[]> {
  const adapter = new AnthropicOAuthAdapter({ model: 'claude-sonnet-4-6', accessToken: 'fake-oauth-token' })
  // biome-ignore lint/suspicious/noExplicitAny: convertMessages is private — tested directly
  return (adapter as any).convertMessages(msgs, undefined)
}

describe('AnthropicOAuthAdapter.convertMessages — orphan tool_use (TER-452 #163)', () => {
  it('tool COMPLETED → tool_use + tool_result pareados, NO se descarta (payload exacto)', async () => {
    const out = (await convert([
      assistantToolMsg({
        status: 'completed',
        input: { datetime: '2026-01-01' },
        output: 'true',
        title: 't',
        metadata: {},
        time: { start: 1, end: 2 },
      } as ToolState),
    ])) as Array<{ role: string; content: unknown }>

    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'is-valid', input: { datetime: '2026-01-01' } }],
    })
    expect(out[1]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'true', is_error: false }],
    })
  })

  it('tool ERROR → tool_result is_error:true (preservado, no descartado)', async () => {
    const out = (await convert([
      assistantToolMsg({
        status: 'error',
        input: { datetime: 'bad' },
        error: 'invalid datetime',
        metadata: {},
        time: { start: 1, end: 2 },
      } as ToolState),
    ])) as Array<{ role: string; content: unknown }>

    expect(out[1]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'invalid datetime', is_error: true }],
    })
  })

  it('tool RUNNING huérfano → THROW INV-1, NO skip silencioso (el fix de #163)', async () => {
    await expect(
      convert([assistantToolMsg({ status: 'running', input: {}, time: { start: 1 } } as ToolState)]),
    ).rejects.toThrow(/INV-1 violation reached AnthropicOAuthAdapter/)
  })

  it('tool PENDING_APPROVAL huérfano → THROW INV-1 con el status en el mensaje', async () => {
    await expect(
      convert([
        assistantToolMsg({
          status: 'pending_approval',
          input: {},
          time: { start: 1 },
          permissionRequest: { requestId: 'r_1', appId: 'app_1', toolName: 'is-valid', createdAt: 1 },
        } as ToolState),
      ]),
    ).rejects.toThrow(/has status=pending_approval/)
  })
})
