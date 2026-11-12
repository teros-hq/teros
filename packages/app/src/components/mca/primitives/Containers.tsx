/**
 * Card chrome of a tool call — the OS prototype's `.approval` card.
 *
 * Radius 16. While the call is LIVE (queued, running, awaiting approval or a
 * form) the card sits on the violet wash (`navActive`) with a violet hairline;
 * once SETTLED (completed / failed) it becomes a quiet nested card (`nest` +
 * `border`). Hover strengthens the hairline and adds the violet lift (web).
 */
import { AlertCircle, Check } from "./icons"
import type React from "react"
import { Platform, View } from "react-native"
import { XStack, YStack } from "tamagui"
import { fx } from "../../../styles/fx"
import { T } from "../../ui/ds/Text"
import { colors, type McaStatusType } from "./colors"
import { useColors } from "./useColors"

/** `color-mix(in srgb, var(--purple-300) 18%, transparent)` — the live hairline. */
export const APPROVAL_BORDER = "rgba(111,39,255,0.18)"
export const APPROVAL_BORDER_HOVER = "rgba(111,39,255,0.32)"
export const APPROVAL_LIFT = "0 8px 28px -18px rgba(111,39,255,0.45)"

/** A call that has not settled yet — still on the violet wash. */
export function isLiveStatus(status?: McaStatusType): boolean {
  return status != null && status !== "completed" && status !== "failed"
}

export function ExpandedContainer({
  children,
  status,
  accent,
}: {
  children: React.ReactNode
  /** Drives the wash: live → violet, settled (or omitted) → quiet. */
  status?: McaStatusType
  /** Optional 3px left accent (see `ToolCallCard.accent`). */
  accent?: string
}) {
  const c = useColors()
  const live = isLiveStatus(status)
  const hoverBorder = live ? APPROVAL_BORDER_HOVER : c.borderStrong
  const box = (
    <YStack
      // Settled: the same box as the prose's quote and code blocks (card
      // fill, no border, soft lift) so a tool call sits in the thread as
      // quietly as any other block. Live: the violet wash + hairline.
      // Live: an OPAQUE box on the sheet colour (prototype `.approval` →
      // `--box`) so the cloud blooms behind it, not through it.
      backgroundColor={live ? c.bgBox : c.bgStep}
      borderRadius={16}
      borderWidth={live ? 1 : 0}
      borderColor="transparent"
      overflow="hidden"
      width="100%"
      {...(accent ? { borderLeftWidth: 3, borderLeftColor: accent } : {})}
      {...(Platform.OS === "web" ? ({ boxShadow: live ? "none" : c.liftSm } as any) : {})}
      hoverStyle={{
        ...(live
          ? accent
            ? {
                borderTopColor: hoverBorder,
                borderRightColor: hoverBorder,
                borderBottomColor: hoverBorder,
              }
            : { borderColor: hoverBorder }
          : {}),
        ...(Platform.OS === "web"
          ? ({ boxShadow: live ? APPROVAL_LIFT : c.liftSmHover } as any)
          : {}),
      }}
      {...(Platform.OS === "web"
        ? ({
            style: {
              transition:
                "border-color 0.35s, box-shadow 0.35s cubic-bezier(.16,1,.3,1), background 0.25s",
            },
          } as any)
        : {})}
    >
      {children}
    </YStack>
  )
  // Live: the violet cloud blooms behind the box (prototype `.approval`).
  // On a wrapper, because the box clips its children.
  if (!live || Platform.OS !== "web") return box
  return (
    <View {...fx("cloud")} style={{ width: "100%" }}>
      {box}
    </View>
  )
}

export function ExpandedBody({ children }: { children: React.ReactNode }) {
  return (
    <YStack
      paddingHorizontal={14}
      paddingBottom={14}
      paddingTop={2}
      gap={10}
      testID="expanded-body"
    >
      {children}
    </YStack>
  )
}

interface ErrorBlockProps {
  /** @deprecated use `message` instead. Kept for backwards compatibility. */
  error?: string
  /** Main error message — concise summary of what went wrong. */
  message?: string
  /** Short heading (e.g. "Patch failed", "Path traversal blocked"). */
  title?: string
  /** Multi-line stack trace or extra detail. */
  details?: string
  /** Suggested next action ("Run `read` first.", "Check workspace roots."). */
  hint?: string
}

export function ErrorBlock(props: ErrorBlockProps) {
  const c = useColors()
  const message = props.message ?? props.error ?? ""
  const { title, details, hint } = props
  return (
    <YStack
      backgroundColor={c.tint.r.bg}
      borderColor={c.tint.r.bd}
      borderWidth={1}
      borderRadius={10}
      paddingVertical={10}
      paddingHorizontal={12}
      gap={4}
    >
      <XStack gap={6} alignItems="center">
        <AlertCircle size={13} color={c.tint.r.tx} />
        <T step="sm" color={c.tint.r.tx}>
          {title ?? "Error"}
        </T>
      </XStack>
      {message ? (
        <T step="code" color={c.tint.r.tx} selectable>
          {message}
        </T>
      ) : null}
      {details ? (
        <T
          step="code"
          tone="text2"
          numberOfLines={8}
          style={{ fontSize: 11, lineHeight: 15 }}
          selectable
        >
          {details}
        </T>
      ) : null}
      {hint ? (
        <T step="12" tone="text3">
          {hint}
        </T>
      ) : null}
    </YStack>
  )
}

export function SuccessBlock({ message }: { message: string }) {
  const c = useColors()
  return (
    <XStack
      backgroundColor={c.tint.g.bg}
      borderRadius={10}
      paddingVertical={8}
      paddingHorizontal={12}
      alignItems="center"
      gap={8}
    >
      <Check size={13} color={colors.green} />
      <T step="12" color={c.tint.g.tx} style={{ flex: 1 }}>
        {message}
      </T>
    </XStack>
  )
}
