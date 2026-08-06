/**
 * useChatInput
 *
 * Manages message sending:
 * - /private command handling
 * - New chat creation (createWithMessage)
 * - Existing chat send flow (text, audio, multiple files)
 * - Retry failed messages
 * - Channel rename handler
 */

import { useCallback } from "react"
import { Platform } from "react-native"
import { getTerosClient } from "../../services/terosClientSingleton"
import { track } from "../../lib/analytics"
import { buildFirstMessageContent } from "./first-message-content"
import type { Message } from "../../store/chatStore"
import { useChatStore } from "../../store/chatStore"
import { useAudioStore } from "../../store/audioStore"
import { useWorkspaceStore } from "../../store/workspaceStore"

// ============================================
// TYPES
// ============================================

export interface ChatInputHandlers {
  handleSend: (
    text: string,
    audio?: { uri?: string; blob?: Blob; duration: number; url?: string },
    files?: { fileId: string; url: string; originalName: string; mimeType: string; size: number }[],
  ) => Promise<{ success: boolean }>
  handleRetryMessage: (message: Message) => Promise<void>
  handleRenameChannel: (newTitle: string) => Promise<void>
  handleArchive: () => Promise<void>
}

interface UseChatInputOptions {
  channelId: string | undefined
  initialAgentId: string | undefined
  workspaceId: string | undefined
  conversation: any
  onChannelCreated: ((channelId: string) => void) | undefined
  onTitleChange: ((title: string) => void) | undefined
  setModelString: (v: string | undefined) => void
  setModelName: (v: string | undefined) => void
  setProviderName: (v: string | undefined) => void
  setConversation: (fn: (prev: any) => any) => void
  /** Called after the channel is successfully archived (e.g. to close the chat window). */
  onArchived: (() => void) | undefined
}

// ============================================
// HELPERS
// ============================================

/**
 * Persist a temporary audio URI to a stable location in documentDirectory.
 *
 * expo-audio saves recordings to a temporary directory that iOS can purge at
 * any time. Copying to documentDirectory ensures the file survives until we
 * explicitly delete it after a successful send.
 *
 * Only runs on native (iOS/Android). On web, Blob objects are used instead.
 */
async function persistAudioFile(tempUri: string): Promise<string> {
  if (Platform.OS === "web") return tempUri

  try {
    const FileSystem = await import("expo-file-system") as any
    const ext = tempUri.split(".").pop()?.toLowerCase() ?? "m4a"
    const destUri = `${FileSystem.documentDirectory}teros-voice-${Date.now()}.${ext}`
    await FileSystem.copyAsync({ from: tempUri, to: destUri })
    return destUri
  } catch (e) {
    // If copy fails, fall back to the original temp URI
    console.warn("[useChatInput] Failed to persist audio file, using temp URI:", e)
    return tempUri
  }
}

/**
 * Delete a persisted audio file after successful send.
 * Silently ignores errors (file may already be gone).
 */
async function deletePersistedAudioFile(uri: string): Promise<void> {
  if (Platform.OS === "web") return
  if (!uri.includes("teros-voice-")) return // only delete files we created

  try {
    const FileSystem = await import("expo-file-system")
    await FileSystem.deleteAsync(uri, { idempotent: true })
  } catch {
    // ignore
  }
}

/**
 * Convert an audio source (Blob or local file URI) to base64.
 *
 * On iOS, expo-file-system's File.base64() can return an empty string if the
 * recording file has not been fully flushed to disk yet (a known issue with
 * expo-audio on iOS/Safari). Using fetch() over the local file URI is more
 * reliable because the fetch implementation waits for the file to be available
 * before resolving, and it also works with Blob objects on web.
 *
 * References:
 *   https://github.com/expo/expo/issues/41656
 *   https://github.com/expo/expo/issues/37018
 */
