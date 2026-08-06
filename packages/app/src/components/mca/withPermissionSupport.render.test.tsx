import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TamaguiProvider } from 'tamagui'
import config from '../../../tamagui.config'
import { MCA_STRINGS } from './primitives/strings'
import { PermissionContext, type ToolCallRendererProps } from './types'
import { withPermissionSupport } from './withPermissionSupport'

/**
 * TER-369 architectural invariant: a tool in `pending_permission` MUST surface
 * the Allow/Deny ControlsBar. The original bug auto-denied tools because the
 * widget never rendered — exactly what a unit test on the reducer could not
 * catch. This is a real cross-layer render assertion (the harness, TER-385).
 */
const DummyRenderer = (_props: ToolCallRendererProps) => null

function renderWrapped(props: Partial<ToolCallRendererProps>) {
  const Wrapped = withPermissionSupport(DummyRenderer)
  const callbacks = {
    onGrant: vi.fn(),
    onGrantAlways: vi.fn(),
    onDeny: vi.fn(),
    onDenyAlways: vi.fn(),
  }
  const result = render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <PermissionContext.Provider value={callbacks}>
        <Wrapped
          toolCallId="tc1"
          toolName="files-read"
          status="pending_permission"
          permissionRequestId="pr1"
          appId="app1"
          {...props}
        />
      </PermissionContext.Provider>
    </TamaguiProvider>,
  )
  return { ...result, callbacks }
}

describe('withPermissionSupport (render)', () => {
  it('renders the Allow/Deny ControlsBar on pending_permission', () => {
    const { getByLabelText } = renderWrapped({})
    expect(getByLabelText(MCA_STRINGS.permission.allow)).toBeTruthy()
    expect(getByLabelText(MCA_STRINGS.permission.deny)).toBeTruthy()
    expect(getByLabelText(MCA_STRINGS.permission.moreOptions)).toBeTruthy()
  })

  it('does NOT render the ControlsBar when status is not pending_permission', () => {
    const { queryByLabelText } = renderWrapped({ status: 'completed', permissionRequestId: undefined })
    expect(queryByLabelText(MCA_STRINGS.permission.allow)).toBeNull()
    expect(queryByLabelText(MCA_STRINGS.permission.deny)).toBeNull()
  })

  // Interaction layer (Testing Trophy): render ≠ behaviour. The TER-369 bug was
  // the widget not appearing; the next class of bug is "the button appears but
  // does nothing". Assert the click actually fires the grant/deny callback.
  it('fires onGrant when Allow is clicked', async () => {
    const user = userEvent.setup()
    const { getByLabelText, callbacks } = renderWrapped({})
    await user.click(getByLabelText(MCA_STRINGS.permission.allow))
    expect(callbacks.onGrant).toHaveBeenCalledTimes(1)
    expect(callbacks.onDeny).not.toHaveBeenCalled()
  })

  it('fires onDeny when Deny is clicked', async () => {
    const user = userEvent.setup()
    const { getByLabelText, callbacks } = renderWrapped({})
    await user.click(getByLabelText(MCA_STRINGS.permission.deny))
    expect(callbacks.onDeny).toHaveBeenCalledTimes(1)
    expect(callbacks.onGrant).not.toHaveBeenCalled()
  })
})
