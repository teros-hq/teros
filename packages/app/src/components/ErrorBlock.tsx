import { AlertTriangle, ChevronDown, ChevronUp, RefreshCw } from "@tamagui/lucide-icons"
import type React from "react"
import { useEffect, useRef, useState } from "react"
import { Animated, TouchableOpacity } from "react-native"
import { Button, Text, View, XStack, YStack } from "tamagui"
import { usePulseAnimation } from "../hooks/usePulseAnimation"

export interface ErrorBlockProps {
  errorType: "llm" | "tool" | "session" | "validation" | "network" | "unknown"
  userMessage: string
  technicalMessage?: string
  context?: Record<string, any>
  onRetry?: () => void
  timestamp?: Date
}

// ============================================================================
// Rate Limit Widget
// ============================================================================

interface RateLimitWidgetProps {
  resetAt?: number // Unix timestamp in ms
  retryAfterSecs?: number
  source?: string // e.g., "Claude", "OpenAI", "API", "Plan"
}

/** Pulsing orange dot indicator */
function PulsingDot() {
  const opacity = usePulseAnimation(true, { minOpacity: 0.4, duration: 1000 })

  return (
    <Animated.View
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: "#F97316",
        opacity,
      }}
    />
  )
}

function RateLimitWidget({ resetAt, retryAfterSecs, source }: RateLimitWidgetProps) {
  const [timeLeft, setTimeLeft] = useState<string>("")
  const [resetTime, setResetTime] = useState<string>("")
  const [progress, setProgress] = useState<number>(0)
  const initialDiff = useRef<number | null>(null)

  // Check if we have actual time information
  const hasTimeInfo = Boolean(resetAt || retryAfterSecs)

  useEffect(() => {
    // Calculate reset time string
    if (resetAt) {
      const resetDate = new Date(resetAt)
      setResetTime(
        resetDate.toLocaleTimeString("es-ES", {
          hour: "2-digit",
          minute: "2-digit",
        }),
      )
    }

    // Update countdown every second
    const updateCountdown = () => {
      const target = resetAt || (retryAfterSecs ? Date.now() + retryAfterSecs * 1000 : 0)
      if (!target) {
        setTimeLeft("unos minutos")
        setProgress(0)
        return
      }

      const diff = target - Date.now()

      // Store initial diff for progress calculation
      if (initialDiff.current === null && diff > 0) {
        initialDiff.current = diff
      }

      if (diff <= 0) {
        setTimeLeft("ahora")
        setProgress(100)
        return
      }

      // Calculate progress percentage
      if (initialDiff.current) {
        const elapsed = initialDiff.current - diff
        setProgress(Math.min(100, (elapsed / initialDiff.current) * 100))
      }

      const hours = Math.floor(diff / (1000 * 60 * 60))
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
      const seconds = Math.floor((diff % (1000 * 60)) / 1000)

      if (hours > 0) {
        setTimeLeft(
          `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`,
        )
      } else if (minutes > 0) {
        setTimeLeft(`${minutes}:${seconds.toString().padStart(2, "0")}`)
      } else {
        setTimeLeft(`0:${seconds.toString().padStart(2, "0")}`)
      }
    }

    updateCountdown()
    const interval = setInterval(updateCountdown, 1000)
    return () => clearInterval(interval)
  }, [resetAt, retryAfterSecs])

  return (
    <YStack
      backgroundColor="rgba(255, 255, 255, 0.03)"
      borderColor="rgba(255, 255, 255, 0.08)"
      borderWidth={1}
      borderRadius={12}
      padding={16}
      paddingHorizontal={20}
      marginVertical="$2"
      marginHorizontal="$2"
      maxWidth={360}
      alignSelf="flex-start"
    >
      {/* Header with title and badge */}
      <XStack alignItems="center" justifyContent="space-between" marginBottom={8}>
        <XStack alignItems="center" gap={10}>
          <PulsingDot />
          <Text color="rgba(255, 255, 255, 0.8)" fontWeight="500" fontSize={13}>
            Usage limit reached
          </Text>
        </XStack>
        {source && (
          <View
            backgroundColor="rgba(255, 255, 255, 0.06)"
            paddingHorizontal={8}
            paddingVertical={3}
            borderRadius={4}
          >
            <Text color="rgba(255, 255, 255, 0.5)" fontSize={10}>
              {source}
            </Text>
          </View>
        )}
      </XStack>

      {/* Description */}
      <Text
        color="rgba(255, 255, 255, 0.45)"
        fontSize={12}
        lineHeight={18}
        marginBottom={hasTimeInfo ? 12 : 0}
      >
        Puedes cambiar el modelo del agente o reintentar en unos minutos.
      </Text>

      {/* Time info row - only show if we have actual time data */}
      {hasTimeInfo && (
        <>
          <XStack justifyContent="space-between" alignItems="center" marginBottom={14}>
            <Text color="rgba(255, 255, 255, 0.4)" fontSize={12}>
              <Text color="#06B6D4" fontFamily="$mono">
                {timeLeft}
              </Text>
              {" restantes"}
            </Text>
            {resetTime && (
              <Text color="rgba(255, 255, 255, 0.4)" fontSize={12}>
                {"Disponible a las "}
                <Text color="#06B6D4" fontFamily="$mono">
                  {resetTime}
                </Text>
              </Text>
            )}
          </XStack>

          {/* Progress bar */}
          <View
            height={3}
            backgroundColor="rgba(255, 255, 255, 0.08)"
            borderRadius={2}
            overflow="hidden"
          >
            <View
              height="100%"
              width={`${progress}%`}
              borderRadius={2}
              style={{
                background: "linear-gradient(90deg, #06B6D4, #0891B2)",
              }}
              backgroundColor="#06B6D4"
            />
          </View>
        </>
      )}
    </YStack>
  )
}

