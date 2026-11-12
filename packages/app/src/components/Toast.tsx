/**
 * Toast — the OS prototype's `.toast`: a small card (radius 16, padding 10)
 * that rises bottom-right with an icon tile (green / red / amber / violet
 * tint), a 13px line and an optional accent "undo" link. Theme-adaptive via
 * `useColors()`. On phones (≤760) it spans the bottom edge.
 *
 *   const toast = useToast()
 *   toast.success('Guardado')
 *   toast.show('Conversación archivada', { type: 'info', action: { label: 'Deshacer', onPress } })
 */
import {
  Toast,
  ToastProvider,
  ToastViewport,
  useToastController,
  useToastState,
} from "@tamagui/toast"
import type React from "react"
import { useEffect } from "react"
import { Platform, Pressable, useWindowDimensions, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { FONT_SANS } from "./mca/primitives/fonts"
import { useColors } from "./mca/primitives/useColors"
import { Ph, T } from "./ui/ds"

// Toast types for different styling
export type ToastType = "info" | "success" | "warning" | "error"

export interface ToastAction {
  label: string
  onPress: () => void
}

// Extend CustomData for type safety
declare module "@tamagui/toast" {
  interface CustomData {
    type?: ToastType
    action?: ToastAction
  }
}

const TONE: Record<ToastType, { tint: "g" | "a" | "r" | "i"; icon: string }> = {
  info: { tint: "i", icon: "info" },
  success: { tint: "g", icon: "check" },
  warning: { tint: "a", icon: "warning" },
  error: { tint: "r", icon: "x" },
}

// Current toast renderer
function CurrentToast() {
  const toast = useToastState()
  const c = useColors()
  const { width } = useWindowDimensions()
  const phone = width <= 760

  if (!toast || toast.isHandledNatively) {
    return null
  }

  const type = (toast.customData?.type as ToastType) || "info"
  const action = toast.customData?.action as ToastAction | undefined
  const tone = TONE[type]
  const tint = c.tint[tone.tint]

  return (
    <Toast
      key={toast.id}
      testID={`toast-${type}`}
      duration={toast.duration}
      enterStyle={{ opacity: 0, scale: 0.96, y: 24 }}
      exitStyle={{ opacity: 0, scale: 0.96, y: 24 }}
      opacity={1}
      scale={1}
      y={0}
      animation="quick"
      backgroundColor={c.bgStep}
      borderWidth={1}
      borderColor={type === "error" ? c.tint.r.bd : c.border}
      borderRadius={16}
      padding={10}
      paddingRight={14}
      maxWidth={phone ? undefined : 420}
      width={phone ? "100%" : undefined}
      {...(Platform.OS === "web" ? ({ style: { boxShadow: c.elevRaised } } as any) : {})}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: 10,
            backgroundColor: tint.bg,
            borderWidth: 1,
            borderColor: tint.bd,
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Ph name={tone.icon} size={15} color={tint.tx} weight="bold" />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          {toast.title ? (
            <Toast.Title
              color={c.text}
              fontFamily={FONT_SANS}
              fontSize={13}
              lineHeight={18}
              fontWeight="400"
            >
              {toast.title}
            </Toast.Title>
          ) : null}
          {toast.message ? (
            <Toast.Description
              color={c.text2}
              fontFamily={FONT_SANS}
              fontSize={12}
              lineHeight={16}
              fontWeight="400"
            >
              {toast.message}
            </Toast.Description>
          ) : null}
        </View>
        {action ? (
          <Pressable
            onPress={action.onPress}
            accessibilityRole="button"
            testID="toast-action"
            style={({ pressed }) => [
              { marginLeft: 8, opacity: pressed ? 0.7 : 1 },
              Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
            ]}
          >
            <T step="sm" tone="accent">
              {action.label}
            </T>
          </Pressable>
        ) : null}
      </View>
    </Toast>
  )
}

// Safe viewport that respects safe areas — bottom-right (`.toast`), full width on phones.
function SafeToastViewport() {
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()
  const phone = width <= 760

  return (
    <ToastViewport
      flexDirection="column"
      bottom={(phone ? 12 : 24) + insets.bottom}
      right={phone ? 12 : 24}
      left={phone ? 12 : undefined}
      alignItems={phone ? "stretch" : "flex-end"}
      gap={8}
      zIndex={96}
    />
  )
}

function useResumeWhenFocusEntersAFrame() {
  useEffect(() => {
    if (Platform.OS !== "web") return
    let timer: ReturnType<typeof setTimeout> | undefined
    const onBlur = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (document.activeElement instanceof HTMLIFrameElement && document.hasFocus())
          window.dispatchEvent(new FocusEvent("focus"))
      }, 0)
    }
    window.addEventListener("blur", onBlur)
    return () => {
      clearTimeout(timer)
      window.removeEventListener("blur", onBlur)
    }
  }, [])
}

// Provider wrapper
export function TerosToastProvider({ children }: { children: React.ReactNode }) {
  useResumeWhenFocusEntersAFrame()
  return (
    <ToastProvider swipeDirection="down" duration={3000}>
      {children}
      <CurrentToast />
      <SafeToastViewport />
    </ToastProvider>
  )
}

// Hook for showing toasts
export function useToast() {
  const toast = useToastController()

  return {
    show: (
      title: string,
      options?: { message?: string; type?: ToastType; duration?: number; action?: ToastAction },
    ) => {
      toast.show(title, {
        message: options?.message,
        duration: options?.duration,
        customData: { type: options?.type || "info", action: options?.action },
      })
    },
    info: (title: string, message?: string) => {
      toast.show(title, { message, customData: { type: "info" } })
    },
    success: (title: string, message?: string) => {
      toast.show(title, { message, customData: { type: "success" } })
    },
    warning: (title: string, message?: string) => {
      toast.show(title, { message, customData: { type: "warning" } })
    },
    error: (title: string, message?: string) => {
      toast.show(title, { message, customData: { type: "error" } })
    },
    hide: () => toast.hide(),
  }
}
