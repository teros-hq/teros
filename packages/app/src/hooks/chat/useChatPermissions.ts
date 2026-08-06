/**
 * useChatPermissions
 *
 * Manages tool permission requests:
 * - Listens for tool_permission_request events
 * - Tracks pending permissions
 * - Provides grant/deny callbacks
 * - Builds PermissionContextValue
 */

import { useCallback, useEffect, useMemo, useRef } from "react"
import { getTerosClient } from "../../services/terosClientSingleton"
import { track } from "../../lib/analytics"
import { useChatStore } from "../../store/chatStore"
import type { Message } from "../../store/chatStore"
import { extractPendingFromMessages } from "./pending-extraction"
import type { PermissionContextValue } from "../../components/mca"
import { usePermissionSound } from "../usePermissionSound"

// ============================================
// HOOK
// ============================================

export function useChatPermissions(channelId: string | undefined): PermissionContextValue {
  const client = getTerosClient()
  const { playPermissionSound } = usePermissionSound()

  // Track pending permission requests: requestId -> {messageId, toolCallId, appId, toolName, noteId?}
  // GAP-H: noteId enlaza el system message (obs-perm-*) creado para observer events,
  // así onGrant/onDeny pueden limpiarlo del chat al resolver.
  const pendingPermissions = useRef<
    Map<
      string,
      { messageId: string; toolCallId: string; appId: string; toolName: string; noteId?: string }
    >
  >(new Map())

  // ----------------------------------------
  // EFFECT: DB rehydration on mount (TER-340)
  // ----------------------------------------
  // Cuando una tab se abre fresca via "Go to approve" (o reload), los mensajes del canal
  // llegan vía getChannelMessages → chatStore.channelMessages[channelId]. Si alguno tiene
  // `content.status === 'pending_permission'` + `permissionRequestId` + `appId` (persistidos
  // por streaming-state.updateToolStatus), reconstruimos `pendingPermissions.current`
  // desde el state DB sin depender del live broadcast del backend.
  //
  // Sin esto, el flujo dependía del re-broadcast WS (`restorePendingApprovals`) que llega
  // ANTES de que `getChannelMessages` populate el store, dejando el fallback lookup vacío
  // y descartando todos los pending excepto el primero (timing-dependiente).
  //
  // El hook funciona como consumidor del state DB para correctness; el WS broadcast queda
  // como delta live (correcto en flow normal, redundante aquí — la idempotency check
  // abajo evita doble-registro).
  const channelMessageIds = useChatStore((state) =>
    channelId ? state.channelMessages[channelId] : undefined,
  )
  useEffect(() => {
    if (!channelId || !channelMessageIds || channelMessageIds.length === 0) return
    const entries = extractPendingFromMessages(channelMessageIds, useChatStore.getState().messages)
    for (const entry of entries) {
      if (pendingPermissions.current.has(entry.requestId)) continue // idempotent
      pendingPermissions.current.set(entry.requestId, {
        messageId: entry.messageId,
        toolCallId: entry.toolCallId,
        appId: entry.appId,
        toolName: entry.toolName,
      })
    }
  }, [channelId, channelMessageIds])

  // ----------------------------------------
  // Resolución local del state del hook
  // ----------------------------------------
  /**
   * Helper compartido por los callbacks de resolución (grant/deny).
   *
   * - Si el `messageId` del pending es sintético (`observed:<channel>:<toolCallId>`),
   *   no llamamos a `upsertToolMessage` — el message no existe en el store local
   *   (la card vive en otro canal) y la llamada sería un no-op silencioso.
   * - Si el pending tiene `noteId`, eliminar el system message del store al resolver
   *   (sin esto se acumulan indefinidamente).
   */
  const resolvePendingLocally = useCallback(
    (
      requestId: string,
      update: { status: 'running' } | { status: 'failed'; error: string },
    ) => {
      const pending = pendingPermissions.current.get(requestId)
      if (!pending) return

      const isSyntheticMessageId = pending.messageId.startsWith('observed:')
      if (!isSyntheticMessageId) {
        useChatStore.getState().upsertToolMessage(pending.messageId, channelId ?? '', {
          toolCallId: pending.toolCallId,
          toolName: pending.toolName,
          ...update,
          permissionRequestId: undefined,
        })
      } else {
        // La card real vive en otro canal — la actualización visual la hará
        // ese canal cuando reciba tool_status_update por su propia subscripción.
        console.log(
          `🔐 Skipping local upsertToolMessage for synthetic messageId (observer event): ${pending.messageId}`,
        )
      }

      if (pending.noteId && channelId) {
        useChatStore.getState().deleteMessage(pending.noteId, channelId)
      }
      pendingPermissions.current.delete(requestId)
    },
    [channelId],
  )

  // ----------------------------------------
  // EFFECT: Tool Permission Requests
  // ----------------------------------------
  useEffect(() => {
    const handlePermissionRequest = (data: any) => {
      const { requestId, toolName, appId, messageId, toolCallId, restored, observedChannelId } = data
      const eventChannelId: string | undefined = data.channelId

      // GAP-C: el cliente WS es singleton — si el user tiene N tabs abiertas, N hooks
      // reciben este mismo evento. Filtra: solo el hook cuyo `channelId` coincide con
      // el destino del evento (o NO está en ningún chat — entonces el hook con channelId
      // undefined no procesa nada) debe ejecutar el handler. Sin este filtro se crean N
      // system messages "El sub-agente necesita aprobación" duplicados.
      //
      // Casos válidos para procesar:
      //   - eventChannelId === channelId (evento del chat actual del hook)
      //   - observedChannelId === channelId (somos el observer; el sub-canal nos avisó)
      // Cualquier otro caso → ignorar (event va a otra tab).
      if (eventChannelId && channelId && eventChannelId !== channelId && observedChannelId !== channelId) {
        return
      }

      // TER-340: idempotency check — la rehidratación desde DB ya pudo haber registrado
      // este requestId. Si ya está en el ref, el live broadcast es redundante (mismo state).
      // Excepto si es `restored: true` con datos potencialmente actualizados, en cuyo caso
      // hacemos refresh del entry pero NO duplicamos sound ni system message.
      if (pendingPermissions.current.has(requestId)) {
        if (!restored) {
          // Live broadcast tras rehidratación — noop silencioso.
          return
        }
        // Restored broadcast tras rehidratación — refrescamos campos pero sin re-emitir UX.
        const existing = pendingPermissions.current.get(requestId)!
        pendingPermissions.current.set(requestId, {
          ...existing,
          toolName: toolName ?? existing.toolName,
          appId: appId ?? existing.appId,
        })
        return
      }

      console.log("🔐 Tool permission request received:", data)
      // Play notification sound so the user knows action is required
      playPermissionSound()

      // TER-338: events with `observedChannelId` are emitted by the parent (observer)
      // channel of a delegated / headless sub-channel. The tool call card lives in the
      // sub-channel — the user watching the parent never has the message in their local
      // store. We treat the observer event as a routing hint: the same lookup that
      // GAP-3 uses (search by toolCallId across local messages) is what we want, falling
      // back to "render a centralized modal" when the card isn't visible at all.
      const isObserverEvent = !!observedChannelId

      // GAP-3 + TER-338: resolve the messageId via fallback lookup when:
      //   - restored: original message may have been evicted from the store
      //   - isObserverEvent: card lives in another channel the user may not be viewing
      // In both cases we search the local store by toolCallId across the channel's
      // messages so the grant/deny can be applied to the visible card.
      let resolvedMessageId: string | undefined = messageId
      const needsFallback =
        toolCallId && (restored || isObserverEvent || !messageId || !useChatStore.getState().messages[messageId])
      if (needsFallback) {
        const state = useChatStore.getState()
        // Cuando es observer event, la card vive en el sub-canal — busca ahí.
        const sourceChannelId = observedChannelId ?? eventChannelId
        const channelMessageIds = (sourceChannelId && state.channelMessages[sourceChannelId]) || []
        for (const candidateId of channelMessageIds) {
          const m = state.messages[candidateId]
          if (m?.content && (m.content as any).toolCallId === toolCallId) {
            resolvedMessageId = candidateId
            console.warn(
              `🔐 Permission resolved via fallback lookup (${isObserverEvent ? 'observer' : 'restored'}): ` +
                `original messageId=${messageId} not in store, found by toolCallId=${toolCallId} → ${resolvedMessageId}`,
            )
            break
          }
        }
      }

      if (resolvedMessageId && toolCallId) {
        // Only register in memory so grant/deny callbacks can resolve the request.
        // The visual state (status, permissionRequestId, appId) is already set by the
        // tool_status_update event — that is the single source of truth for the UI.
        pendingPermissions.current.set(requestId, { messageId: resolvedMessageId, toolCallId, appId, toolName })
      } else if (toolCallId && isObserverEvent) {
        // TER-338: card lives in a sub-channel we haven't opened. Register the request
        // anyway so the centralized PendingApprovalsWindow can show it, and emit a
        // system message to the parent so the user knows there's an action waiting.
        // GAP-D: el messageId sintético `observed:...` provoca no-op silencioso en
        //        useChatStore.updateToolCall — los callbacks lo detectan y lo skippean.
        // GAP-H: trackeamos noteId para cleanup en onGrant/onDeny.
        // GAP-I: type 'system_notice' (informativo, no error) en lugar de 'error'.
        const syntheticMessageId = messageId ?? `observed:${observedChannelId}:${toolCallId}`
        let noteId: string | undefined
        if (channelId) {
          noteId = `obs-perm-${requestId}`
          const noteMessage: Message = {
            id: noteId,
            channelId,
            content: {
              // Si el renderer no conoce 'system_notice' degrada a system sender → texto neutro,
              // mejor que 'error' que se pinta en rojo (semánticamente incorrecto para una
              // acción pendiente que NO es un fallo).
              type: "system_notice" as any,
              userMessage: `El sub-agente necesita aprobación para "${toolName}". Abre el panel de aprobaciones para revisar.`,
              technicalMessage: `Observed permission request from channel ${observedChannelId} — toolCallId ${toolCallId}`,
            } as any,
            sender: "system",
            timestamp: new Date(),
          }
          useChatStore.getState().upsertMessage(noteMessage)
        }
        pendingPermissions.current.set(requestId, {
          messageId: syntheticMessageId,
          toolCallId,
          appId,
          toolName,
          noteId,
        })
      } else {
        // Fail-safe: when the backend can't resolve the tool call context for
        // a permission request, the frontend has no way to render the inline
        // ControlsBar, so the user can't decide. Auto-DENY (not auto-accept) —
        // a missed legitimate execution is recoverable; an unauthorised
        // destructive action is not. Especially important for the irreversible
        // flag introduced in TER-186/feat-renderer-ux-v2: a tool marked
        // `irreversible: true` must never silently bypass user approval.
        console.error("🔐 BUG: Permission request missing messageId or toolCallId — auto-DENYING for safety", data)
        client.respondToToolPermission(requestId, false)

        if (channelId) {
          const errorMessage: Message = {
            id: `error-perm-${Date.now()}`,
            channelId,
            content: {
              type: "error",
              errorType: "unknown",
              userMessage: `Permiso auto-DENEGADO para "${toolName}" — el agente puede reintentar (bug: falta contexto)`,
              technicalMessage: `tool_permission_request sin messageId/toolCallId. requestId: ${requestId}, appId: ${appId}, irreversible: ${data.irreversible ?? 'unknown'}`,
            },
            sender: "system",
            timestamp: new Date(),
          }
          useChatStore.getState().upsertMessage(errorMessage)
        }
      }
    }

    client.on("tool_permission_request", handlePermissionRequest)
    return () => {
      client.off("tool_permission_request", handlePermissionRequest)
    }
  }, [client, channelId, playPermissionSound, resolvePendingLocally])

  // ----------------------------------------
  // Callbacks
  // ----------------------------------------

  const onGrant = useCallback(
    (requestId: string) => {
      console.log("🔐 Permission granted:", requestId)
      client.respondToToolPermission(requestId, true)
      resolvePendingLocally(requestId, { status: 'running' })
      track("tool_permission_granted", { requestId, permanent: false })
    },
    [client, resolvePendingLocally],
  )

  const onGrantAlways = useCallback(
    async (requestId: string, appId: string, toolName: string) => {
      console.log("🔐 Permission granted always:", requestId, appId, toolName)
      client.respondToToolPermission(requestId, true)
      resolvePendingLocally(requestId, { status: 'running' })
      track("tool_permission_granted", { requestId, appId, toolName, permanent: true })

      try {
        await client.app.updateToolPermission(appId, toolName, "allow")
        console.log("🔐 Tool permission updated to allow:", toolName)
      } catch (err) {
        console.error("🔐 Failed to update tool permission:", err)
      }
    },
    [client, resolvePendingLocally],
  )

  const onDeny = useCallback(
    (requestId: string) => {
      console.log("🔐 Permission denied:", requestId)
      client.respondToToolPermission(requestId, false)
      resolvePendingLocally(requestId, { status: 'failed', error: 'Permiso denegado por el usuario' })
      track("tool_permission_denied", { requestId, permanent: false })
    },
    [client, resolvePendingLocally],
  )

  const onDenyAlways = useCallback(
    async (requestId: string, appId: string, toolName: string) => {
      console.log("🔐 Permission denied always:", requestId, appId, toolName)
      client.respondToToolPermission(requestId, false)
      resolvePendingLocally(requestId, { status: 'failed', error: 'Permiso denegado permanentemente' })
      track("tool_permission_denied", { requestId, appId, toolName, permanent: true })

      try {
        await client.app.updateToolPermission(appId, toolName, "forbid")
        console.log("🔐 Tool permission updated to deny:", toolName)
      } catch (err) {
        console.error("🔐 Failed to update tool permission:", err)
      }
    },
    [client, resolvePendingLocally],
  )

  // ----------------------------------------
  // Memoized context value
  // ----------------------------------------
  const permissionContextValue = useMemo<PermissionContextValue>(
    () => ({ onGrant, onGrantAlways, onDeny, onDenyAlways }),
    [onGrant, onGrantAlways, onDeny, onDenyAlways],
  )

  return permissionContextValue
}
