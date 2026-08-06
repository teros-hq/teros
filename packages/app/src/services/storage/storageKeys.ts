/**
 * storageKeys.ts
 *
 * Registro centralizado de todas las claves de storage y su dominio semántico.
 * El dominio determina qué driver usa cada clave (ver StorageRegistry).
 *
 * Dominios:
 *   auth          → localStorage / SecureStore. Sobrevive entre sesiones y tabs.
 *   user-settings → localStorage / AsyncStorage. Preferencias globales del usuario.
 *                   Candidatas a sincronizarse con el backend en el futuro.
 *   ui-state      → localStorage / AsyncStorage. Estado de UI que aplica a todas las tabs.
 *   tab-state     → sessionStorage / InMemory. Estado por-tab, muere al cerrar la tab.
 *   persisted     → PersistedDriver (backend WS). Sincronizado entre dispositivos.
 */

export const STORAGE_KEYS = {
  // ── auth ──────────────────────────────────────────────────────────────────
  AUTH:                 'teros-auth',

  // ── user settings ─────────────────────────────────────────────────────────
  NAVBAR_EXPANDED:      'teros_navbar_expanded',
  VIM_MODE:             'code-editor:vim-mode',
  SHOW_SUB_CONVS:       'teros:show-sub-conversations',
  GETTING_STARTED:      'teros-getting-started-dismissed',

  // ── ui state ──────────────────────────────────────────────────────────────
  MESSAGE_DRAFTS:              'teros_message_drafts',
  LAST_ACTIVE_WORKSPACE:       'teros_last_active_workspace_id',
  LAST_ACTIVE_DESKTOP_INDEX:   'teros_last_active_desktop_index',

  // ── tab state ─────────────────────────────────────────────────────────────
  ACTIVE_WORKSPACE:     'teros_active_workspace_id',
  ACTIVE_DESKTOP_INDEX: 'teros_active_desktop_index',
  VOICE_SESSION:        'teros_voice_session',

  // ── persisted (backend WS, por workspaceId) ───────────────────────────────
  WORKSPACE_LAYOUT:     'teros_workspace_layout',
} as const

export type StorageKey = typeof STORAGE_KEYS[keyof typeof STORAGE_KEYS]

export type StorageDomain = 'auth' | 'user-settings' | 'ui-state' | 'tab-state' | 'persisted'

/**
 * Mapeo explícito clave → dominio.
 * TypeScript obliga a declarar el dominio de cada clave nueva. Si falta una, no compila.
 */
export const KEY_DOMAIN: Record<StorageKey, StorageDomain> = {
  [STORAGE_KEYS.AUTH]:                 'auth',
  [STORAGE_KEYS.NAVBAR_EXPANDED]:      'user-settings',
  [STORAGE_KEYS.VIM_MODE]:             'user-settings',
  [STORAGE_KEYS.SHOW_SUB_CONVS]:       'user-settings',
  [STORAGE_KEYS.GETTING_STARTED]:      'user-settings',
  [STORAGE_KEYS.MESSAGE_DRAFTS]:              'ui-state',
  [STORAGE_KEYS.LAST_ACTIVE_WORKSPACE]:       'ui-state',
  [STORAGE_KEYS.LAST_ACTIVE_DESKTOP_INDEX]:   'ui-state',
  [STORAGE_KEYS.ACTIVE_WORKSPACE]:            'tab-state',
  [STORAGE_KEYS.ACTIVE_DESKTOP_INDEX]:        'tab-state',
  [STORAGE_KEYS.VOICE_SESSION]:        'tab-state',
  [STORAGE_KEYS.WORKSPACE_LAYOUT]:     'persisted',
}
