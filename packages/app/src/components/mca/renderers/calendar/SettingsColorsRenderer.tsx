/**
 * Calendar Renderer — Settings + Colors (Sprint 4)
 *
 * Tools de configuración del user (read-only). Composición pura sobre
 * primitivos globales.
 */

import { Palette, Settings } from '../../primitives'
import type React from "react"
import { useTranslation } from "react-i18next"
import { Text, XStack, YStack } from "tamagui"

import {
  ErrorBlock,
  colors as globalColors,
  IconChip,
  IconTile,
  KeyValueGrid,
  type KeyValueRow,
  parseOutput,
  ResourceCard,
} from "../../primitives"
import type { ToolCallRendererProps } from "../../types"
import { CalendarToolShell, COLOR_DEFAULT } from "./shared"

// ============================================================================
// GetSettingsRenderer — calendar-get-settings
// ============================================================================

interface SettingsOutput {
  account?: string
  setting?: { id: string; value: string } | unknown
  settings?: Record<string, string> | unknown
  total?: number
}

const SETTING_LABELS: Record<string, string> = {
  timezone: "Timezone",
  locale: "Locale",
  weekStart: "Week start",
  dateFieldOrder: "Date format",
  autoAddHangouts: "Auto-add Meet",
  remindOnRespondedEventsOnly: "Reminders only on responded",
  format24HourTime: "24-hour clock",
  hideInvitations: "Hide invitations",
  defaultEventLength: "Default event length",
  showDeclinedEvents: "Show declined events",
  useKeyboardShortcuts: "Keyboard shortcuts",
}

export function GetSettingsRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const { t } = useTranslation()
  const raw = output ? parseOutput<SettingsOutput>(output) : null
  const parsed = raw && typeof raw === "object" ? raw : null
  const single =
    parsed?.setting && typeof parsed.setting === "object" && "id" in (parsed.setting as object)
      ? (parsed.setting as { id: string; value: string })
      : null
  const map =
    parsed?.settings && typeof parsed.settings === "object" && !Array.isArray(parsed.settings)
      ? (parsed.settings as Record<string, string>)
      : null

  const rows: KeyValueRow[] = single
    ? [{ key: humanSettingKey(single.id), value: humanSettingValue(single.id, single.value) }]
    : map
      ? Object.entries(map).map(([id, value]) => ({
          key: humanSettingKey(id),
          value: humanSettingValue(id, value),
        }))
      : []

  return (
    <CalendarToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={false}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <ResourceCard
          leading={
            <IconTile
              accent={COLOR_DEFAULT}
              icon={<Settings size={14} color={COLOR_DEFAULT} />}
              size={28}
            />
          }
          title={single ? (SETTING_LABELS[single.id] ?? single.id) : t("mca.calendar.preferences")}
          subtitle={
            !single && parsed?.account
              ? `${parsed.account}${typeof parsed.total === "number" ? ` · ${parsed.total} settings` : ""}`
              : single?.value
          }
        >
          {rows.length > 0 && <KeyValueGrid rows={rows} />}
        </ResourceCard>
      )}
    </CalendarToolShell>
  )
}

function humanSettingKey(id: string): string {
  return SETTING_LABELS[id] ?? id
}

function humanSettingValue(id: string, value: string): string {
  if (id === "weekStart") {
    // Google encodes as "0"=Sunday..."6"=Saturday
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    const n = Number.parseInt(value, 10)
    if (!Number.isNaN(n) && n >= 0 && n <= 6) return days[n]
  }
  if (value === "true") return "Yes"
  if (value === "false") return "No"
  return value
}

// ============================================================================
// GetColorsRenderer — calendar-get-colors
// ============================================================================

interface ColorsOutput {
  account?: string
  colors?: {
    kind?: string
    updated?: string
    event?: Record<string, { background?: string; foreground?: string }>
    calendar?: Record<string, { background?: string; foreground?: string }>
  }
}

const EVENT_COLOR_LABELS: Record<string, string> = {
  "1": "Lavender",
  "2": "Sage",
  "3": "Grape",
  "4": "Flamingo",
  "5": "Banana",
  "6": "Tangerine",
  "7": "Peacock",
  "8": "Graphite",
  "9": "Blueberry",
  "10": "Basil",
  "11": "Tomato",
}

export function GetColorsRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const { t } = useTranslation()
  const raw = output ? parseOutput<ColorsOutput>(output) : null
  const parsed = raw && typeof raw === "object" ? raw : null
  const colors = parsed?.colors
  const eventColors = colors?.event ? Object.entries(colors.event) : []
  const calendarColors = colors?.calendar ? Object.entries(colors.calendar) : []

  return (
    <CalendarToolShell
      toolName={toolName}
      status={status}
      defaultExpanded={false}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <ResourceCard
          leading={
            <IconTile
              accent={COLOR_DEFAULT}
              icon={<Palette size={14} color={COLOR_DEFAULT} />}
              size={28}
            />
          }
          title={t("mca.calendar.googlePalette")}
          subtitle={colors?.updated ? `updated ${colors.updated}` : undefined}
        >
          {eventColors.length > 0 && (
            <YStack gap={3}>
              <Text
                textTransform="uppercase"
                color={globalColors.muted}
                fontSize={9}
                fontFamily="$mono"
              >
                event colors
              </Text>
              <XStack flexWrap="wrap" gap={4}>
                {eventColors.map(([id, def]) => (
                  <IconChip
                    key={`event-${id}`}
                    text={EVENT_COLOR_LABELS[id] ? `${id} · ${EVENT_COLOR_LABELS[id]}` : id}
                    accent={(def as { background?: string }).background ?? COLOR_DEFAULT}
                  />
                ))}
              </XStack>
            </YStack>
          )}
          {calendarColors.length > 0 && (
            <YStack gap={3}>
              <Text
                textTransform="uppercase"
                color={globalColors.muted}
                fontSize={9}
                fontFamily="$mono"
              >
                calendar colors
              </Text>
              <XStack flexWrap="wrap" gap={4}>
                {calendarColors.map(([id, def]) => (
                  <IconChip
                    key={`cal-${id}`}
                    text={id}
                    accent={(def as { background?: string }).background ?? COLOR_DEFAULT}
                    outline
                  />
                ))}
              </XStack>
            </YStack>
          )}
        </ResourceCard>
      )}
    </CalendarToolShell>
  )
}
