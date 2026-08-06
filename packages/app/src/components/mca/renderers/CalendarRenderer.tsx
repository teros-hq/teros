/**
 * Google Calendar MCA — Tool Call Renderer entry point.
 *
 * Dispatches each tool call to a dedicated sub-renderer by short name.
 * 11/11 tools covered (Sprint 1 + Sprint 2: -health-check + 10 calendar-*,
 * incluyendo respond-to-event y quick-add-event). `FallbackRenderer` es un
 * warning dev-only — en producción nunca debería renderizarse.
 */

import type React from "react"
import { Text, YStack } from "tamagui"

import {
  Badge,
  FallbackBody,
  colors as globalColors,
  ToolCallCard,
} from "../primitives"
import type { ToolCallRendererProps } from "../types"
import { withPermissionSupport } from "../withPermissionSupport"
import {
  CALENDAR_ICON,
  CreateEventRenderer,
  DeleteEventRenderer,
  FocusTimeRenderer,
  GetColorsRenderer,
  GetEventRenderer,
  GetFreeBusyRenderer,
  GetSettingsRenderer,
  getShortToolName,
  getToolLabel,
  HealthCheckRenderer,
  ImportEventRenderer,
  ListCalendarsRenderer,
  ListEventsRenderer,
  ListInstancesRenderer,
  MoveEventRenderer,
  OutOfOfficeRenderer,
  QuickAddEventRenderer,
  RespondToEventRenderer,
  SearchEventsRenderer,
  toolStatusForPrimitive,
  UpdateEventRenderer,
  WorkingLocationRenderer,
} from "./calendar"

// ============================================================================
// Registry — 19/19 coverage (Sprint 1-4)
// ============================================================================

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  "-health-check": HealthCheckRenderer,
  "calendar-list-calendars": ListCalendarsRenderer,
  "calendar-list-events": ListEventsRenderer,
  "calendar-get-event": GetEventRenderer,
  "calendar-search-events": SearchEventsRenderer,
  "calendar-create-event": CreateEventRenderer,
  "calendar-update-event": UpdateEventRenderer,
  "calendar-delete-event": DeleteEventRenderer,
  "calendar-get-free-busy": GetFreeBusyRenderer,
  "calendar-respond-to-event": RespondToEventRenderer,
  "calendar-quick-add-event": QuickAddEventRenderer,
  // Sprint 4
  "calendar-create-focus-time": FocusTimeRenderer,
  "calendar-create-out-of-office": OutOfOfficeRenderer,
  "calendar-set-working-location": WorkingLocationRenderer,
  "calendar-get-settings": GetSettingsRenderer,
  "calendar-get-colors": GetColorsRenderer,
  "calendar-move-event": MoveEventRenderer,
  "calendar-import-event": ImportEventRenderer,
  "calendar-list-instances": ListInstancesRenderer,
}

// ============================================================================
// FallbackRenderer — dev-only warning
// ============================================================================

function FallbackRenderer({ toolName, input, status, output, error }: ToolCallRendererProps) {
  const shortName = getShortToolName(toolName)

  const badge = __DEV__ ? (
    <Badge text="no renderer" variant="error" />
  ) : status === "completed" ? (
    <Badge text="done" variant="success" />
  ) : status === "failed" ? (
    <Badge text="failed" variant="error" />
  ) : null

  return (
    <ToolCallCard
      status={toolStatusForPrimitive(status)}
      verb={getToolLabel(toolName)}
      iconUri={CALENDAR_ICON}
      badge={badge}
      animateExpand
    >
      {__DEV__ && (
        <YStack
          backgroundColor="rgba(239,68,68,0.12)"
          borderRadius={5}
          padding={8}
          borderWidth={1}
          borderColor="rgba(239,68,68,0.3)"
          gap={2}
          marginBottom={6}
        >
          <Text color={globalColors.badgeError.text} fontSize={10} fontWeight="600">
            [dev] Missing sub-renderer for "{shortName}"
          </Text>
          <Text color={globalColors.secondary} fontSize={9}>
            Register it in the RENDERERS map in CalendarRenderer.tsx.
          </Text>
        </YStack>
      )}
      <FallbackBody status={status} input={input} output={output} error={error} />
    </ToolCallCard>
  )
}

// ============================================================================
// Entry point
// ============================================================================

function CalendarRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName)
  const Renderer = RENDERERS[shortName] ?? FallbackRenderer
  return <Renderer {...props} />
}

export const CalendarToolCallRenderer = withPermissionSupport(CalendarRendererBase)
export default CalendarToolCallRenderer
