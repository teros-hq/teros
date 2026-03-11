/**
 * useChatInput
 *
 * Manages message sending:
 * - /private command handling
 * - New chat creation (createWithMessage)
 * - Existing chat send flow (text, audio, file)
 * - Retry failed messages
 * - Channel rename handler
 */

import { useCallback } from "react"
import { getTerosClient } from "../../../app/_layout"
import type { Message } from "../../components/MessageBubble"
import { useChatStore } from "../../store/chatStore"

// ============================================
// TYPES
// ============================================

export interface ChatInputHandlers {
  handleSend: (
    text: string,
    audio?: { uri?: string; blob?: Blob; duration: number; url?: string },
    file?: { fileId: string; url: string; originalName: string; mimeType: string; size: number },
  ) => Promise<void>
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
  setAutoScrollEnabled: (v: boolean) => void
  setIsNearBottom: (v: boolean) => void
  scrollToBottom: (animated?: boolean) => void
  justSentMessage: React.MutableRefObject<boolean>
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
  setAutoScrollEnabled,
  setIsNearBottom,
  scrollToBottom,
  justSentMessage,
}: UseChatInputOptions): ChatInputHandlers {
  const client = getTerosClient()

  // ----------------------------------------
  // Send Message
  // ----------------------------------------
  const handleSend = useCallback(
    async (
      text: string,
      audio?: { uri?: string; blob?: Blob; duration: number; url?: string },
      file?: { fileId: string; url: string; originalName: string; mimeType: string; size: number },
    ) => {
      if (!text.trim() && !audio && !file) return
      if (!client) return

      const messageText = text.trim()

      // ---- /private command ----
      if (messageText === "/private" && channelId) {
        try {
          const currentChannel = useChatStore.getState().channels[channelId]
          const newPrivateState = !currentChannel?.isPrivate
          await client.channel.setPrivate(channelId, newPrivateState)
        } catch (error) {
          console.error("[useChatInput] Error toggling private mode:", error)
        }
        return
      }

      // ---- New chat: create channel with first message ----
      if (!channelId && initialAgentId) {
        try {
          let audioData: { data: string; mimeType?: string; duration?: number } | undefined
          if (audio) {
            let base64Data: string
            let mimeType: string | undefined

            if (audio.blob) {
              const arrayBuffer = await audio.blob.arrayBuffer()
              const bytes = new Uint8Array(arrayBuffer)
              let binary = ""
              for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i])
              }
              base64Data = btoa(binary)
              mimeType = audio.blob.type
            } else if (audio.uri) {
              const { File } = await import("expo-file-system")
              const f = new (File as any)(audio.uri)
              base64Data = await f.base64()
              const ext = audio.uri.split(".").pop()?.toLowerCase()
              mimeType = ext === "m4a" ? "audio/m4a" : ext === "wav" ? "audio/wav" : "audio/mp4"
            } else {
              throw new Error("No audio data available")
            }

            audioData = { data: base64Data, mimeType, duration: audio.duration }
          }

          const createContent = audioData
            ? {
                type: "voice" as const,
                data: audioData.data,
                mimeType: audioData.mimeType,
                duration: audioData.duration,
              }
            : { type: "text" as const, text: messageText }

          const result = await client.channel.createWithMessage({
            agentId: initialAgentId,
            content: createContent,
            workspaceId,
          })

          const resultChannel = result.channel as any
          if (resultChannel?.modelString) setModelString(resultChannel.modelString)
          if (resultChannel?.modelName) setModelName(resultChannel.modelName)
          if (resultChannel?.providerName) setProviderName(resultChannel.providerName)

          onChannelCreated?.(result.channelId)
          return
        } catch (error) {
          console.error("[useChatInput] Error creating channel with message:", error)
          return
        }
      }

      // ---- Existing chat: normal send flow ----
      if (!channelId) return

      const tempId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

      let userMessage: Message
      let base64Data: string | undefined
      let mimeType: string | undefined

      // Pre-process audio
      if (audio) {
        if (audio.blob) {
          const arrayBuffer = await audio.blob.arrayBuffer()
          const bytes = new Uint8Array(arrayBuffer)
          let binary = ""
          for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i])
          }
          base64Data = btoa(binary)
          mimeType = audio.blob.type
        } else if (audio.uri) {
          const { File } = await import("expo-file-system")
          const f = new (File as any)(audio.uri)
          base64Data = await f.base64()
          const ext = audio.uri.split(".").pop()?.toLowerCase()
          mimeType = ext === "m4a" ? "audio/m4a" : ext === "wav" ? "audio/wav" : "audio/mp4"
        }
      }

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
          status: "sending",
          retryData: base64Data
            ? {
                audioData: base64Data,
                audioMimeType: mimeType,
                audioDuration: audio.duration,
              }
            : undefined,
        }
      } else if (file) {
        const isImage = file.mimeType.startsWith("image/")
        userMessage = {
          id: tempId,
          channelId,
          content: isImage
            ? { type: "image", url: file.url, caption: messageText || undefined }
            : {
                type: "file",
                url: file.url,
                filename: file.originalName,
                mimeType: file.mimeType,
                size: file.size,
                caption: messageText || undefined,
              },
          sender: "user",
          timestamp: new Date(),
          status: "sending",
          retryData: messageText ? { text: messageText } : undefined,
        }
      } else {
        userMessage = {
          id: tempId,
          channelId,
          content: { type: "text", text: messageText },
          sender: "user",
          timestamp: new Date(),
          status: "sending",
          retryData: messageText ? { text: messageText } : undefined,
        }
      }

      useChatStore.getState().upsertMessage(userMessage)

      justSentMessage.current = true
      setAutoScrollEnabled(true)
      setIsNearBottom(true)
      setTimeout(() => scrollToBottom(true), 50)

      try {
        if (audio && base64Data) {
          await client.channel.sendMessage(channelId, {
            type: "voice",
            data: base64Data,
            mimeType,
            duration: audio.duration,
          })
        } else if (file) {
          await client.channel.sendMessage(channelId, {
            type: "file",
            url: file.url,
            filename: file.originalName,
            mimeType: file.mimeType,
            size: file.size,
            text: messageText || undefined,
          })
        } else {
          await client.channel.sendMessage(channelId, { type: "text", text: messageText })
        }
        // Status updated to 'sent' in handleMessageSent when backend confirms
      } catch (error) {
        console.error("[useChatInput] Error sending message:", error)
        useChatStore.getState().updateMessage(tempId, { status: "failed" })
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
      setAutoScrollEnabled,
      setIsNearBottom,
      scrollToBottom,
      justSentMessage,
    ],
  )

  // ----------------------------------------
  // Retry Failed Message
  // ----------------------------------------
  const handleRetryMessage = useCallback(
    async (message: Message) => {
      if (!message.retryData || !channelId) return

      useChatStore.getState().updateMessage(message.id, { status: "sending" })

      try {
        if (message.retryData.audioData) {
          await client.channel.sendMessage(channelId, {
            type: "voice",
            data: message.retryData.audioData,
            mimeType: message.retryData.audioMimeType,
            duration: message.retryData.audioDuration,
          })
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
  // Archive (stub)
  // ----------------------------------------
  const handleArchive = useCallback(async () => {
    console.log("[useChatInput] Archive not implemented yet")
  }, [])

  return { handleSend, handleRetryMessage, handleRenameChannel, handleArchive }
}
