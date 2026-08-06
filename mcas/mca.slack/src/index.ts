#!/usr/bin/env npx tsx

/**
 * Slack MCA v1.0.0
 *
 * Full Slack workspace integration using McaServer with HTTP transport.
 * Uses Slack Web API via @slack/web-api with OAuth 2.0 authentication.
 * Implements rate limiting with exponential backoff and retry logic.
 *
 * Features:
 * - Health check (credential + connectivity probe)
 * - Channels: list, get, create, archive, join, invite
 * - Messages: send (channels/DMs/threads), list history, thread replies
 * - Reactions: add, remove
 * - Users: list, get by ID/email, presence
 * - Files: upload, list
 * - Search: messages, files
 * - Team info
 */

import { McaServer, type ToolConfig } from "@teros/mca-sdk"
import {
  acceptSharedInvite,
  addBookmark,
  addReaction,
  approveSharedInvite,
  archiveChannel,
  addCall,
  addCallParticipants,
  addEmoji,
  addRemoteFile,
  appendStream,
  completeUpload,
  createCanvas,
  createChannel,
  createChannelCanvas,
  createList,
  createListField,
  createListItem,
  declineSharedInvite,
  deleteCanvas,
  deleteFile,
  deleteList,
  deleteListField,
  deleteListItem,
  editBookmark,
  editCanvas,
  endCall,
  getAccessLogs,
  getCall,
  getIntegrationLogs,
  getTeamProfile,
  kickFromChannel,
  markChannelRead,
  deleteMessage,
  deleteScheduledMessage,
  deleteUserPhoto,
  endDnd,
  getDnd,
  getTeamDnd,
  getUserIdentity,
  getFile,
  getList,
  getReactions,
  getRemoteFile,
  getTeamPreferences,
  getUploadUrl,
  getUserProfile,
  inviteShared,
  leaveChannel,
  listAuthTeams,
  listBookmarks,
  listChannelMembers,
  listConnectInvites,
  listEmoji,
  listListFields,
  listListItems,
  listMyReactions,
  listUserChannels,
  listPins,
  listRemoteFiles,
  listStars,
  openDm,
  removeRemoteFile,
  revokeAuth,
  revokeFilePublic,
  shareFilePublic,
  shareRemoteFile,
  updateRemoteFile,
  pinMessage,
  removeBookmark,
  removeCallParticipants,
  removeEmoji,
  renameChannel,
  setChannelPurpose,
  setChannelTopic,
  starItem,
  unarchiveChannel,
  unpinMessage,
  updateCall,
  updateList,
  updateListField,
  updateListItem,
  updateUserProfile,
  getChannel,
  getPermalink,
  getTeamInfo,
  getUser,
  getUserPresence,
  healthCheck,
  inviteToChannel,
  joinChannel,
  listChannels,
  listFiles,
  listMessages,
  listScheduledMessages,
  listUsers,
  removeReaction,
  scheduleMessage,
  searchFiles,
  searchMessages,
  setDnd,
  startStream,
  stopStream,
  unfurlLink,
  unstarItem,
  sendEphemeral,
  sendMeMessage,
  sendMessage,
  sendThreadReply,
  updateMessage,
  uploadFile,
} from "./tools"

const server = new McaServer({
  id: "mca.slack",
  name: "Slack",
  version: "1.0.0",
})

// Helper to register tools — casts needed due to SDK type mismatch
// between server.d.ts and http-server.d.ts ToolContext definitions
const register = (name: string, config: any) => {
  server.tool(name, config)
}

// =============================================================================
// HEALTH CHECK
// =============================================================================

register("-health-check", healthCheck)

// =============================================================================
// CHANNELS
// =============================================================================

register("list-channels", listChannels)
register("get-channel", getChannel)
register("create-channel", createChannel)
register("archive-channel", archiveChannel)
register("join-channel", joinChannel)
register("invite-to-channel", inviteToChannel)
register("leave-channel", leaveChannel)
register("list-channel-members", listChannelMembers)
register("open-dm", openDm)
register("rename-channel", renameChannel)
register("set-channel-purpose", setChannelPurpose)
register("set-channel-topic", setChannelTopic)
register("kick-from-channel", kickFromChannel)
register("unarchive-channel", unarchiveChannel)
register("mark-channel-read", markChannelRead)

// =============================================================================
// MESSAGES
// =============================================================================

register("send-message", sendMessage)
register("send-thread-reply", sendThreadReply)
register("list-messages", listMessages)
register("update-message", updateMessage)
register("delete-message", deleteMessage)
register("get-permalink", getPermalink)
register("schedule-message", scheduleMessage)
register("list-scheduled-messages", listScheduledMessages)
register("delete-scheduled-message", deleteScheduledMessage)
register("send-ephemeral", sendEphemeral)
register("send-me-message", sendMeMessage)
register("unfurl-link", unfurlLink)

