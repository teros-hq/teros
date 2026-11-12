/**
 * channel_list_status always says where the channel belongs.
 *
 * The event goes to every session of the channel's owner, whatever workspace
 * each one shows, and also fires for headless runs and sub-conversations. A
 * partial "updated" (auto-name, permission pending) used to carry one field
 * and nothing else, so a sidebar listed the channel as a nameless "Chat" with
 * a generic avatar. The list scope lets each client decide (CHAN-REQ-11).
 */
import { describe, expect, it } from "bun:test"
import { MessageHandler } from "../../src/handlers/message-handler"

function broadcastFor(channel: Record<string, unknown>) {
  const sent: any[] = []
  const ws = { OPEN: 1, readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) }
  // Bypass the constructor: the broadcast only needs these two collaborators.
  const handler: any = Object.create(MessageHandler.prototype)
  handler.channelManager = { getChannel: async () => channel }
  handler.sessionManager = { getUserSessions: () => [{ ws }] }
  return { handler, sent }
}

describe("MessageHandler.broadcastChannelListStatus", () => {
  it("[CHAN-AC-8] a partial update carries workspaceId, headless and originChannelId", async () => {
    const { handler, sent } = broadcastFor({
      channelId: "ch_1",
      userId: "usr_1",
      workspaceId: "ws_other",
      headless: true,
      originChannelId: "ch_parent",
    })

    await handler.broadcastChannelListStatus("ch_1", "updated", { externalActionRequested: true })

    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe("channel_list_status")
    expect(sent[0].channel).toEqual({
      channelId: "ch_1",
      externalActionRequested: true,
      workspaceId: "ws_other",
      headless: true,
      originChannelId: "ch_parent",
    })
  })

  it("[CHAN-AC-8] a plain top-level channel is explicit about it", async () => {
    const { handler, sent } = broadcastFor({ channelId: "ch_2", userId: "usr_1", workspaceId: "ws_1" })

    await handler.broadcastChannelListStatus("ch_2", "updated", { title: "Trip plan" })

    expect(sent[0].channel).toEqual({
      channelId: "ch_2",
      title: "Trip plan",
      workspaceId: "ws_1",
      headless: false,
      originChannelId: null,
    })
  })
})
