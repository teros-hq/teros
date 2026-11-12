import type React from "react"
import { YStack } from "tamagui"
import { T } from "../../ui/ds/Text"

interface EmptyProps {
  /** Icon opcional encima del mensaje. */
  icon?: React.ReactNode
  /** Mensaje principal. */
  message: string
  /** Texto adicional (hint, siguiente acción). */
  hint?: string
}

/**
 * Estado vacío: icon + mensaje + hint opcional. Centrado con padding
 * generoso para no parecer "bug de data missing".
 */
export function Empty({ icon, message, hint }: EmptyProps): React.ReactNode {
  return (
    <YStack
      paddingVertical={24}
      paddingHorizontal={12}
      alignItems="center"
      justifyContent="center"
      gap={6}
    >
      {icon}
      <T step="sm" tone="text2" center>
        {message}
      </T>
      {hint && (
        <T step="12" tone="text3" center>
          {hint}
        </T>
      )}
    </YStack>
  )
}
