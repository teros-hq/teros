/**
 * Apps Components
 *
 * Components for app management and configuration UI.
 */

// Legacy components (kept for backwards compatibility)
export {
  AppAuthBadge,
  type AppAuthInfo,
  AppAuthStatusDetail,
  type AppCredentialStatus,
  type McaAuthType,
} from './AppAuthBadge';
export {
  AppConfigPanel,
  type AppConfigPanelProps,
  type AppPermissionsData,
  type ToolPermission,
  type ToolWithPermission,
} from './AppConfigPanel';
export {
  AppPermissions,
  type AppPermissionsData as LegacyAppPermissionsData,
  type ToolPermission as LegacyToolPermission,
  type ToolWithPermission as LegacyToolWithPermission,
} from './AppPermissions';

// New panel components (v2)
export {
  AuthPanel,
  type AuthPanelProps,
  type CredentialField,
  type OAuthInfo,
  type OAuthStatus,
} from './AuthPanel';

export {
  PermissionsPanel,
  type PermissionsPanelProps,
  type ToolPermission as PermissionToolPermission,
  type ToolWithPermission as PermissionToolWithPermission,
} from './PermissionsPanel';
