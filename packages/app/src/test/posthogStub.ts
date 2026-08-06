/**
 * No-op stand-in for `posthog-react-native` in the render harness.
 *
 * The real package ships Flow-typed source that esbuild cannot parse
 * ("Unexpected token 'typeof'"), and it is only reached through
 * `lib/analytics` — whose client is null in tests anyway (no
 * EXPO_PUBLIC_POSTHOG_API_KEY). Mirrors the surface analytics.ts touches.
 */
export default class PostHog {
  constructor(_apiKey: string, _options?: Record<string, unknown>) {}
  capture(_event: string, _properties?: Record<string, unknown>): void {}
  identify(_distinctId: string, _properties?: Record<string, unknown>): void {}
  reset(): void {}
  flush(): Promise<void> {
    return Promise.resolve()
  }
}

export const PostHogProvider = ({ children }: { children?: unknown }) => children ?? null
