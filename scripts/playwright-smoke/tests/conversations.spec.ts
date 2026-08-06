/**
 * Conversations domain. Two tests:
 *  - @llm: a real round-trip against Kimi (teros provider) — create channel, send a
 *    message, wait for `queue_state` done, assert an assistant message came back.
 *    Loose assertion (role + non-empty text), never exact text. 60s timeout.
 *  - lifecycle (no LLM): create → rename → close → reopen, asserted via the live client.
 */
import { expect, test } from "../fixtures"
import { clearEvents, evalTeros, getPrimaryIds, waitForEvent } from "../helpers/teros"

test.describe("conversations", () => {
  test("responde con Kimi real @llm", async ({ terosPage }) => {
    test.setTimeout(60_000)
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    expect(agentId, "agente con provider resuelto").toBeTruthy()

    const channelId = await evalTeros(
      terosPage,
      ({ aid, wid }) =>
        window.teros.channel.create({ agentId: aid, workspaceId: wid }).then((r) => r.channelId),
      { aid: agentId as string, wid: privateWorkspaceId as string },
    )
    expect(channelId, "channel.create devuelve channelId").toBeTruthy()

    // Subscribe to the channel topic — queue_state/message_chunk are broadcast to
    // channel subscribers (agent-loop broadcastToChannel). The real frontend subscribes
    // when opening the chat; without it the recorder never sees the turn's events.
    await evalTeros(
      terosPage,
      (cid) => window.teros.channel.subscribe(cid).then(() => null),
      channelId,
    )

    // Send + wake the agent. Record events BEFORE the send (race).
    await clearEvents(terosPage)
    await evalTeros(
      terosPage,
      (cid) =>
        window.teros.channel
          .sendMessage(
            cid,
            { type: "text", text: "Responde solo con la palabra PONG." },
            { wakeUpAgent: true },
          )
          .then(() => null),
      channelId,
    )

    const done = await waitForEvent(
      terosPage,
      { type: "queue_state", state: "done", channelId },
      30_000,
    )
    expect(done, "queue_state state=done en 30s (el agente terminó su turno)").toBeTruthy()

    const hasAssistantText = await evalTeros(
      terosPage,
      (cid) =>
        window.teros.channel
          .getMessages(cid)
          .then((r) =>
            (r.messages || []).some(
              (m) => m.role === "assistant" && (m.content?.text?.trim()?.length || 0) > 0,
            ),
          ),
      channelId,
    )
    expect(hasAssistantText, "hay un mensaje assistant con texto no vacío").toBe(true)

    // cleanup
    await evalTeros(terosPage, (cid) => window.teros.channel.close(cid).then(() => null), channelId)
  })

  test("lifecycle de canal: create → rename → close → reopen", async ({ terosPage }) => {
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    expect(agentId).toBeTruthy()

    const channelId = await evalTeros(
      terosPage,
      ({ aid, wid }) =>
        window.teros.channel.create({ agentId: aid, workspaceId: wid }).then((r) => r.channelId),
      { aid: agentId as string, wid: privateWorkspaceId as string },
    )
    expect(channelId).toBeTruthy()

    // rename — the backend stores the name in metadata.name; list/get return it raw
    // (no derived top-level `title`). Assert metadata.name via channel.list.
    const title = `Pw Conv ${Date.now()}`
    await evalTeros(
      terosPage,
      ({ cid, title }) => window.teros.channel.rename(cid, title).then(() => null),
      { cid: channelId, title },
    )
    const renamed = await evalTeros(
      terosPage,
      ({ cid, wid }) =>
        window.teros.channel
          .list(wid)
          .then((r) => r.channels.find((c) => c.channelId === cid)?.metadata?.name),
      { cid: channelId, wid: privateWorkspaceId as string },
    )
    expect(renamed, "el nombre del canal se actualizó (metadata.name en channel.list)").toBe(title)

    // close → reopen: assert the call resolves for the same channel with a status
    const closed = await evalTeros(
      terosPage,
      (cid) => window.teros.channel.close(cid).then((r) => r),
      channelId,
    )
    expect(closed.channelId, "close devuelve el mismo canal").toBe(channelId)
    expect(closed.status, "close devuelve un status").toBeTruthy()

    const reopened = await evalTeros(
      terosPage,
      (cid) => window.teros.channel.reopen(cid).then((r) => r),
      channelId,
    )
    expect(reopened.channelId, "reopen devuelve el mismo canal").toBe(channelId)
    expect(reopened.status, "reopen devuelve un status").toBeTruthy()

    // cleanup — leave it closed
    await evalTeros(terosPage, (cid) => window.teros.channel.close(cid).then(() => null), channelId)
  })
})