async function audioToBase64(
  audio: { uri?: string; blob?: Blob },
): Promise<{ base64Data: string; mimeType: string }> {
  // Prefer blob path (web) — already in memory, no file I/O needed
  if (audio.blob) {
    const arrayBuffer = await audio.blob.arrayBuffer()
    const bytes = new Uint8Array(arrayBuffer)
    let binary = ""
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return {
      base64Data: btoa(binary),
      mimeType: audio.blob.type || "audio/mp4",
    }
  }

  if (audio.uri) {
    // Use fetch() instead of expo-file-system File.base64() — fetch waits for
    // the file to be fully written before resolving, which avoids the iOS bug
    // where File.base64() returns empty for freshly-stopped recordings.
    const response = await fetch(audio.uri)
    if (!response.ok) {
      throw new Error(`Failed to read audio file: ${response.status} ${response.statusText}`)
    }
    const blob = await response.blob()
    const arrayBuffer = await blob.arrayBuffer()
    const bytes = new Uint8Array(arrayBuffer)
    let binary = ""
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    // Prefer the MIME type from the blob; fall back to extension sniffing
    const mimeType =
      (blob.type && blob.type !== "application/octet-stream" ? blob.type : null) ??
      (audio.uri.endsWith(".m4a") ? "audio/m4a" :
       audio.uri.endsWith(".wav") ? "audio/wav" :
       "audio/mp4")
    return { base64Data: btoa(binary), mimeType }
  }

  throw new Error("No audio data available: neither blob nor uri provided")
}

// ============================================
// HOOK
// ============================================

