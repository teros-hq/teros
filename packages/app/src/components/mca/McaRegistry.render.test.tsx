import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TamaguiProvider, Text } from 'tamagui'
import config from '../../../tamagui.config'
import { McaRegistry } from './McaRegistry'
import { MCA_STRINGS } from './primitives/strings'
import { PermissionContext, type PermissionContextValue, type ToolCallRendererProps } from './types'

// A renderer composing NEITHER ToolCallCard NOR ControlsBar — the exact shape of
// the TER-369 bug (renderers built from low-level primitives). The registry must
// STILL surface the Allow/Deny ControlsBar on `pending_permission`, because
// `register()` wraps every renderer in `withPermissionSupport` centrally. This is
// the system-level invariant the strategy doc asks for: "every registered renderer
// shows the ControlsBar on pending_permission — would have caught TER-369".
function NakedRenderer(props: ToolCallRendererProps) {
  return <Text>naked:{props.toolName}</Text>
}

function renderFromRegistry(mcaId: string, props: Partial<ToolCallRendererProps> = {}) {
  const callbacks: PermissionContextValue = {
    onGrant: vi.fn(),
    onGrantAlways: vi.fn(),
    onDeny: vi.fn(),
    onDenyAlways: vi.fn(),
  }
  const Renderer = McaRegistry.getToolCallRendererByMcpId(mcaId)
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <PermissionContext.Provider value={callbacks}>
        <Renderer
          toolCallId="tc1"
          toolName="naked-tool"
          status="pending_permission"
          permissionRequestId="pr1"
          appId="app1"
          {...props}
        />
      </PermissionContext.Provider>
    </TamaguiProvider>,
  )
}

describe('McaRegistry — ControlsBar invariant on pending_permission (TER-369)', () => {
  afterEach(() => {
    McaRegistry.clear()
    McaRegistry.clearWarnings()
  })

  it('a registered renderer using neither ToolCallCard nor ControlsBar still shows it', () => {
    McaRegistry.register({
      mcaId: 'mca.test.naked',
      name: 'Naked',
      toolNames: ['naked-tool'],
      ToolCallRenderer: NakedRenderer,
    })
    const { getByText, getByLabelText } = renderFromRegistry('mca.test.naked')
    expect(getByText(/naked:/)).toBeTruthy() // the bare renderer rendered
    // ...and the registry's central wrap surfaced the approval UI regardless:
    expect(getByLabelText(MCA_STRINGS.permission.allow)).toBeTruthy()
    expect(getByLabelText(MCA_STRINGS.permission.deny)).toBeTruthy()
  })

  it('the default renderer (no custom registered) also shows the ControlsBar on pending', () => {
    const { getByLabelText } = renderFromRegistry('mca.unregistered.none')
    expect(getByLabelText(MCA_STRINGS.permission.allow)).toBeTruthy()
  })

  it('does NOT show the ControlsBar when status is not pending_permission', () => {
    McaRegistry.register({
      mcaId: 'mca.test.naked2',
      name: 'Naked2',
      toolNames: ['naked-tool'],
      ToolCallRenderer: NakedRenderer,
    })
    const { queryByLabelText } = renderFromRegistry('mca.test.naked2', {
      status: 'completed',
      permissionRequestId: undefined,
    })
    expect(queryByLabelText(MCA_STRINGS.permission.allow)).toBeNull()
  })
})
