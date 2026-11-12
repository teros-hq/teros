/**
 * Render test for the `show-app-auth` inline auth widget (TerosCoreRenderer).
 *
 * The widget IS the feature: the tool result renders in the chat with the
 * app's auth status and a Connect/Reconnect button that drives the OAuth
 * popup (`client.connectAppOAuth`) right there. We pin:
 *   - expired OAuth → chip "expired" + backend message + Reconnect button;
 *   - pressing Reconnect calls connectAppOAuth(appId) and re-reads the live
 *     status, flipping the widget to "connected" without the button;
 *   - the on-mount live refresh wins over a stale result (old messages);
 *   - apikey apps don't get an OAuth button — they get "Open app settings"
 *     which opens the app window (credentials form doesn't live in chat).
 */

import '../../../i18n' // initialize i18next (en-US via mocked expo-localization)
import { render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TamaguiProvider } from 'tamagui'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import config from '../../../../tamagui.config'
import type { ToolCallRendererProps } from '../types'

const h = vi.hoisted(() => ({
  connectAppOAuth: vi.fn(),
  disconnectAuth: vi.fn(),
  configureCredentials: vi.fn(),
  getAuthStatus: vi.fn(),
  openWindow: vi.fn(),
}))

vi.mock('../../../services/terosClientSingleton', () => ({
  getTerosClient: () => ({
    connectAppOAuth: h.connectAppOAuth,
    app: {
      getAuthStatus: h.getAuthStatus,
      disconnectAuth: h.disconnectAuth,
      configureCredentials: h.configureCredentials,
    },
  }),
}))

vi.mock('../../../store/tilingStore', () => ({
  useTilingStore: { getState: () => ({ openWindow: h.openWindow }) },
}))

import { TerosCoreToolCallRenderer } from './TerosCoreRenderer'

const EXPIRED = {
  status: 'expired',
  authType: 'oauth2',
  message: 'Session expired, reconnect account',
}
const READY = { status: 'ready', authType: 'oauth2', message: 'Connected' }

function authStatusResponse(auth: unknown) {
  return { appId: 'app_gmail', auth }
}

function renderTool(props: Partial<ToolCallRendererProps> = {}) {
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <TerosCoreToolCallRenderer
        toolCallId="tc1"
        toolName="show-app-auth"
        status="completed"
        input={{ appId: 'app_gmail' }}
        output={JSON.stringify({
          displayed: true,
          appId: 'app_gmail',
          appName: 'gmail',
          auth: EXPIRED,
        })}
        {...props}
      />
    </TamaguiProvider>,
  )
}

beforeEach(() => {
  h.connectAppOAuth.mockReset().mockResolvedValue({ success: true })
  h.disconnectAuth.mockReset().mockResolvedValue({ appId: 'app_gmail', success: true })
  h.configureCredentials.mockReset().mockResolvedValue({ appId: 'app_gmail', success: true })
  h.getAuthStatus.mockReset().mockResolvedValue(authStatusResponse(EXPIRED))
  h.openWindow.mockReset()
})

