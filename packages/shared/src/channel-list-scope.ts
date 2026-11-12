/**
 * Which conversation list a channel belongs in.
 *
 * `channel_list_status` reaches every session of the channel's owner, whatever
 * workspace each session is looking at, and it also fires for channels no list
 * shows (headless runs, delegated sub-conversations). Every such event carries
 * the channel's list scope, and a list only ADDS a channel whose scope says it
 * belongs there. Channels a list already shows keep being updated regardless.
 *
 * @spec CHAN-REQ-11
 */

export interface ChannelListScope {
  /** Workspace the channel lives in; `null` for a channel outside any workspace. */
  workspaceId: string | null
  /** True for a channel created by a headless run (never listed). */
  headless: boolean
  /** Parent channel of a delegated sub-conversation; `null` for a top-level channel. */
  originChannelId: string | null
}

/**
 * The list scope of a stored channel, as sent in every `channel_list_status`.
 * @spec CHAN-REQ-11
 */
export function channelListScope(channel: {
  workspaceId?: string | null
  headless?: boolean | null
  originChannelId?: string | null
}): ChannelListScope {
  return {
    workspaceId: channel.workspaceId ?? null,
    headless: channel.headless === true,
    originChannelId: channel.originChannelId ?? null,
  }
}

/**
 * Whether a channel announced by `channel_list_status` may be ADDED to the
 * conversation list of the workspace a client is showing. An event without a
 * `workspaceId` field does not say where the channel lives, so it adds nothing.
 * @spec CHAN-REQ-12
 */
export function belongsInWorkspaceList(
  event: Partial<ChannelListScope>,
  activeWorkspaceId: string | null | undefined,
): boolean {
  if (event.workspaceId === undefined) return false
  if (event.headless || event.originChannelId) return false
  return event.workspaceId === (activeWorkspaceId ?? null)
}

/**
 * Whether a channel announced by `channel_list_status` lives in the workspace
 * a client is showing, whatever kind of channel it is.
 * @spec CHAN-REQ-12
 */
export function isInWorkspace(
  event: Partial<ChannelListScope>,
  activeWorkspaceId: string | null | undefined,
): boolean {
  return event.workspaceId !== undefined && event.workspaceId === (activeWorkspaceId ?? null)
}
