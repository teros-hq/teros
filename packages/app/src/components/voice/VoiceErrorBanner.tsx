/**
 * VoiceErrorBanner — the catalog with an action (ui-evolution.md §3.3) ⭐
 *
 * Nada se rompe en silencio: every typed error is SEEN, HEARD (the context
 * fires the error earcon) and has a WAY OUT — a primary action per code
 * (UX §7.2). Zero generic Alert modals (AC-UX4): the error lives on the
 * voice surface, speaks human, and offers the action that resolves it.
 *
 * Anatomy (UX §7.1, in the OS prototype's vocabulary — a card on the sheet,
 * red-tinted icon tile, pill buttons, amber badge for the countdown):
 *   [icon] mensaje humano (qué pasó + qué hacer, nunca jerga)
 *   [acción primaria ≥44px] — per code:
 *     auth              → "Iniciar sesión"
 *     flag_disabled     → "Solicitar acceso"
 *     elevenlabs_signed_url / server_error → "Reintentar" (auto 10 s)
 *     timeout           → "Reintentar" (auto 5 s)
 *     workspace_unresolved → "Reintentar" + "Copiar código"
 *     mic_permission    → "Abrir ajustes de permisos" (deep link)
 *     bad_request       → "Reintentar"
 *     stt_error/tts_error → "Reintentar"
 *     unknown           → "Reintentar" + "Copiar código"
 *   [código técnico en mono pequeño] — for support, not to read
 *   [auto-retry countdown visible + cancelable] — for transient codes
 *
 * Transient errors auto-retry with a VISIBLE countdown ("Reintentando en
 * 3 s…", UX §7.1) — the system keeps trying and the user knows it. With
 * prefers-reduced-motion the countdown is a static label (AC-UX12).
 *
 * mic_permission (AC-UX5): emitted client-side after a denied getUserMedia
 * (VoiceSessionContext §2.1.3). Its button opens the OS/browser permission
 * settings — web: re-queries the permission; native: expo-linking
 * Linking.openSettings (iOS: Ajustes → Teros → Micrófono).
 *
 * Where it lives: where the legacy inline error panel was (bottom of the
 * message area, above the composer/orb) — mounted by ChatView, flag-gated
 * (voice.mode-ui). Flag off = the legacy inline panel stays (zero
 * regression).
 */

import React, { useEffect, useRef, useState } from "react"
import { Linking, Platform, Pressable, View } from "react-native"
import { useTranslation } from "react-i18next"
import type { VoiceErrorCode, VoiceSessionError } from "@teros/shared"
import { useColors } from "../mca/primitives/useColors"
import { useReducedMotion } from "../../hooks/useReducedMotion"
import { Badge, Btn, Ph, T } from "../ui/ds"

// ─── The catalog (UX §7.2 — one entry per typed code) ───────────────────────

/** What the primary action button does, per code. */
type ErrorAction =
  | { kind: "retry" }
  | { kind: "login" }
  | { kind: "request_access" }
  | { kind: "open_settings" }
  | { kind: "retry_and_copy" }

interface CatalogEntry {
  /** i18n key of the human message (what happened + what to do). */
  messageKey: string
  /** Default (es) message — the spec's exact copy. */
  messageDefault: string
  /** The primary action. */
  action: ErrorAction
  /** Auto-retry delay in seconds (0 = manual only). */
  autoRetrySeconds: number
}

