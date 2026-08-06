import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TamaguiProvider } from 'tamagui'
import config from '../../../../tamagui.config'
import { ControlsBar } from './ControlsBar'

// withPermissionSupport.render.test.tsx already covers the happy path (the HOC
// mounts ControlsBar on pending_permission, it shows Allow/Deny, and the buttons
// fire onGrant/onDeny). This pins the other half — the TER-369 fail-loud guard:
// mounted without a PermissionContext, ControlsBar must THROW in dev instead of
// silently rendering nothing. Silent render is the TER-369 incident itself — the
// approval UI disappears and the tool auto-denies after 60s.
describe('ControlsBar — fail-loud guard (TER-369)', () => {
  it('throws in dev when mounted without a PermissionContext above it', () => {
    expect(() =>
      render(
        <TamaguiProvider config={config} defaultTheme="dark">
          <ControlsBar permissionRequestId="pr_1" appId="app_1" toolName="files-read" />
        </TamaguiProvider>,
      ),
    ).toThrow(/PermissionContext/)
  })
})
