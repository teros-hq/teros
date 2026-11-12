import React from "react"
import { Platform, Pressable, Text, View } from "react-native"
import { captureException } from "../lib/sentry"
import { colors as semantic, surface, type Theme } from "./mca/primitives/colors"
import { FONT_SANS, FONT_SERIF } from "./mca/primitives/fonts"

/**
 * Root error boundary (TER-418).
 *
 * Los errores de render de React NO los captura `window.onerror` ni la
 * instrumentación de Sentry: sin un ErrorBoundary, un throw en cualquier ruta
 * desmonta TODO el árbol y el usuario ve una pantalla en blanco sin que Sentry
 * reciba nada. Este boundary envuelve la app entera y, al fallar, reporta el
 * error a Sentry (con el component stack para reproducirlo) y muestra un fallback
 * accionable en lugar de la pantalla blanca.
 *
 * El fallback usa React Native plano (no Tamagui): así sigue funcionando aunque
 * lo que haya fallado sea un provider del árbol (Tamagui, i18n, toast). El tema
 * se lee de la preferencia persistida (`teros-ui-theme`) — sin hooks ni
 * providers — para que el fallback siga el tema del usuario en light y dark.
 */

interface Props {
  children: React.ReactNode
}

interface State {
  hasError: boolean
}

/** The persisted theme, read without any provider (the tree may be broken). */
function readPersistedTheme(): Theme {
  try {
    if (Platform.OS === "web" && typeof window !== "undefined" && window.localStorage) {
      const raw = window.localStorage.getItem("teros-ui-theme")
      if (raw) {
        const parsed = JSON.parse(raw)
        const theme = parsed?.state?.theme
        if (theme === "light" || theme === "dark") return theme
      }
      if (
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-color-scheme: light)").matches
      ) {
        return "light"
      }
    }
  } catch {
    // ignore — fall back to dark
  }
  return "dark"
}

export class RootErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    captureException(error, { componentStack: errorInfo.componentStack })
    console.error("[RootErrorBoundary] Uncaught render error:", error, errorInfo)
  }

  private handleReload = (): void => {
    if (Platform.OS === "web" && typeof window !== "undefined") {
      window.location.reload()
      return
    }
    // En nativo no hay reload de página: limpiar el estado para reintentar el render.
    this.setState({ hasError: false })
  }

  render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children
    }
    const c = surface[readPersistedTheme()]
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          backgroundColor: c.bgFrame,
        }}
      >
        <View
          style={[
            {
              width: "100%",
              maxWidth: 416,
              borderRadius: 24,
              backgroundColor: c.bgStep,
              paddingVertical: 36,
              paddingHorizontal: 36,
            },
            Platform.OS === "web" ? ({ boxShadow: c.elevRaised } as any) : null,
          ]}
        >
          <Text
            style={{
              fontFamily: FONT_SERIF,
              fontSize: 32,
              lineHeight: 36,
              letterSpacing: -0.48,
              fontWeight: "400",
              color: c.text,
              marginBottom: 10,
            }}
          >
            Algo ha fallado
          </Text>
          <Text
            style={{
              fontFamily: FONT_SANS,
              fontSize: 13,
              lineHeight: 19,
              fontWeight: "400",
              color: c.text2,
              marginBottom: 24,
            }}
          >
            La aplicación encontró un error inesperado. El equipo ha sido notificado.
          </Text>
          <Pressable
            onPress={this.handleReload}
            accessibilityRole="button"
            accessibilityLabel="Recargar la aplicación"
            style={({ pressed }) => [
              {
                alignSelf: "flex-start",
                height: 44,
                paddingHorizontal: 20,
                borderRadius: 100,
                backgroundColor: semantic.purple300,
                alignItems: "center",
                justifyContent: "center",
                transform: pressed ? [{ scale: 0.96 }] : undefined,
              },
              Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
            ]}
          >
            <Text
              style={{ fontFamily: FONT_SANS, fontSize: 16, fontWeight: "400", color: "#FFFFFF" }}
            >
              Recargar
            </Text>
          </Pressable>
        </View>
      </View>
    )
  }
}
