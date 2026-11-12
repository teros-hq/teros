import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TamaguiProvider, Text } from 'tamagui'
import type { ReactElement } from 'react'
import config from '../../../tamagui.config'
import { PermissionContext, type ToolCallRendererProps } from './types'
import { withPermissionSupport } from './withPermissionSupport'
import i18n from '../../i18n'

const tr = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts) as string

const useToolDetails = vi.hoisted(() => vi.fn())
vi.mock('../../hooks/mca/useToolDetails', () => ({
  useToolDetails: (...args: unknown[]) => useToolDetails(...args),
  toolDetailsCache: { reset: () => {} },
}))

// Wraps a pre-built <Wrapped .../> element in the same TamaguiProvider +
// PermissionContext.Provider as renderWrapped() above, for tests that need
// to pass ad-hoc props (e.g. input, mcaId) not covered by renderWrapped's
// fixed default set.
function renderWithPermissionContext(ui: ReactElement) {
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <PermissionContext.Provider
        value={{ onGrant: vi.fn(), onGrantAlways: vi.fn(), onDeny: vi.fn(), onDenyAlways: vi.fn() }}
      >
        {ui}
      </PermissionContext.Provider>
    </TamaguiProvider>,
  )
}

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
  // PermissionDetail (mounted below) calls useToolDetails unconditionally
  // while pending. Give every test a sane default so the pre-existing cases
  // (which don't care about tool metadata) don't have to know it exists;
  // individual new cases below override this per-test.
  beforeEach(() => {
    useToolDetails.mockReturnValue({ details: {}, loading: false, failed: false })
  })

  it('renders the Allow/Deny ControlsBar on pending_permission', async () => {
    const { getByLabelText } = renderWrapped({})
    // Tamagui's first mount is expensive; in CI (shared runners) the initial
    // render commit may not complete synchronously. waitFor ensures the
    // aria-labels are in the DOM before asserting.
    await waitFor(() => expect(getByLabelText(tr("mca.permission.allow"))).toBeTruthy())
    expect(getByLabelText(tr("mca.permission.deny"))).toBeTruthy()
    // Since 734a9a2dc the ControlsBar shows all 4 actions inline — the old
    // "More permission options" overflow menu was removed.
    expect(getByLabelText(tr("mca.permission.allowAlways"))).toBeTruthy()
    expect(getByLabelText(tr("mca.permission.denyAlways"))).toBeTruthy()
  })

  it('does NOT render the ControlsBar when status is not pending_permission', () => {
    const { queryByLabelText } = renderWrapped({ status: 'completed', permissionRequestId: undefined })
    expect(queryByLabelText(tr("mca.permission.allow"))).toBeNull()
    expect(queryByLabelText(tr("mca.permission.deny"))).toBeNull()
  })

  // v4 permission cut (2026-10-27): the ask ends the turn with the
  // `permission_requested` JSON marker as the tool result, so the message
  // settles as `completed` and the content's permissionRequestId is DROPPED
  // (completeToolMessage rebuilds it). The marker in the OUTPUT is then the
  // only anchor the HOC has — same mechanic as FormWidget's form_displayed.
  // This is the regression test for the inline card never rendering (the
  // badge jumped in the navbar but the chat showed nothing).
  it('renders the ControlsBar on completed + permission_requested marker in the output', async () => {
    const markerOutput = JSON.stringify({
      status: 'permission_requested',
      permissionRequestId: 'perm_mk1',
      tool: 'files-read',
      appId: 'app1',
      irreversible: false,
      instruction: 'The approval request is now shown to the user.',
    })
    const { getByLabelText, queryByText } = renderWrapped({
      status: 'completed',
      output: markerOutput,
      permissionRequestId: undefined,
    })
    await waitFor(() => expect(getByLabelText(tr("mca.permission.allow"))).toBeTruthy())
    expect(getByLabelText(tr("mca.permission.deny"))).toBeTruthy()
    expect(getByLabelText(tr("mca.permission.allowAlways"))).toBeTruthy()
    expect(getByLabelText(tr("mca.permission.denyAlways"))).toBeTruthy()
    // The marker JSON is the renderer's OUTPUT — it must not leak into the
    // card body as raw text now that the HOC intercepts it.
    expect(queryByText(/permission_requested/)).toBeNull()
  })

  it('does NOT render the ControlsBar on completed without a marker (a genuinely settled tool)', () => {
    const { queryByLabelText } = renderWrapped({
      status: 'completed',
      output: '{"ok":true}',
      permissionRequestId: undefined,
    })
    expect(queryByLabelText(tr("mca.permission.allow"))).toBeNull()
    expect(queryByLabelText(tr("mca.permission.deny"))).toBeNull()
  })

  it('does NOT render the ControlsBar for a corrupt marker output', () => {
    const { queryByLabelText } = renderWrapped({
      status: 'completed',
      output: '{"status":"permission_requested","permissionRequestId":',
      permissionRequestId: undefined,
    })
    expect(queryByLabelText(tr("mca.permission.allow"))).toBeNull()
    expect(queryByLabelText(tr("mca.permission.deny"))).toBeNull()
  })

  // Interaction: the marker's requestId must reach grant/deny — the
  // useChatPermissions map is keyed on requestId, a stale/absent one would
  // silently no-op the click.
  it('fires onGrant with the MARKER requestId when Allow is clicked on a completed+marker tool', async () => {
    const user = userEvent.setup()
    const { getByLabelText, callbacks } = renderWrapped({
      status: 'completed',
      output: JSON.stringify({
        status: 'permission_requested',
        permissionRequestId: 'perm_mk2',
        tool: 'files-read',
        appId: 'app1',
      }),
      permissionRequestId: undefined,
    })
    await user.click(getByLabelText(tr("mca.permission.allow")))
    expect(callbacks.onGrant).toHaveBeenCalledWith('perm_mk2')
  })

  // Interaction layer (Testing Trophy): render ≠ behaviour. The TER-369 bug was
  // the widget not appearing; the next class of bug is "the button appears but
  // does nothing". Assert the click actually fires the grant/deny callback.
  it('fires onGrant when Allow is clicked', async () => {
    const user = userEvent.setup()
    const { getByLabelText, callbacks } = renderWrapped({})
    await user.click(getByLabelText(tr("mca.permission.allow")))
    expect(callbacks.onGrant).toHaveBeenCalledTimes(1)
    expect(callbacks.onDeny).not.toHaveBeenCalled()
  })

  it('fires onDeny when Deny is clicked', async () => {
    const user = userEvent.setup()
    const { getByLabelText, callbacks } = renderWrapped({})
    await user.click(getByLabelText(tr("mca.permission.deny")))
    expect(callbacks.onDeny).toHaveBeenCalledTimes(1)
    expect(callbacks.onGrant).not.toHaveBeenCalled()
  })

  // This fixture mounts NO ToolCallCard, so nothing claims the detail slot and
  // the HOC renders it itself in a card-shaped wrapper. That is the path the four
  // real non-card renderers take (BrowserbaseRenderer, notion/UploadFileRenderer,
  // drive/FoldersRenderer, drive/SharingRenderer). In-card placement — what ~50
  // renderers get — is covered by permission-detail-placement.render.test.tsx.
  it('renders PermissionDetail via the non-card fallback while pending', () => {
    useToolDetails.mockReturnValue({
      details: {
        'mydrive_share-file': {
          requestedName: 'mydrive_share-file',
          name: 'share-file',
          description: 'Grant another account access to a Drive file.',
          parameters: {
            type: 'object',
            properties: { fileId: { type: 'string', description: 'Target file.' } },
            required: ['fileId'],
          },
        },
      },
      loading: false,
      failed: false,
    })

    const Wrapped = withPermissionSupport(() => null)
    renderWithPermissionContext(
      <Wrapped
        toolCallId="tc1"
        toolName="mydrive_share-file"
        appId="a1"
        status="pending_permission"
        permissionRequestId="perm_1"
        input={{ fileId: 'f1' }}
      />,
    )

    expect(screen.getByText('Grant another account access to a Drive file.')).toBeTruthy()
    expect(screen.getByText('fileId')).toBeTruthy()
    expect(screen.getByText('Awaiting your approval')).toBeTruthy()
    // The fallback wrapper, not a bare block on the chat background.
    expect(screen.getByTestId('permission-detail-fallback')).toBeTruthy()
  })

  it('keeps the ControlsBar interactive while tool metadata is still loading', () => {
    useToolDetails.mockReturnValue({ details: {}, loading: true, failed: false })

    const Wrapped = withPermissionSupport(() => null)
    renderWithPermissionContext(
      <Wrapped
        toolCallId="tc1"
        toolName="mydrive_share-file"
        appId="a1"
        status="pending_permission"
        permissionRequestId="perm_1"
        input={{ fileId: 'f1' }}
      />,
    )

    expect(screen.getByText('Awaiting your approval')).toBeTruthy()
    expect(screen.getByText('Allow')).toBeTruthy()
  })

  it('keeps the ControlsBar interactive after a failed metadata fetch', () => {
    useToolDetails.mockReturnValue({ details: {}, loading: false, failed: true })

    const Wrapped = withPermissionSupport(() => null)
    renderWithPermissionContext(
      <Wrapped
        toolCallId="tc1"
        toolName="mydrive_share-file"
        appId="a1"
        status="pending_permission"
        permissionRequestId="perm_1"
        input={{ fileId: 'f1' }}
      />,
    )

    expect(screen.getByText('Awaiting your approval')).toBeTruthy()
    expect(screen.getByText('fileId')).toBeTruthy()
  })

  it('does not render PermissionDetail for a completed tool', () => {
    useToolDetails.mockReturnValue({ details: {}, loading: false, failed: false })

    const Wrapped = withPermissionSupport(() => null)
    renderWithPermissionContext(
      <Wrapped
        toolCallId="tc1"
        toolName="mydrive_share-file"
        appId="a1"
        status="completed"
        input={{ fileId: 'f1' }}
      />,
    )

    expect(screen.queryByText('fileId')).toBeNull()
  })

  // Review finding (Important, fix round 1): getShortToolName("_") and
  // humanizeLabel both collapse "_" to "", so without humanToolLabel's
  // `|| toolName` fallback, PermissionDetail's required fallbackText would be
  // a blank string. resolveIntent's guard only rejects non-string fallbackText,
  // not blank ones, so a blank fallback renders silently rather than throwing.
  it('falls back to the raw tool name so the intent line is never blank for toolName="_"', () => {
    useToolDetails.mockReturnValue({ details: {}, loading: false, failed: false })

    const Wrapped = withPermissionSupport(() => null)
    renderWithPermissionContext(
      <Wrapped
        toolCallId="tc1"
        toolName="_"
        appId="a1"
        status="pending_permission"
        permissionRequestId="perm_1"
      />,
    )

    // The intent line falls back to the humanized tool label. Assert the
    // exact text so the fallback's actual contribution (the raw toolName,
    // "_") is what the test pins — not just "non-empty".
    expect(screen.getByTestId('permission-detail-intent').textContent).toBe('_')
  })

  // `resolveIntent` throws on a falsy toolName, and there is NO error boundary
  // between this tree and the chat root — so an unguarded '' would blank the
  // conversation and leave the user unable to approve or deny anything.
  // `ToolExecutionMessageContentSchema` types toolName as `z.string()`, which
  // accepts ''. The grouped path normalises this in buildGroupedTool; this card
  // path must agree, or one schema-valid payload takes down one of the two
  // decision surfaces. Previously this test asserted the throw, pinning the
  // app-blanking failure mode as intended behavior.
  it('renders a usable card for an empty toolName instead of crashing the chat', () => {
    useToolDetails.mockReturnValue({ details: {}, loading: false, failed: false })

    const Wrapped = withPermissionSupport(() => null)
    expect(() =>
      renderWithPermissionContext(
        <Wrapped
          toolCallId="tc1"
          toolName=""
          appId="a1"
          status="pending_permission"
          permissionRequestId="perm_1"
        />,
      ),
    ).not.toThrow()

    // The controls must still be reachable — that is the whole point of not throwing.
    expect(screen.getByTestId('permission-detail-intent').textContent).toBe('Unknown')
    expect(screen.getByTestId('permission-detail')).toBeTruthy()
  })
})
