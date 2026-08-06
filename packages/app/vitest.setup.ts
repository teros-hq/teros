import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// jsdom lacks matchMedia; Tamagui reads it at module load.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
})

// jsdom's requestAnimationFrame fires recursively; RN-Web's Animated loop then
// keeps the event loop alive and hangs the worker. No-op rAF so animations
// never tick (render tests assert structure, not motion).
globalThis.requestAnimationFrame = (() => 0) as unknown as typeof requestAnimationFrame
globalThis.cancelAnimationFrame = (() => {}) as unknown as typeof cancelAnimationFrame

// Native-only modules with no jsdom/web equivalent → stub by PACKAGE NAME
// (unambiguous regardless of importer location). Expo/Sentry/native modules
// build a Proxy over the native binding, which is undefined in jsdom →
// "Cannot create proxy with a non-object".
vi.mock('@sentry/react-native', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  setUser: vi.fn(),
  setTag: vi.fn(),
  addBreadcrumb: vi.fn(),
  wrap: (c: unknown) => c,
}))
vi.mock('expo-constants', () => ({
  default: { expoConfig: { extra: {} }, executionEnvironment: 'storeClient' },
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {}),
  },
}))
// expo-secure-store / expo-localization build an EventEmitter over expo-modules-core,
// whose native binding is undefined in jsdom ("reading 'EventEmitter'"). Reached via
// services/storage (authStore) e i18n (getLocales/getCalendars). Stub by package name.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => {}),
  deleteItemAsync: vi.fn(async () => {}),
  isAvailableAsync: vi.fn(async () => false),
}))
// expo-keep-awake reaches expo-modules-core's EventEmitter the same way.
// Reached via hooks/useWakeLock (VoiceSessionContext).
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: vi.fn(async () => {}),
  deactivateKeepAwake: vi.fn(async () => {}),
}))
vi.mock('expo-localization', () => ({
  getLocales: () => [{ languageCode: 'en', languageTag: 'en-US', regionCode: 'US', textDirection: 'ltr' }],
  getCalendars: () => [{ timeZone: 'UTC' }],
  locale: 'en-US',
  locales: ['en-US'],
}))
// MarkdownContent imports WebView as a DEFAULT and uses it at module load
// (tableConfig), so the mock must expose `default` too (HtmlBubble only used the
// named export). Additive — existing tests unaffected.
vi.mock('react-native-webview', () => {
  const WebView = () => null
  return { default: WebView, WebView }
})
// NOTE on phosphor-react-native: a `vi.mock` here does NOT prevent the hang — the
// package is externalized, so node imports the real 1000-icon graph before any
// mock applies. It is instead cut at resolve time by redirecting the SOURCE icon
// barrel (primitives/icons.ts) to src/test/iconsStub.tsx via the stub-mca-icons
// plugin in vitest.config.ts. Components importing phosphor directly (bypassing
// the barrel) would need their own redirect.

afterEach(() => cleanup())
