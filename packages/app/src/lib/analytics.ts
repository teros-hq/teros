/**
 * PostHog product analytics for the Teros app (web PWA + native).
 *
 * Mirrors the `sentry.ts` pattern: a no-op when no key is configured, gated to
 * production (or an explicit dev flag), and the SDK import lives in ONE place so
 * call sites stay clean. Eventos de dominio se emiten con `track()` desde stores
 * y servicios (fuera de React); el `PostHogProvider` (en app/_layout.tsx) recibe
 * esta misma instancia vía `client=` y aporta autocapture de pantallas.
 *
 * Best-effort por construcción: los wrappers TRAGAN cualquier error del SDK
 * (`@posthog/core` re-lanza síncrono en el path enabled+initialized) — analytics
 * NUNCA debe romper un flujo de producto (login, envío de mensaje, etc.).
 *
 * Storage: PostHog auto-detecta el mejor disponible de las peer-deps instaladas
 * (@react-native-async-storage/async-storage está presente), que es el camino
 * seguro en react-native-web — NO usa expo-file-system en web.
 */
import PostHog from "posthog-react-native"

/** Nombres de evento de producto — única fuente de verdad (guard compile-time vs typos). */
export type AnalyticsEvent =
  | "user_signed_up"
  | "agent_created"
  | "message_sent"
  | "tool_permission_granted"
  | "tool_permission_denied"

/** JSON-serializable event properties, derived from the SDK's `capture` signature. */
type EventProperties = NonNullable<Parameters<PostHog["capture"]>[1]>

let client: PostHog | null = null

/** The shared PostHog instance, or `null` when analytics is disabled. */
export function getAnalytics(): PostHog | null {
  return client
}

/**
 * Compute the SDK options (host + dev-gated `disabled`) from env. Extracted as a
 * PURE function so the gating can be unit-tested without the module singleton.
 */
export function buildPostHogOptions(): { host: string; disabled: boolean } {
  const host = process.env.EXPO_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com"
  const isProduction = process.env.NODE_ENV === "production"
  return {
    host,
    // Mirror sentry.ts: don't emit from dev unless explicitly enabled.
    disabled: !isProduction && !process.env.EXPO_PUBLIC_POSTHOG_DEV_ENABLED,
  }
}

/**
 * Initialize PostHog once, as early as possible (app/_layout.tsx), before the
 * provider mounts. Returns the client (or `null` if disabled) so it can be
 * passed straight to `<PostHogProvider client={...}>`.
 */
export function initAnalytics(): PostHog | null {
  if (client) return client

  const apiKey = process.env.EXPO_PUBLIC_POSTHOG_KEY
  if (!apiKey) {
    console.log("[PostHog] No key configured, analytics disabled")
    return null
  }

  client = new PostHog(apiKey, buildPostHogOptions())
  return client
}

/**
 * Associate subsequent events with a user. Call right after a successful
 * login / signup / session restore (junto a `setSentryUser`).
 */
export function identifyUser(user: {
  userId: string
  email?: string | null
  name?: string | null
}): void {
  if (!client || !user.userId) return
  try {
    const properties: Record<string, string> = {}
    if (user.email) properties.email = user.email
    if (user.name) properties.name = user.name
    client.identify(user.userId, properties)
  } catch (err) {
    console.warn("[PostHog] identify failed (ignored):", err)
  }
}

/** Clear the identified user on logout (junto a `setSentryUser(null)`). */
export function resetAnalytics(): void {
  try {
    client?.reset()
  } catch (err) {
    console.warn("[PostHog] reset failed (ignored):", err)
  }
}

/** Capture a product event. No-op when analytics is disabled; never throws. */
export function track(event: AnalyticsEvent, properties?: EventProperties): void {
  try {
    client?.capture(event, properties)
  } catch (err) {
    console.warn("[PostHog] capture failed (ignored):", err)
  }
}