// ============================================================================
// Main ErrorBlock Component
// ============================================================================

export const ErrorBlock: React.FC<ErrorBlockProps> = ({
  errorType,
  userMessage,
  technicalMessage,
  context,
  onRetry,
  timestamp,
}) => {
  const [showDetails, setShowDetails] = useState(false)

  // Check if this is a rate limit error
  const isRateLimit = errorType === "llm" && context?.isRateLimit === true

  // If rate limit, render the special widget
  if (isRateLimit) {
    return (
      <RateLimitWidget
        resetAt={context?.resetAt}
        retryAfterSecs={context?.retryAfterSecs}
        source={context?.source}
      />
    )
  }

  const getErrorTitle = (type: string) => {
    switch (type) {
      case "llm":
        return "Error del Asistente"
      case "tool":
        return "Error de Herramienta"
      case "session":
        return "Session Error"
      case "validation":
        return "Validation Error"
      case "network":
        return "Connection Error"
      default:
        return "Error Desconocido"
    }
  }

  const getErrorColor = (type: string) => {
    switch (type) {
      case "llm":
        return "$orange"
      case "tool":
        return "$yellow"
      case "session":
        return "$red"
      case "validation":
        return "$purple"
      case "network":
        return "$blue"
      default:
        return "$red"
    }
  }

  const errorColor = getErrorColor(errorType)

  return (
    <YStack
      backgroundColor="rgba(255, 255, 255, 0.03)"
      borderColor="rgba(255, 255, 255, 0.1)"
      borderWidth={1}
      borderRadius="$3"
      padding="$3"
      marginVertical="$2"
      marginHorizontal="$2"
      maxWidth="85%"
      alignSelf="flex-start"
    >
      {/* Header with icon and title */}
      <XStack alignItems="center" gap="$2" marginBottom="$2">
        <AlertTriangle size={16} color="rgba(255, 180, 120, 0.7)" />
        <Text color="rgba(255, 255, 255, 0.6)" fontWeight="500" fontSize="$2">
          {getErrorTitle(errorType)}
        </Text>
      </XStack>

      {/* Mensaje principal para el usuario */}
      <Text color="rgba(255, 255, 255, 0.7)" fontSize="$2" lineHeight="$4" marginBottom="$2">
        {userMessage}
      </Text>

      {/* Technical message always visible if present */}
      {technicalMessage && (
        <Text
          color="rgba(255, 255, 255, 0.5)"
          fontSize="$1"
          fontFamily="$mono"
          lineHeight="$3"
          marginBottom="$2"
        >
          {technicalMessage}
        </Text>
      )}

      {/* Additional context button (only if there is context) */}
      {context && Object.keys(context).length > 0 && (
        <TouchableOpacity onPress={() => setShowDetails(!showDetails)}>
          <XStack alignItems="center" gap="$2" marginBottom="$2">
            <Text color="rgba(255, 255, 255, 0.4)" fontSize="$1">
              {showDetails ? "Ocultar contexto" : "Mostrar contexto"}
            </Text>
            {showDetails ? (
              <ChevronUp size={12} color="rgba(255, 255, 255, 0.4)" />
            ) : (
              <ChevronDown size={12} color="rgba(255, 255, 255, 0.4)" />
            )}
          </XStack>
        </TouchableOpacity>
      )}

      {/* Contexto colapsable (solo si hay context y showDetails) */}
      {showDetails && context && Object.keys(context).length > 0 && (
        <YStack
          backgroundColor="rgba(0, 0, 0, 0.2)"
          borderRadius="$2"
          padding="$2"
          marginBottom="$2"
        >
          <Text color="rgba(255, 255, 255, 0.5)" fontSize="$1" fontWeight="500" marginBottom="$1">
            Contexto:
          </Text>
          <Text color="rgba(255, 255, 255, 0.4)" fontSize="$1" fontFamily="$mono" lineHeight="$3">
            {JSON.stringify(context, null, 2)}
          </Text>
        </YStack>
      )}

      {/* Acciones */}
      <XStack gap="$2" alignItems="center">
        {onRetry && (
          <Button
            size="$2"
            backgroundColor="rgba(255, 255, 255, 0.05)"
            borderColor="rgba(255, 255, 255, 0.1)"
            color="rgba(255, 255, 255, 0.6)"
            onPress={onRetry}
            icon={RefreshCw}
            fontSize="$1"
          >
            Reintentar
          </Button>
        )}

        {timestamp && (
          <Text fontSize="$1" color="rgba(255, 255, 255, 0.3)">
            {timestamp.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}
          </Text>
        )}
      </XStack>
    </YStack>
  )
}