const ERROR_CATALOG: Record<VoiceErrorCode, CatalogEntry> = {
  auth: {
    messageKey: "voice.error.auth",
    messageDefault: "Tu sesión ha caducado. Inicia sesión de nuevo para hablar con {{agent}}.",
    action: { kind: "login" },
    autoRetrySeconds: 0,
  },
  flag_disabled: {
    messageKey: "voice.error.flagDisabled",
    messageDefault: "El modo voz aún no está activado para tu cuenta.",
    action: { kind: "request_access" },
    autoRetrySeconds: 0,
  },
  elevenlabs_signed_url: {
    messageKey: "voice.error.elevenlabs",
    messageDefault: "El servicio de voz no está disponible ahora mismo. Reintenta en un momento.",
    action: { kind: "retry" },
    autoRetrySeconds: 10,
  },
  timeout: {
    messageKey: "voice.error.timeout",
    messageDefault: "La conexión está tardando demasiado.",
    action: { kind: "retry" },
    autoRetrySeconds: 5,
  },
  workspace_unresolved: {
    messageKey: "voice.error.workspace",
    messageDefault: "No hemos podido identificar tu workspace.",
    action: { kind: "retry_and_copy" },
    autoRetrySeconds: 0,
  },
  mic_permission: {
    messageKey: "voice.error.micPermission",
    messageDefault: "Para que {{agent}} te escuche necesitas dar acceso al micrófono.",
    action: { kind: "open_settings" },
    autoRetrySeconds: 0,
  },
  server_error: {
    messageKey: "voice.error.serverError",
    messageDefault: "Algo ha fallado en nuestros servidores.",
    action: { kind: "retry" },
    autoRetrySeconds: 10,
  },
  bad_request: {
    messageKey: "voice.error.badRequest",
    messageDefault: "La petición no es válida.",
    action: { kind: "retry" },
    autoRetrySeconds: 0,
  },
  stt_error: {
    messageKey: "voice.error.stt",
    messageDefault: "No hemos podido transcribir tu voz. Reintenta en un momento.",
    action: { kind: "retry" },
    autoRetrySeconds: 0,
  },
  tts_error: {
    messageKey: "voice.error.tts",
    messageDefault: "No hemos podido generar la voz de {{agent}}. Reintenta en un momento.",
    action: { kind: "retry" },
    autoRetrySeconds: 0,
  },
  unknown: {
    messageKey: "voice.error.unknown",
    messageDefault: "Algo ha fallado.",
    action: { kind: "retry_and_copy" },
    autoRetrySeconds: 0,
  },
}

// ─── Props ───────────────────────────────────────────────────────────────────

export interface VoiceErrorBannerProps {
  /** The typed error (null = nothing renders). */
  error: VoiceSessionError | null
  /** Agent display name — the copy speaks like a person ("hablar con Alice"). */
  agentName?: string
  /** Retry — restarts the voice session (ChatView's handleStartVoice). */
  onRetry: () => void
  /** Login — navigates to the auth surface. */
  onLogin?: () => void
}

// ─── The banner ───────────────────────────────────────────────────────────────

