/**
 * Calendar Renderer — `get-free-busy`.
 *
 * Renderiza una visión compacta por calendario:
 *   - cabecera con resumen ("3 slots" / "free" / "errors").
 *   - lista de slots como chips horizontales (start–end + minutos).
 *
 * El backend ya devuelve los slots curados con `durationMinutes`. Este
 * renderer no calcula nada — solo compone.
 */

import type React from "react"
import { Text, XStack, YStack } from "tamagui"

import {
  Empty,
  ErrorBlock,
  colors as globalColors,
  IconChip,
  KeyValueGrid,
  type KeyValueRow,
  parseOutput,
  ResourceCard,
} from "../../primitives"
import type { ToolCallRendererProps } from "../../types"
import { CalendarToolShell, type FreeBusyRow, formatTimestampWithZone } from "./shared"

interface FreeBusyOutput {
  account?: string
  timeMin?: string
  timeMax?: string
  calendars?: FreeBusyRow[]
}

function formatBusySummary(row: FreeBusyRow): string {
  if (row.errors && row.errors.length > 0) {
    return `error: ${row.errors[0].reason ?? "unknown"}`
  }
  if (row.busy.length === 0) return "free"
  const total = row.busy.reduce((acc, slot) => acc + slot.durationMinutes, 0)
  return `busy ${row.busy.length} slot${row.busy.length === 1 ? "" : "s"} · ${total} min`
}

function busyChips(row: FreeBusyRow): React.ReactElement[] {
  return row.busy.map((slot, idx) => (
    <IconChip
      key={`${slot.startISO}-${idx}`}
      text={`${shortTime(slot.startISO)}–${shortTime(slot.endISO)} (${slot.durationMinutes}m)`}
      accent="#D50000"
      outline
    />
  ))
}

function shortTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const h = d.getHours().toString().padStart(2, "0")
  const m = d.getMinutes().toString().padStart(2, "0")
  return `${h}:${m}`
}

export function GetFreeBusyRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const raw = output ? parseOutput<FreeBusyOutput>(output) : null
  const parsed = raw && typeof raw === "object" ? raw : null
  const calendars = parsed?.calendars ?? []
  const range =
    parsed?.timeMin && parsed?.timeMax
      ? `${formatTimestampWithZone(parsed.timeMin)} → ${formatTimestampWithZone(parsed.timeMax)}`
      : undefined

  const summaryRows: KeyValueRow[] = calendars.map((row: FreeBusyRow) => ({
    key: row.calendarId,
    value: formatBusySummary(row),
  }))

  return (
    <CalendarToolShell
      toolName={toolName}
      status={status}
      description={
        calendars.length > 0
          ? `Free / busy · ${calendars.length} calendar${calendars.length === 1 ? "" : "s"}`
          : undefined
      }
      defaultExpanded={false}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <ResourceCard title={range ?? "Free / busy"}>
          {calendars.length === 0 ? (
            <Empty message="No calendars in response" />
          ) : (
            <>
              <KeyValueGrid rows={summaryRows} />
              {calendars
                .filter((row: FreeBusyRow) => row.busy.length > 0)
                .map((row: FreeBusyRow) => (
                  <YStack key={row.calendarId} gap={3}>
                    <Text
                      textTransform="uppercase"
                      color={globalColors.muted}
                      fontSize={9}
                      fontFamily="$mono"
                    >
                      {row.calendarId}
                    </Text>
                    <XStack flexWrap="wrap" gap={4}>
                      {busyChips(row)}
                    </XStack>
                  </YStack>
                ))}
            </>
          )}
        </ResourceCard>
      )}
    </CalendarToolShell>
  )
}