describe('ShowAppAuthRenderer — inline auth widget', () => {
  it('renders the expired state with message and Reconnect button', async () => {
    const { getByText, findByText } = renderTool()

    expect(getByText('gmail')).toBeTruthy()
    await findByText('expired')
    await findByText('Session expired, reconnect account')
    await findByText('Reconnect gmail')
  })

  it('Reconnect drives the OAuth popup and flips to connected', async () => {
    const user = userEvent.setup()
    const { findByText, queryByText } = renderTool()

    const button = await findByText('Reconnect gmail')
    // After the popup resolves, the live status is re-read and comes back ready.
    h.getAuthStatus.mockResolvedValue(authStatusResponse(READY))
    await user.click(button)

    expect(h.connectAppOAuth).toHaveBeenCalledWith('app_gmail')
    await findByText('connected')
    await waitFor(() => expect(queryByText('Reconnect gmail')).toBeNull())
  })

  it('shows the OAuth error inline and keeps the button when the popup fails', async () => {
    const user = userEvent.setup()
    h.connectAppOAuth.mockRejectedValue(new Error('OAuth cancelled — popup was closed'))
    const { findByText } = renderTool()

    await user.click(await findByText('Reconnect gmail'))

    await findByText('OAuth cancelled — popup was closed')
    await findByText('Reconnect gmail')
  })

  it('the on-mount live refresh wins over a stale result', async () => {
    // Result says expired (old message) but the live status is already ready.
    h.getAuthStatus.mockResolvedValue(authStatusResponse(READY))
    const { findByText, queryByText } = renderTool()

    await findByText('connected')
    await waitFor(() => expect(queryByText('Reconnect gmail')).toBeNull())
  })

  it('check-app-auth renders an informational snapshot with no connect button', async () => {
    const user = userEvent.setup()
    const { findByText, getByText, queryByText } = render(
      <TamaguiProvider config={config} defaultTheme="dark">
        <TerosCoreToolCallRenderer
          toolCallId="tc2"
          toolName="check-app-auth"
          status="completed"
          input={{ appId: 'app_gmail' }}
          output={JSON.stringify({
            appId: 'app_gmail',
            appName: 'gmail',
            mcaId: 'mca.google.gmail',
            auth: EXPIRED,
          })}
        />
      </TamaguiProvider>,
    )

    // Outcome badge is visible even with the card collapsed.
    await findByText('session expired')
    // Expand via the header to check the body snapshot.
    await user.click(await findByText('Checked gmail connection'))

    await findByText('expired')
    expect(getByText('Session expired, reconnect account')).toBeTruthy()
    // Snapshot only: no action button and no live re-read of the status.
    expect(queryByText('Reconnect gmail')).toBeNull()
    expect(h.getAuthStatus).not.toHaveBeenCalled()
  })

  it('apikey apps without declared variables keep "Open app settings"', async () => {
    const APIKEY = { status: 'needs_user_auth', authType: 'apikey', message: 'API key required' }
    h.getAuthStatus.mockResolvedValue(authStatusResponse(APIKEY))
    const user = userEvent.setup()
    const { findByText } = renderTool({
      output: JSON.stringify({ displayed: true, appId: 'app_keyed', appName: 'keyed', auth: APIKEY }),
      input: { appId: 'app_keyed' },
    })

    await user.click(await findByText('Open app settings'))

    expect(h.openWindow).toHaveBeenCalledWith('app', { appId: 'app_keyed' })
    expect(h.connectAppOAuth).not.toHaveBeenCalled()
  })

  it('apikey apps with variables show the expandable Variables section with set/empty state', async () => {
    // mca.teros.http shape: 8 userSecrets, some already set (isSet from the
    // backend — presence only, never the value).
    const APIKEY = {
      status: 'ready',
      authType: 'apikey',
      apikey: {
        configured: true,
        fields: [
          { name: 'HUNTER_API_KEY', label: 'Hunter Api Key', type: 'password', required: true, isSet: true },
          { name: 'BREVO_API_KEY', label: 'Brevo Api Key', type: 'password', required: true, isSet: false },
          { name: 'MAKE_WEBHOOK_TOKEN', label: 'Make Webhook Token', type: 'password', required: true, isSet: true },
        ],
      },
    }
    h.getAuthStatus.mockResolvedValue(authStatusResponse(APIKEY))
    const user = userEvent.setup()
    const { findByText } = renderTool({
      output: JSON.stringify({ displayed: true, appId: 'app_http', appName: 'http', auth: APIKEY }),
      input: { appId: 'app_http' },
    })

    // Connected apikey app: Disconnect available, variables summary visible.
    await findByText('Disconnect http')
    await findByText('Variables (2/3 set)')

    // Expand and check per-variable state chips.
    await user.click(await findByText('Variables (2/3 set)'))
    await findByText('Hunter Api Key')
    await findByText('Brevo Api Key')
    await findByText('Make Webhook Token')
    // 2 set + 1 empty chips (the summary line also contains "set" but the
    // chips render as standalone IconChip texts).
    await findByText('empty')
  })

  it('a variable can be set from the widget: masked input saves via configure-credentials', async () => {
    const APIKEY = {
      status: 'needs_user_auth',
      authType: 'apikey',
      apikey: {
        configured: false,
        fields: [
          { name: 'HUNTER_API_KEY', label: 'Hunter Api Key', type: 'password', required: true, isSet: false },
        ],
      },
    }
    h.getAuthStatus.mockResolvedValue(authStatusResponse(APIKEY))
    const user = userEvent.setup()
    const { findByText, findByPlaceholderText, findByLabelText, queryByText } = renderTool({
      output: JSON.stringify({ displayed: true, appId: 'app_http', appName: 'http', auth: APIKEY }),
      input: { appId: 'app_http' },
    })

    // Expand the Variables section — unset variables start in edit mode
    // with a masked input.
    await user.click(await findByText('Variables (0/1 set)'))
    const input = await findByPlaceholderText('Paste value…')
    await user.type(input, 'hunter-secret-123')
    await user.click(await findByLabelText('Save Hunter Api Key'))

    // Partial merge: ONLY the edited key travels to the backend.
    await waitFor(() => expect(h.configureCredentials).toHaveBeenCalledTimes(1))
    expect(h.configureCredentials).toHaveBeenCalledWith('app_http', { HUNTER_API_KEY: 'hunter-secret-123' })
    // The value is never rendered as text in the conversation.
    expect(queryByText('hunter-secret-123')).toBeNull()
  })

  it('disconnect on an apikey app asks for confirmation and revokes credentials', async () => {
    const APIKEY = {
      status: 'ready',
      authType: 'apikey',
      apikey: {
        configured: true,
        fields: [
          { name: 'HUNTER_API_KEY', label: 'Hunter Api Key', type: 'password', required: true, isSet: true },
        ],
      },
    }
    h.getAuthStatus.mockResolvedValue(authStatusResponse(APIKEY))
    const user = userEvent.setup()
    const { findByText } = renderTool({
      output: JSON.stringify({ displayed: true, appId: 'app_http', appName: 'http', auth: APIKEY }),
      input: { appId: 'app_http' },
    })

    await user.click(await findByText('Disconnect http'))
    // ConfirmDialog first — no revoke before the user confirms.
    expect(h.disconnectAuth).not.toHaveBeenCalled()
    await user.click(await findByText('Confirm'))

    await waitFor(() => expect(h.disconnectAuth).toHaveBeenCalledWith('app_http'))
  })
})
