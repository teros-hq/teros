/**
 * WindowContent - Renders the content of a window according to its type
 */

import React, { Suspense, useState } from "react"
import { useTranslation } from "react-i18next"
import { YStack } from "tamagui"
import { useColors } from "../mca/primitives/useColors"
import { Btn, T, Tile } from "../ui/ds"
import { windowRegistry } from "../../services/windowRegistry"
import { FullscreenLoader } from "../../components/ui"
import { WindowCloseConfirm } from "./WindowCloseConfirm"

interface WindowLike {
  id: string
  type: string
  props: Record<string, any>
  [key: string]: any
}

interface Props {
  window: WindowLike
}

/**
 * Renders the correct component based on the window type.
 *
 * The resetKey combines id + type so the ErrorBoundary resets
 * both when switching tabs (same id, different content does not apply here)
 * and when doing replaceWindow (same id, different type/props).
 *
 * The retryKey changes on each retry attempt, forcing the inner
 * Suspense + lazy component to fully unmount and remount — which
 * creates a fresh import() attempt (the old one may hold a cached error).
 */
export function WindowContent({ window }: Props) {
  const { t } = useTranslation()
  const definition = windowRegistry.get(window.type)

  // retryKey increments on each manual retry, forcing remount of the
  // Suspense + lazy subtree so a fresh import() is attempted.
  const [retryCount, setRetryCount] = useState(0)

  if (!definition) {
    return <WindowError message={`Unknown window type: ${window.type}`} />
  }

  const Component = definition.component
  // resetKey changes when the actual window content changes,
  // forzando al ErrorBoundary a limpiar su estado de error.
  const resetKey = `${window.id}::${window.type}`
  // retryKey forces remount of the lazy component subtree
  const retryKey = `${resetKey}::${retryCount}`

  return (
    <>
      <WindowCloseConfirm windowId={window.id} />
      <ErrorBoundary
        resetKey={retryKey}
        fallback={(error) => (
          <WindowError
            message={t("errors.windowContentLoadFailed")}
            error={error}
            onRetry={() => setRetryCount((c) => c + 1)}
            retryLabel={t("errors.retryLoad")}
          />
        )}
      >
        <Suspense fallback={<WindowLoading />}>
          <Component key={retryCount} {...window.props} windowId={window.id} />
        </Suspense>
      </ErrorBoundary>
    </>
  )
}

/**
 * Loading state
 */
function WindowLoading() {
  return <FullscreenLoader />
}

/**
 * Error state — now with a retry button that forces a fresh import.
 */
function WindowError({
  message,
  error,
  onRetry,
  retryLabel,
}: {
  message: string
  error?: Error
  onRetry?: () => void
  retryLabel?: string
}) {
  const c = useColors()
  return (
    <YStack
      flex={1}
      justifyContent="center"
      alignItems="center"
      padding={24}
      backgroundColor={c.bgSheet}
      gap={12}
    >
      <Tile icon="warning" tone="pink" />
      <T step="xl" center>
        {message}
      </T>
      {error && (
        <T step="12" tone="text3" center style={{ maxWidth: 420 }}>
          {error.message}
        </T>
      )}
      {onRetry && (
        <Btn variant="sec" icon="arrow-clockwise" onPress={onRetry} style={{ marginTop: 6 }}>
          {retryLabel ?? "Retry"}
        </Btn>
      )}
    </YStack>
  )
}

/**
 * Error Boundary con soporte de reset por clave.
 *
 * When `resetKey` changes (e.g. when the window type or id changes,
 * or when the user clicks retry), the error state is automatically
 * cleared so the new content renders cleanly.
 */
interface ErrorBoundaryProps {
  children: React.ReactNode
  fallback: (error?: Error) => React.ReactNode
  /** When this key changes, the error is automatically reset */
  resetKey?: string
}

interface ErrorBoundaryState {
  hasError: boolean
  error?: Error
  /** Clave en el momento en que se produjo el error */
  errorResetKey?: string
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    // If there's an active error AND the key has changed since the error occurred,
    // reset the state so the new content renders cleanly.
    if (state.hasError && props.resetKey !== state.errorResetKey) {
      return { hasError: false, error: undefined, errorResetKey: undefined }
    }
    return null
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[WindowContent] Error caught:", error, errorInfo)
    // Save the resetKey at the time of the error to detect changes later
    this.setState({ errorResetKey: this.props.resetKey })
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback(this.state.error)
    }
    return this.props.children
  }
}
