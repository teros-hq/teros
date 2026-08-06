import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TamaguiProvider } from 'tamagui'
import config from '../../../../tamagui.config'
import { PermissionContext, type PermissionContextValue } from '../types'
import { GroupedPermissionPanel, type GroupedPermissionTool } from './GroupedPermissionPanel'
import { MCA_STRINGS } from './strings'

function renderPanel(tools: GroupedPermissionTool[], withContext = true) {
  const callbacks: PermissionContextValue = {
    onGrant: vi.fn(),
    onGrantAlways: vi.fn(),
    onDeny: vi.fn(),
    onDenyAlways: vi.fn(),
  }
  const panel = <GroupedPermissionPanel tools={tools} />
  const result = render(
    <TamaguiProvider config={config} defaultTheme="dark">
      {withContext ? (
        <PermissionContext.Provider value={callbacks}>{panel}</PermissionContext.Provider>
      ) : (
        panel
      )}
    </TamaguiProvider>,
  )
  return { ...result, callbacks }
}

const REV1: GroupedPermissionTool = { requestId: 'r1', toolName: 'files-read', irreversible: false }
const REV2: GroupedPermissionTool = { requestId: 'r2', toolName: 'files-list', irreversible: false }
const IRREV: GroupedPermissionTool = { requestId: 'r3', toolName: 'files-delete', irreversible: true }

describe('GroupedPermissionPanel (render + TER-375 batch)', () => {
  it('renders one row per tool plus the bulk actions', () => {
    const { getByText, getByLabelText } = renderPanel([REV1, REV2, IRREV])
    expect(getByText(MCA_STRINGS.permissionGroup.awaiting(3))).toBeTruthy()
    expect(getByText('files-read')).toBeTruthy()
    expect(getByText('files-delete')).toBeTruthy()
    expect(getByLabelText(MCA_STRINGS.permissionGroup.denyAll)).toBeTruthy()
    expect(getByLabelText(MCA_STRINGS.permissionGroup.allowAll)).toBeTruthy()
  })

  // The safety guarantee of TER-375: "Allow all" must never grant an irreversible
  // tool — those stay pending and keep their own row (fail-closed).
  it('Allow all grants only the reversible tools, never the irreversible one', async () => {
    const user = userEvent.setup()
    const { getByLabelText, callbacks } = renderPanel([REV1, REV2, IRREV])
    await user.click(getByLabelText(MCA_STRINGS.permissionGroup.allowAll))
    expect(callbacks.onGrant).toHaveBeenCalledTimes(2)
    expect(callbacks.onGrant).toHaveBeenCalledWith('r1')
    expect(callbacks.onGrant).toHaveBeenCalledWith('r2')
    expect(callbacks.onGrant).not.toHaveBeenCalledWith('r3')
  })

  it('Deny all denies every tool in the batch, including the irreversible one', async () => {
    const user = userEvent.setup()
    const { getByLabelText, callbacks } = renderPanel([REV1, REV2, IRREV])
    await user.click(getByLabelText(MCA_STRINGS.permissionGroup.denyAll))
    expect(callbacks.onDeny).toHaveBeenCalledTimes(3)
    expect(callbacks.onDeny).toHaveBeenCalledWith('r1')
    expect(callbacks.onDeny).toHaveBeenCalledWith('r2')
    expect(callbacks.onDeny).toHaveBeenCalledWith('r3')
  })

  it('hides Allow all when every tool is irreversible', () => {
    const { queryByLabelText, getByLabelText } = renderPanel([
      IRREV,
      { requestId: 'r4', toolName: 'rm', irreversible: true },
    ])
    expect(queryByLabelText(MCA_STRINGS.permissionGroup.allowAll)).toBeNull()
    expect(getByLabelText(MCA_STRINGS.permissionGroup.denyAll)).toBeTruthy()
  })

  it('per-row Allow grants only that one tool', async () => {
    const user = userEvent.setup()
    const { getAllByLabelText, callbacks } = renderPanel([REV1, REV2, IRREV])
    // Per-row buttons are labelled "Allow" (exact); the bulk button is "Allow all".
    const rowAllow = getAllByLabelText(MCA_STRINGS.permission.allow)
    expect(rowAllow).toHaveLength(3)
    await user.click(rowAllow[0])
    expect(callbacks.onGrant).toHaveBeenCalledTimes(1)
    expect(callbacks.onGrant).toHaveBeenCalledWith('r1')
  })

  // TER-369 fail-loud: a panel mounted without the PermissionContext must throw in
  // dev (rather than silently render no approval UI → tools auto-denied in 60s).
  // __DEV__ is `true` in the harness (vitest.config define).
  it('throws in dev when mounted without PermissionContext', () => {
    expect(() => renderPanel([REV1], false)).toThrow(/PermissionContext/)
  })
})