// =============================================================================
// PINS
// =============================================================================

register("pin-message", pinMessage)
register("unpin-message", unpinMessage)
register("list-pins", listPins)

// =============================================================================
// BOOKMARKS
// =============================================================================

register("add-bookmark", addBookmark)
register("remove-bookmark", removeBookmark)
register("list-bookmarks", listBookmarks)
register("edit-bookmark", editBookmark)

// =============================================================================
// REACTIONS
// =============================================================================

register("add-reaction", addReaction)
register("remove-reaction", removeReaction)
register("get-reactions", getReactions)
register("list-my-reactions", listMyReactions)

// =============================================================================
// USERS
// =============================================================================

register("list-users", listUsers)
register("get-user", getUser)
register("get-user-presence", getUserPresence)
register("get-user-profile", getUserProfile)
register("update-user-profile", updateUserProfile)
register("list-user-channels", listUserChannels)
register("delete-user-photo", deleteUserPhoto)
register("get-user-identity", getUserIdentity)

// =============================================================================
// FILES
// =============================================================================

register("upload-file", uploadFile)
register("list-files", listFiles)
register("get-file", getFile)
register("delete-file", deleteFile)
register("get-upload-url", getUploadUrl)
register("complete-upload", completeUpload)
register("share-file-public", shareFilePublic)
register("revoke-file-public", revokeFilePublic)
register("list-remote-files", listRemoteFiles)
register("add-remote-file", addRemoteFile)
register("update-remote-file", updateRemoteFile)
register("remove-remote-file", removeRemoteFile)
register("share-remote-file", shareRemoteFile)
register("get-remote-file", getRemoteFile)

// =============================================================================
// SEARCH
// =============================================================================

register("search-messages", searchMessages)
register("search-files", searchFiles)

// =============================================================================
// TEAM
// =============================================================================

register("get-team-info", getTeamInfo)
register("get-team-preferences", getTeamPreferences)
register("get-team-profile", getTeamProfile)
register("get-access-logs", getAccessLogs)
register("get-integration-logs", getIntegrationLogs)

// =============================================================================
// STARS (saved items)
// =============================================================================

register("star-item", starItem)
register("unstar-item", unstarItem)
register("list-stars", listStars)

// =============================================================================
// EMOJI (custom)
// =============================================================================

register("list-emoji", listEmoji)
register("add-emoji", addEmoji)
register("remove-emoji", removeEmoji)

// =============================================================================
// DND
// =============================================================================

register("set-dnd", setDnd)
register("end-dnd", endDnd)
register("get-dnd", getDnd)
register("get-team-dnd", getTeamDnd)

// =============================================================================
// LISTS API (experimental, 2024+)
// =============================================================================

register("create-list", createList)
register("update-list", updateList)
register("delete-list", deleteList)
register("get-list", getList)
register("list-list-items", listListItems)
register("create-list-item", createListItem)
register("update-list-item", updateListItem)
register("delete-list-item", deleteListItem)
register("list-list-fields", listListFields)
register("create-list-field", createListField)
register("update-list-field", updateListField)
register("delete-list-field", deleteListField)

// =============================================================================
// CANVAS API (experimental, 2024+)
// =============================================================================

register("create-canvas", createCanvas)
register("edit-canvas", editCanvas)
register("delete-canvas", deleteCanvas)
register("create-channel-canvas", createChannelCanvas)

// =============================================================================
// STREAMING CHAT (experimental, 2024+)
// =============================================================================

register("start-stream", startStream)
register("append-stream", appendStream)
register("stop-stream", stopStream)

// =============================================================================
// CALLS API (experimental)
// =============================================================================

register("add-call", addCall)
register("end-call", endCall)
register("update-call", updateCall)
register("get-call", getCall)
register("add-call-participants", addCallParticipants)
register("remove-call-participants", removeCallParticipants)

// =============================================================================
// SLACK CONNECT (cross-workspace channels)
// =============================================================================

register("list-connect-invites", listConnectInvites)
register("invite-shared", inviteShared)
register("accept-shared-invite", acceptSharedInvite)
register("decline-shared-invite", declineSharedInvite)
register("approve-shared-invite", approveSharedInvite)

// =============================================================================
// AUTH (OAuth lifecycle)
// =============================================================================

register("revoke-auth", revokeAuth)
register("list-auth-teams", listAuthTeams)

// =============================================================================
// START SERVER
// =============================================================================

server.start().catch((error) => {
  console.error("[Slack MCA] Fatal error:", error)
  process.exit(1)
})