export function VoiceErrorBanner({ error, agentName, onRetry, onLogin }: VoiceErrorBannerProps) {
  const { t } = useTranslation()
  const c = useColors()
  const reducedMotion = useReducedMotion()

  // Auto-retry countdown — visible and cancelable (UX §7.1). The first tap
  // of "Reintentar ahora" cancels it; the countdown reaching 0 retries.
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)
  const cancelledRef = useRef(false)

  const entry = error ? ERROR_CATALOG[error.code] : null
  const autoRetry = entry?.autoRetrySeconds ?? 0

  useEffect(() => {
    cancelledRef.current = false
    if (!error || autoRetry === 0) {
      setSecondsLeft(null)
      return
    }
    setSecondsLeft(autoRetry)
    const id = setInterval(() => {
      setSecondsLeft((s) => {
        if (s === null) return null
        if (s <= 1) {
          clearInterval(id)
          if (!cancelledRef.current) onRetry()
          return null
        }
        return s - 1
      })
    }, 1000)
    return () => clearInterval(id)
    // Re-arm per error instance: a new error object restarts the countdown.
  }, [error, autoRetry, onRetry])

  if (!error || !entry) return null

  const agent = agentName ?? t("voice.orb.agent", { defaultValue: "Alice" })
  const message = t(entry.messageKey, {
    defaultValue: entry.messageDefault,
    agent,
  })

  // ── Primary action per code (UX §7.2) ──
  const handleAction = () => {
    cancelledRef.current = true // a manual action cancels the countdown
    setSecondsLeft(null)
    switch (entry.action.kind) {
      case "retry":
      case "retry_and_copy":
        onRetry()
        break
      case "login":
        onLogin?.()
        break
      case "request_access":
        // "Solicitar acceso" — the honest door while the flag is off for
        // this account: opens the workspace support surface. Same target as
        // login for now (the app has no dedicated request flow yet).
        onLogin?.()
        break
      case "open_settings":
        openMicPermissionSettings()
        break
    }
  }

  const actionLabel =
    entry.action.kind === "login"
      ? t("voice.error.actionLogin", { defaultValue: "Iniciar sesión" })
      : entry.action.kind === "request_access"
        ? t("voice.error.actionRequestAccess", { defaultValue: "Solicitar acceso" })
        : entry.action.kind === "open_settings"
          ? t("voice.error.actionOpenSettings", { defaultValue: "Abrir ajustes de permisos" })
          : t("voice.error.actionRetry", { defaultValue: "Reintentar" })

  // Phosphor glyph of the primary action.
  const actionIcon =
    entry.action.kind === "login"
      ? "sign-in"
      : entry.action.kind === "request_access"
        ? "hand-waving"
        : entry.action.kind === "open_settings"
          ? "gear-six"
          : "arrow-clockwise"

  const copyCode = () => {
    const text = `${error.code}: ${error.message}`
    try {
      navigator.clipboard?.writeText(text)
    } catch {
      // Clipboard may be unavailable (permissions, non-secure context) —
      // the code is still visible in the banner to copy by hand.
    }
  }

  return (
    <View
      style={[
        {
          padding: 16,
          gap: 12,
          borderRadius: 16,
          backgroundColor: c.bgStep,
          zIndex: 2,
        },
        Platform.OS === "web" ? ({ boxShadow: c.liftSm } as any) : null,
      ]}
      // AC-UX12: the error is announced politely — the state of the voice
      // is announcable text, not just color.
      accessibilityLiveRegion="polite"
      accessibilityLabel={t("voice.error.bannerLabel", { defaultValue: "Error de voz" })}
    >
      {/* Icon tile (red tint) + the human message */}
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: 10,
            backgroundColor: c.tint.r.bg,
            borderWidth: 1,
            borderColor: c.tint.r.bd,
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Ph name="warning" size={16} color={c.tint.r.tx} />
        </View>
        <View style={{ flex: 1, minWidth: 160, gap: 2 }}>
          <T step="sm">{message}</T>
          {/* The technical code — mono, small, for support (UX §7.2: "para
              soporte, no para leer"). Never the star of the banner. */}
          <T step="code" tone="text3" selectable style={{ fontSize: 10, lineHeight: 14 }}>
            {error.code}
          </T>
        </View>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {/* Primary action — ≥44px (AC-UX13) */}
        <Btn variant="dangerSoft" size="lg" icon={actionIcon} onPress={handleAction}>
          {actionLabel}
        </Btn>

        {/* Copy code — for the codes whose resolution may need support */}
        {entry.action.kind === "retry_and_copy" && (
          <Btn
            variant="sec"
            size="lg"
            icon="copy"
            onPress={copyCode}
            accessibilityLabel={t("voice.error.copyCode", {
              defaultValue: "Copiar código de error",
            })}
          >
            {t("voice.error.copyCode", { defaultValue: "Copiar código" })}
          </Btn>
        )}

        {/* Auto-retry countdown — visible and cancelable (UX §7.1). With
            reduced motion it is a static label (the number IS the state —
            AC-UX12: color + label, no animation needed). */}
        {secondsLeft !== null && secondsLeft > 0 && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginLeft: "auto" }}>
            <Badge tone="a" pill dot>
              {reducedMotion
                ? t("voice.error.autoRetryStatic", {
                    defaultValue: "Reintentando en {{s}} s",
                    s: secondsLeft,
                  })
                : t("voice.error.autoRetry", {
                    defaultValue: "Reintentando en {{s}} s…",
                    s: secondsLeft,
                  })}
            </Badge>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                cancelledRef.current = true
                setSecondsLeft(null)
              }}
              accessibilityLabel={t("voice.error.cancelRetry", {
                defaultValue: "Cancelar reintento",
              })}
              style={Platform.OS === "web" ? ({ cursor: "pointer" } as any) : undefined}
            >
              <T step="12" tone="text3" style={{ textDecorationLine: "underline" }}>
                {t("voice.error.cancelRetry", { defaultValue: "cancelar" })}
              </T>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  )
}

// ─── mic_permission deep link (AC-UX5) ───────────────────────────────────────

/**
 * Open the OS/browser microphone permission settings.
 *
 * - native (iOS/Android): expo-linking Linking.openSettings → the app's
 *   system settings page (iOS: Ajustes → Teros → Micrófono).
 * - web: browsers do not let JS open chrome://settings — the honest best
 *   is to re-query the Permissions API (some browsers re-prompt on query
 *   after a denial was reset) and fall back to a visible hint. The banner
 *   copy already says what to do; this keeps the button honest everywhere.
 */
export function openMicPermissionSettings() {
  try {
    if (Platform.OS !== "web") {
      Linking.openSettings()
      return
    }
    navigator.permissions
      ?.query({ name: "microphone" as PermissionName })
      .then((status) => {
        // A denied permission re-prompt is browser-controlled; querying is
        // the only programmatic door. If it stays denied, the banner's copy
        // tells the user where the site settings live (site info icon).
        console.debug("[VoiceErrorBanner] mic permission status:", status.state)
      })
      .catch(() => {
        // Permissions API unavailable (Firefox/Safari partial) — nothing
        // more we can do from JS; the copy carries the instruction.
      })
  } catch (err) {
    console.debug("[VoiceErrorBanner] openMicPermissionSettings failed:", err)
  }
}
