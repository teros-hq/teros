import { describe, expect, it } from 'bun:test'
import { belongsInWorkspaceList, channelListScope, isInWorkspace } from './channel-list-scope'

describe('channel list scope', () => {
  it('[CHAN-AC-8] channelListScope always yields the three fields', () => {
    expect(channelListScope({})).toEqual({ workspaceId: null, headless: false, originChannelId: null })
    expect(
      channelListScope({ workspaceId: 'ws_1', headless: true, originChannelId: 'ch_parent' }),
    ).toEqual({ workspaceId: 'ws_1', headless: true, originChannelId: 'ch_parent' })
  })

  it('[CHAN-AC-9] a top-level channel of the active workspace is listed', () => {
    expect(belongsInWorkspaceList({ workspaceId: 'ws_1', headless: false, originChannelId: null }, 'ws_1')).toBe(true)
    expect(belongsInWorkspaceList({ workspaceId: null, headless: false, originChannelId: null }, null)).toBe(true)
    expect(belongsInWorkspaceList({ workspaceId: null, headless: false, originChannelId: null }, undefined)).toBe(true)
  })

  it('[CHAN-AC-9] a channel of another workspace is not listed', () => {
    expect(belongsInWorkspaceList({ workspaceId: 'ws_2', headless: false, originChannelId: null }, 'ws_1')).toBe(false)
    expect(belongsInWorkspaceList({ workspaceId: 'ws_2', headless: false, originChannelId: null }, null)).toBe(false)
  })

  it('[CHAN-AC-9] headless channels and sub-conversations are not listed', () => {
    expect(belongsInWorkspaceList({ workspaceId: 'ws_1', headless: true, originChannelId: null }, 'ws_1')).toBe(false)
    expect(belongsInWorkspaceList({ workspaceId: 'ws_1', headless: false, originChannelId: 'ch_parent' }, 'ws_1')).toBe(false)
  })

  it('[CHAN-AC-9] an event that does not say its workspace adds nothing', () => {
    expect(belongsInWorkspaceList({}, 'ws_1')).toBe(false)
    expect(belongsInWorkspaceList({}, null)).toBe(false)
    expect(isInWorkspace({}, null)).toBe(false)
  })

  it('[CHAN-AC-9] isInWorkspace ignores the kind of channel', () => {
    expect(isInWorkspace({ workspaceId: 'ws_1', headless: true, originChannelId: 'ch_p' }, 'ws_1')).toBe(true)
    expect(isInWorkspace({ workspaceId: 'ws_2' }, 'ws_1')).toBe(false)
  })
})