export function useChatInput({
  channelId,
  initialAgentId,
  workspaceId,
  conversation,
  onChannelCreated,
  onTitleChange,
  setModelString,
  setModelName,
  setProviderName,
  setConversation,
  onArchived,
}: UseChatInputOptions): ChatInputHandlers {
  const client = getTerosClient()
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)

  // ----------------------------------------
  // Send Message
  // ----------------------------------------
  const handleSend = useCallback(
    async (
      text: string,
      audio?: { uri?: string; blob?: Blob; duration: number; url?: string },
      files?: { fileId: string; url: string; originalName: string; mimeType: string; size: number }[],
    ) => {
      if (!text.trim() && !audio && (!files || files.length === 0)) return { success: true }
      if (!client) return { success: true }

      const messageText = text.trim()

      // ---- /private command ----
      if (messageText === "/private" && channelId) {
        try {
          const currentChannel = useChatStore.getState().channels[channelId]
          const newPrivateState = !currentChannel?.isPrivate
          await client.channel.setPrivate(channelId, newPrivateState)
        } catch (error) {
          console.error("[useChatInput] Error toggling private mode:", error)
          return { success: false }
        }
        return { success: true }
      }

      // ---- New chat: create channel with first message ----
      if (!channelId && initialAgentId) {
        try {
          let audioData: { data: string; mimeType?: string; duration?: number } | undefined
          if (audio) {
            const { base64Data, mimeType } = await audioToBase64(audio)
            audioData = { data: base64Data, mimeType, duration: audio.duration }
          }

          // First-message content priority: audio > file(s) > text. A single file
          // carries the text as caption so the agent sees image + question in one
          // turn; multiple files are sent as follow-up messages (mirroring the
          // existing-channel flow) with only the final message waking the agent.
          const createContent = buildFirstMessageContent({
            audio: audioData,
            files,
            text: messageText,
          })

          // Use explicit workspaceId if provided, otherwise fall back to the
          // currently active workspace from the store. This ensures superagents
          // (workspaceId: null on the agent) still get a workspaceId on the channel.
          const resolvedWorkspaceId = workspaceId ?? activeWorkspaceId ?? undefined

          // With multiple files, hold the agent until every file (and trailing text)
          // has landed, then wake once on the final message.
          const hasFollowUpFiles = !!files && files.length > 1

          const result = await client.channel.createWithMessage({
            agentId: initialAgentId,
            content: createContent,
            workspaceId: resolvedWorkspaceId,
            ...(hasFollowUpFiles ? { wakeUpAgent: false } : {}),
          })

          if (files && files.length > 1) {
            for (let i = 1; i < files.length; i++) {
              const file = files[i]
              const isLast = i === files.length - 1 && !messageText
              await client.channel.sendMessage(
                result.channelId,
                {
                  type: "file",
                  url: file.url,
                  filename: file.originalName,
                  mimeType: file.mimeType,
                  size: file.size,
                },
                !isLast ? { wakeUpAgent: false } : undefined,
              )
            }
            if (messageText) {
              await client.channel.sendMessage(result.channelId, {
                type: "text",
                text: messageText,
              })
            }
          }

          const resultChannel = result.channel as any
          if (resultChannel?.modelString) setModelString(resultChannel.modelString)
          if (resultChannel?.modelName) setModelName(resultChannel.modelName)
          if (resultChannel?.providerName) setProviderName(resultChannel.providerName)

          track("message_sent", {
            channelId: result.channelId,
            isNewChannel: true,
            type: audio ? "voice" : files && files.length > 0 ? "file" : "text",
          })
          onChannelCreated?.(result.channelId)
          return { success: true }
        } catch (error) {
          console.error("[useChatInput] Error creating channel with message:", error)
          return { success: false }
        }
      }

      // ---- Existing chat: normal send flow ----
      if (!channelId) return { success: true }

      const tempId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

      // `isTyping` only tracks LLM text streaming; while a tool runs the channel is busy too, so also check the latest assistant's tool calls.
      const channelIsBusy = (() => {
        const s = useChatStore.getState()
        if (s.channels[channelId]?.isTyping === true) return true
        const ids = s.channelMessages[channelId] || []
        for (let i = ids.length - 1; i >= 0; i--) {
          const m = s.messages[ids[i]]
          if (!m) continue
          if (m.sender === "user") break
          const c = m.content as { type?: string; status?: string } | undefined
          if (
            c?.type === "tool_execution" &&
            (c.status === "running" || c.status === "pending_permission")
          ) {
            return true
          }
          if (
            (m as any).toolCalls?.some(
              (t: { status?: string }) => t.status === "running" || t.status === "pending_permission",
            )
          ) {
            return true
          }
        }
        return false
      })()
      const initialStatus: "sending" | "queued" = channelIsBusy ? "queued" : "sending"

      let userMessage: Message
      let base64Data: string | undefined
      let mimeType: string | undefined
      // Persistent URI — copied to documentDirectory so it survives until retry succeeds
      let persistedUri: string | undefined

      // Pre-process audio: persist the file first, then convert to base64
      if (audio?.uri) {
        persistedUri = await persistAudioFile(audio.uri)
      }

      if (audio) {
        try {
          const result = await audioToBase64(persistedUri ? { uri: persistedUri } : audio)
          base64Data = result.base64Data
          mimeType = result.mimeType
        } catch (error) {
          console.error("[useChatInput] Failed to read audio data:", error)
          // base64Data stays undefined — message will be marked failed below
        }
      }

      // ---- Optimistic UI messages ----
      if (audio) {
        const audioUrl =
          audio.url || (audio.blob ? URL.createObjectURL(audio.blob) : audio.uri) || ""
        userMessage = {
          id: tempId,
          channelId,
          content: {
            type: "voice",
            url: audioUrl,
            duration: audio.duration,
            transcription: undefined,
          },
          sender: "user",
          timestamp: new Date(),
          status: initialStatus,
          // Always store retryData with the persisted URI so retry can re-read
          // the file even if base64 conversion failed (e.g. network cut mid-send)
          retryData: {
            audioUri: persistedUri,
            audioData: base64Data,
            audioMimeType: mimeType,
            audioDuration: audio.duration,
          },
        }
      } else if (files && files.length > 0) {
        // Multiple files: create optimistic messages for each
        // @todo alice - 2026.04.25 : the optimistic message uses type "image" for
        // images but the backend always stores type "file"; on history reload the
        // frontend renders FileBubble instead of ImageBubble. Fix at the boundary.
        const fileMessages: Message[] = files.map((file) => {
          const isImage = file.mimeType.startsWith("image/")
          return {
            id: `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            channelId,
            content: isImage
              ? { type: "image" as const, url: file.url, caption: messageText || undefined }
              : {
                  type: "file" as const,
                  url: file.url,
                  filename: file.originalName,
                  mimeType: file.mimeType,
                  size: file.size,
                  caption: messageText || undefined,
                },
            sender: "user",
            timestamp: new Date(),
            status: initialStatus,
            retryData: messageText ? { text: messageText } : undefined,
          }
        })
        // Upsert all file messages
        fileMessages.forEach((msg) => useChatStore.getState().upsertMessage(msg))
        userMessage = fileMessages[fileMessages.length - 1]
      } else {
        userMessage = {
          id: tempId,
          channelId,
          content: { type: "text", text: messageText },
          sender: "user",
          timestamp: new Date(),
          status: initialStatus,
          retryData: messageText ? { text: messageText } : undefined,
        }
      }

      useChatStore.getState().upsertMessage(userMessage)

      // If audio read failed, mark as failed — retry button will re-read from persistedUri
      if (audio && !base64Data) {
        useChatStore.getState().updateMessage(tempId, { status: "failed" })
        return { success: false }
      }

      // ---- Send to backend ----
      try {
        if (audio && base64Data) {
          await client.channel.sendMessage(channelId, {
            type: "voice",
            data: base64Data,
            mimeType,
            duration: audio.duration,
          })
          // Send succeeded — clean up the persisted file and audioStore
          if (persistedUri) {
            deletePersistedAudioFile(persistedUri).catch(() => {})
          }
          useAudioStore.getState().clearPendingAudio(channelId)
        } else if (files && files.length > 0) {
          // Send each file as a separate message.
          // All except the last use wakeUpAgent: false so the agent only
          // wakes up once, after the final message.
          for (let i = 0; i < files.length; i++) {
            const file = files[i]
            const isLast = i === files.length - 1 && !messageText
            const isImage = file.mimeType.startsWith("image/")

            if (isImage) {
              // @todo alice - 2026.04.25 : the optimistic message uses type "image" for images but the
              // backend always stores type "file". On history reload the frontend receives type "file"
              // and renders FileBubble instead of ImageBubble. Fix by either (a) sending type "image"
              // to the backend and handling it there, or (b) detecting mimeType on the frontend when
              // rendering history messages.
            }

            await client.channel.sendMessage(
              channelId,
              {
                type: "file",
                url: file.url,
                filename: file.originalName,
                mimeType: file.mimeType,
                size: file.size,
                // caption: isLast ? messageText || undefined : undefined,
              },
              !isLast ? { wakeUpAgent: false } : undefined,
            )
          }

          // If there's text alongside files, send it as the final message
          if (messageText) {
            await client.channel.sendMessage(channelId, { type: "text", text: messageText })
          }
        } else {
          await client.channel.sendMessage(channelId, { type: "text", text: messageText })
        }
        track("message_sent", {
          channelId,
          isNewChannel: false,
          type: audio ? "voice" : files && files.length > 0 ? "file" : "text",
        })
        // Status updated to 'sent' in handleMessageSent when backend confirms
        return { success: true }
      } catch (error) {
        console.error("[useChatInput] Error sending message:", error)
        useChatStore.getState().updateMessage(tempId, { status: "failed" })
        // Do NOT delete persistedUri here — user needs it to retry
        return { success: false }
      }
    },
    [
      client,
      channelId,
      initialAgentId,
      workspaceId,
      onChannelCreated,
      setModelString,
      setModelName,
      setProviderName,
    ],
  )

  // ----------------------------------------
  // Retry Failed Message
  // ----------------------------------------
  const handleRetryMessage = useCallback(
    async (message: Message) => {
      if (!channelId) return

      // Retry from a provider-error card (TER-699): the error message itself has
      // no retryData — re-run the turn that failed by finding the nearest
      // preceding user message with retryData and retrying that.
      if (!message.retryData && message.content.type === "error") {
        const s = useChatStore.getState()
        const ids = s.channelMessages[channelId] || []
        const idx = ids.indexOf(message.id)
        for (let i = idx - 1; i >= 0; i--) {
          const prev = s.messages[ids[i]]
          if (prev?.sender === "user" && prev.retryData) {
            await handleRetryMessage(prev)
            return
          }
        }
        return
      }

      // Transcription-failed voice messages: retry transcription on backend (audio file already saved)
      if (
        !message.retryData &&
        message.content.type === "voice" &&
        (message.content as any).transcriptionError
      ) {
        useChatStore.getState().updateMessage(message.id, {
          content: {
            ...message.content,
            transcriptionError: undefined,
          },
        })
        try {
          await client.channel.retryTranscription(channelId, message.id)
        } catch (error) {
          console.error("[useChatInput] Error retrying transcription:", error)
        }
        return
      }

      if (!message.retryData) return

      useChatStore.getState().updateMessage(message.id, { status: "sending" })

      try {
        if (message.retryData.audioData || message.retryData.audioUri) {
          let base64Data = message.retryData.audioData
          let mimeType = message.retryData.audioMimeType

          // If we don't have base64 cached but have the persisted URI, re-read it
          if (!base64Data && message.retryData.audioUri) {
            const result = await audioToBase64({ uri: message.retryData.audioUri })
            base64Data = result.base64Data
            mimeType = result.mimeType
          }

          if (!base64Data) throw new Error("No audio data available for retry")

          await client.channel.sendMessage(channelId, {
            type: "voice",
            data: base64Data,
            mimeType,
            duration: message.retryData.audioDuration,
          })

          // Clean up persisted file after successful retry
          if (message.retryData.audioUri) {
            deletePersistedAudioFile(message.retryData.audioUri).catch(() => {})
          }
        } else if (message.retryData.text) {
          await client.channel.sendMessage(channelId, {
            type: "text",
            text: message.retryData.text,
          })
        }

        useChatStore.getState().updateMessage(message.id, {
          status: "sent",
          retryData: undefined,
        })
      } catch (error) {
        console.error("[useChatInput] Error retrying message:", error)
        useChatStore.getState().updateMessage(message.id, { status: "failed" })
      }
    },
    [client, channelId],
  )

  // ----------------------------------------
  // Rename Channel
  // ----------------------------------------
  const handleRenameChannel = useCallback(
    async (newTitle: string) => {
      if (!newTitle.trim() || !conversation || !channelId) return

      try {
        await client.channel.rename(channelId, newTitle.trim())
        setConversation((prev: any) => (prev ? { ...prev, title: newTitle.trim() } : prev))
        onTitleChange?.(newTitle.trim())
      } catch (error) {
        console.error("[useChatInput] Error renaming channel:", error)
      }
    },
    [client, channelId, conversation, onTitleChange, setConversation],
  )

  // ----------------------------------------
  // Archive
  // ----------------------------------------
  // Closes (soft-archives) the channel on the backend. The backend broadcasts
  // `channel_list_status` with action 'deleted' to every user session, so the
  // NavBar and the Conversations window drop it from their lists in realtime;
  // on reload `channel.list` no longer returns it as active (status: 'closed').
  // `onArchived` lets the caller close the now-archived chat window.
  const handleArchive = useCallback(async () => {
    if (!channelId) return
    try {
      await client.channel.close(channelId)
      onArchived?.()
    } catch (error) {
      console.error("[useChatInput] Error archiving channel:", error)
    }
  }, [client, channelId, onArchived])

  return { handleSend, handleRetryMessage, handleRenameChannel, handleArchive }
}
