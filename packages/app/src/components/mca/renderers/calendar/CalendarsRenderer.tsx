/**
 * Calendar Renderer — Calendars domain (`list-calendars`).
 *
 * Solo primitivos globales + helpers de props de `./shared`.
 */

import type React from "react"
import { ScrollView } from "react-native"
import { Text, XStack, YStack } from "tamagui"

import {
  Empty,
  EntityRow,
  ErrorBlock,
  colors as globalColors,
  IconChip,
  IconTile,
  parseOutput,
} from "../../primitives"
import type { ToolCallRendererProps } from "../../types"
import {
  type CalendarRef,
  CalendarToolShell,
  calendarTileProps,
  unwrapList,
  useScrollStyle,
} from "./shared"

interface ListCalendarsOutput {
  account?: string
  calendars?: CalendarRef[]
  total?: number
  hasMore?: boolean
  nextCursor?: string | null
}

function calendarBadges(calendar: CalendarRef): React.ReactNode {
  const chips: React.ReactNode[] = []
  if (calendar.primary) {
    chips.push(<IconChip key="primary" text="primary" accent="#0B8043" outline />)
  }
  if (calendar.selected) {
    chips.push(<IconChip key="selected" text="selected" accent="#3F51B5" outline />)
  }
  if (chips.length === 0) return null
  return (
    <XStack gap={4} alignItems="center">
      {chips}
    </XStack>
  )
}

export function ListCalendarsRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<ListCalendarsOutput>(output) : null
  const list = parsed ? unwrapList<CalendarRef>(parsed, "calendars") : { items: [] }
  const calendars = list.items
  const scrollStyle = useScrollStyle(360)

  return (
    <CalendarToolShell
      toolName={toolName}
      status={status}
      description={
        typeof list.total === "number" && list.total > 0 ? `Calendars (${list.total})` : undefined
      }
      defaultExpanded={false}
    >
      {error && <ErrorBlock error={error} />}
      {!error &&
        status === "completed" &&
        (calendars.length === 0 ? (
          <Empty message="No calendars found" />
        ) : (
          <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
            <YStack>
              {calendars.map((calendar) => {
                const role = calendar.accessRole ?? ""
                const tz = calendar.timeZone ?? ""
                const subtitle = [tz, role].filter(Boolean).join(" · ")
                return (
                  <EntityRow
                    key={calendar.id ?? Math.random().toString(36)}
                    leading={<IconTile {...calendarTileProps(calendar)} />}
                    title={calendar.summary ?? "(unnamed calendar)"}
                    subtitle={subtitle || undefined}
                    badges={calendarBadges(calendar)}
                    meta={
                      calendar.id ? (
                        <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
                          {shortenCalendarId(calendar.id)}
                        </Text>
                      ) : undefined
                    }
                  />
                )
              })}
            </YStack>
          </ScrollView>
        ))}
    </CalendarToolShell>
  )
}

function shortenCalendarId(id: string): string {
  if (id === "primary") return "primary"
  if (id.includes("@")) return id.split("@")[0].slice(0, 12)
  return id.length <= 14 ? id : `${id.slice(0, 12)}…`
}
