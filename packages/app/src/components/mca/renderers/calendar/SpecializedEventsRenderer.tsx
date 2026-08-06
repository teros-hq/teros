/**
 * Calendar Renderer — Specialized event-type tools (Sprint 4)
 *
 * Sub-renderers:
 *  - FocusTime  → focusTime event with autoDecline + chatStatus.
 *  - OutOfOffice → OOO with autoDecline + reply.
 *  - WorkingLocation → home / office / custom.
 *  - MoveEvent → cross-calendar transfer.
 *  - ImportEvent → external (.ics) import with iCalUID.
 *  - ListInstances → instances of a recurring event with override flag.
 *
 * All sub-renderers compose only global primitives + prop factories from
 * `./shared`. No local components.
 */

import { Linking, ScrollView } from "react-native"
import { Text, XStack, YStack } from "tamagui"
import {
  Brain,
  Calendar,
  Download,
  DualEntity,
  Empty,
  EntityRow,
  ErrorBlock,
  ExternalLink,
  colors as globalColors,
  IconChip,
  IconTile,
  KeyValueGrid,
  type KeyValueRow,
  Plane,
  parseOutput,
  ResourceCard,
  SuccessBlock,
} from "../../primitives"
import type { ToolCallRendererProps } from "../../types"
import {
  type CalendarEvent,
  CalendarToolShell,
  EVENT_TYPE_COLORS,
  eventLeadingTileProps,
  formatEventTime,
  formatTimestampWithZone,
  unwrap,
  unwrapList,
  useScrollStyle,
  workingLocationIcon,
  workingLocationLabel,
} from "./shared"

// ============================================================================
// Shared types for the Sprint-4 outputs
// ============================================================================

interface MutationOutput {
  success?: boolean
  account?: string
  calendarId?: string
  eventId?: string | null
  event?: CalendarEvent
  sendUpdates?: "all" | "externalOnly" | "none"
}

// ============================================================================
// FocusTimeRenderer — calendar-create-focus-time
// ============================================================================

export function FocusTimeRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const raw = output ? parseOutput<MutationOutput>(output) : null
  const parsed = raw && typeof raw === "object" ? raw : null
  const event = parsed?.event ?? unwrap<CalendarEvent>(parsed, "event")
  const accent = EVENT_TYPE_COLORS.focusTime
  const props = event?.focusTimeProperties

  return (
    <CalendarToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <ResourceCard
          leading={<IconTile accent={accent} icon={<Brain size={12} color={accent} />} size={28} />}
          title={event?.summary ?? "Focus time"}
          subtitle={event ? formatEventTime(event) : undefined}
          verb="created"
        >
          {props && (
            <XStack flexWrap="wrap" gap={4}>
              {props.chatStatus && (
                <IconChip text={`chat: ${props.chatStatus}`} accent={accent} outline />
              )}
              {props.autoDeclineMode && (
                <IconChip
                  text={humanizeDeclineMode(props.autoDeclineMode)}
                  accent={accent}
                  outline
                />
              )}
            </XStack>
          )}
          {props?.declineMessage && (
            <YStack gap={3}>
              <Text
                textTransform="uppercase"
                color={globalColors.muted}
                fontSize={9}
                fontFamily="$mono"
              >
                auto-reply
              </Text>
              <Text color={globalColors.primary} fontSize={11}>
                "{props.declineMessage}"
              </Text>
            </YStack>
          )}
        </ResourceCard>
      )}
    </CalendarToolShell>
  )
}

// ============================================================================
// OutOfOfficeRenderer — calendar-create-out-of-office
// ============================================================================

export function OutOfOfficeRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const raw = output ? parseOutput<MutationOutput>(output) : null
  const parsed = raw && typeof raw === "object" ? raw : null
  const event = parsed?.event ?? unwrap<CalendarEvent>(parsed, "event")
  const accent = EVENT_TYPE_COLORS.outOfOffice
  const props = event?.outOfOfficeProperties

  return (
    <CalendarToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <ResourceCard
          leading={<IconTile accent={accent} icon={<Plane size={12} color={accent} />} size={28} />}
          title={event?.summary ?? "Out of office"}
          subtitle={event ? formatEventTime(event) : undefined}
          verb="created"
        >
          {props?.autoDeclineMode && (
            <IconChip text={humanizeDeclineMode(props.autoDeclineMode)} accent={accent} outline />
          )}
          {props?.declineMessage && (
            <YStack gap={3}>
              <Text
                textTransform="uppercase"
                color={globalColors.muted}
                fontSize={9}
                fontFamily="$mono"
              >
                auto-reply
              </Text>
              <Text color={globalColors.primary} fontSize={11}>
                "{props.declineMessage}"
              </Text>
            </YStack>
          )}
        </ResourceCard>
      )}
    </CalendarToolShell>
  )
}

// ============================================================================
// WorkingLocationRenderer — calendar-set-working-location
// ============================================================================

export function WorkingLocationRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const raw = output ? parseOutput<MutationOutput>(output) : null
  const parsed = raw && typeof raw === "object" ? raw : null
  const event = parsed?.event ?? unwrap<CalendarEvent>(parsed, "event")
  const accent = EVENT_TYPE_COLORS.workingLocation
  const props = event?.workingLocationProperties

  return (
    <CalendarToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <ResourceCard
          leading={
            <IconTile accent={accent} icon={workingLocationIcon(props?.type, accent)} size={28} />
          }
          title={workingLocationLabel(props)}
          subtitle={event ? formatEventTime(event) : undefined}
          verb="created"
        >
          <KeyValueGrid rows={workingLocationDetailRows(event ?? undefined, props)} />
        </ResourceCard>
      )}
    </CalendarToolShell>
  )
}

function workingLocationDetailRows(
  event: CalendarEvent | undefined,
  props: CalendarEvent["workingLocationProperties"],
): KeyValueRow[] {
  const rows: KeyValueRow[] = []
  if (props?.type) rows.push({ key: "type", value: props.type })
  if (props?.officeLocation?.buildingId)
    rows.push({ key: "building", value: props.officeLocation.buildingId })
  if (props?.officeLocation?.deskId) rows.push({ key: "desk", value: props.officeLocation.deskId })
  if (event?.start)
    rows.push({ key: "start", value: formatTimestampWithZone(event.start, event.timeZone) })
  if (event?.end)
    rows.push({ key: "end", value: formatTimestampWithZone(event.end, event.timeZone) })
  return rows
}

// ============================================================================
// MoveEventRenderer — calendar-move-event
// ============================================================================

interface MoveOutput {
  success?: boolean
  account?: string
  eventId?: string
  sourceCalendarId?: string
  destinationCalendarId?: string
  event?: CalendarEvent
  sendUpdates?: "all" | "externalOnly" | "none"
}

export function MoveEventRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const raw = output ? parseOutput<MoveOutput>(output) : null
  const parsed = raw && typeof raw === "object" ? raw : null
  const event = parsed?.event ?? unwrap<CalendarEvent>(parsed, "event")
  const sourceId = parsed?.sourceCalendarId ?? "?"
  const destId = parsed?.destinationCalendarId ?? "?"
  const sendUpdates = parsed?.sendUpdates ?? "none"

  return (
    <CalendarToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <YStack gap={6}>
          <DualEntity
            left={{
              visual: (
                <IconTile
                  accent={globalColors.muted}
                  icon={<Calendar size={12} color={globalColors.muted} />}
                  size={28}
                />
              ),
              title: shortenCalendarId(sourceId),
              subtitle: "from",
            }}
            right={{
              visual: (
                <IconTile
                  accent={EVENT_TYPE_COLORS.default}
                  icon={<Calendar size={12} color={EVENT_TYPE_COLORS.default} />}
                  size={28}
                />
              ),
              title: shortenCalendarId(destId),
              subtitle: "to",
            }}
            action="transfer"
            meta={event?.summary ?? "Event moved"}
          />
          {sendUpdates !== "none" && (
            <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
              notifications: sent{" "}
              {sendUpdates === "all" ? "to all attendees" : "to external attendees only"}
            </Text>
          )}
        </YStack>
      )}
    </CalendarToolShell>
  )
}

function shortenCalendarId(id: string): string {
  if (id === "primary") return "primary"
  if (id.includes("@")) return id.split("@")[0].slice(0, 14)
  return id.length <= 16 ? id : `${id.slice(0, 14)}…`
}

// ============================================================================
// ImportEventRenderer — calendar-import-event
// ============================================================================

interface ImportOutput {
  success?: boolean
  account?: string
  calendarId?: string
  eventId?: string | null
  iCalUID?: string
  event?: CalendarEvent
  sendUpdates?: "all" | "externalOnly" | "none"
}

export function ImportEventRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const raw = output ? parseOutput<ImportOutput>(output) : null
  const parsed = raw && typeof raw === "object" ? raw : null
  const event = parsed?.event ?? unwrap<CalendarEvent>(parsed, "event")
  const iCalUID = parsed?.iCalUID ?? event?.iCalUID

  return (
    <CalendarToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <ResourceCard
          leading={
            event ? (
              <IconTile {...eventLeadingTileProps(event, 28)} />
            ) : (
              <IconTile
                accent={EVENT_TYPE_COLORS.default}
                icon={<Download size={12} color={EVENT_TYPE_COLORS.default} />}
                size={28}
              />
            )
          }
          title={event?.summary ?? "Imported event"}
          subtitle={event ? formatEventTime(event) : undefined}
          verb="created"
          meta={<IconChip text="imported" accent={globalColors.muted} outline />}
        >
          <KeyValueGrid
            rows={[
              { key: "iCalUID", value: iCalUID ? truncate(iCalUID, 40) : "—" },
              { key: "calendarId", value: parsed?.calendarId ?? "primary" },
              ...(event?.start
                ? [{ key: "start", value: formatTimestampWithZone(event.start, event.timeZone) }]
                : []),
              ...(event?.end
                ? [{ key: "end", value: formatTimestampWithZone(event.end, event.timeZone) }]
                : []),
            ]}
          />
          {parsed?.success && <SuccessBlock message="External event linked into your calendar." />}
        </ResourceCard>
      )}
    </CalendarToolShell>
  )
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}

// ============================================================================
// ListInstancesRenderer — calendar-list-instances
// ============================================================================

interface ListInstancesOutput {
  account?: string
  calendarId?: string
  eventId?: string
  instances?: CalendarEvent[]
  total?: number
  hasMore?: boolean
  nextCursor?: string | null
}

export function ListInstancesRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const raw = output ? parseOutput<ListInstancesOutput>(output) : null
  const parsed = raw && typeof raw === "object" ? raw : null
  const list = parsed ? unwrapList<CalendarEvent>(parsed, "instances") : { items: [] }
  const instances = list.items
  const description = parsed?.eventId ? `Instances of ${shortenEventId(parsed.eventId)}` : undefined
  const scrollStyle = useScrollStyle(360)

  return (
    <CalendarToolShell
      toolName={toolName}
      status={status}
      description={description}
      defaultExpanded={false}
    >
      {error && <ErrorBlock error={error} />}
      {!error &&
        status === "completed" &&
        (instances.length === 0 ? (
          <Empty message="No instances in this range" />
        ) : (
          <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
            <YStack>
              {instances.map((instance) => {
                const isOverride =
                  instance.originalStartTime !== undefined &&
                  instance.originalStartTime !== instance.start
                return (
                  <EntityRow
                    key={instance.id ?? Math.random().toString(36)}
                    leading={<IconTile {...eventLeadingTileProps(instance, 22)} />}
                    title={
                      instance.summary && instance.summary.length > 0
                        ? instance.summary
                        : "(no title)"
                    }
                    subtitle={formatEventTime(instance)}
                    badges={
                      isOverride ? <IconChip text="override" accent="#F4511E" outline /> : undefined
                    }
                    onPress={
                      instance.htmlLink
                        ? () => Linking.openURL(instance.htmlLink as string)
                        : undefined
                    }
                    trailing={
                      instance.htmlLink ? (
                        <ExternalLink size={12} color={globalColors.muted} />
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

function shortenEventId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 6)}…${id.slice(-4)}`
}

// ============================================================================
// Helpers
// ============================================================================

function humanizeDeclineMode(mode: string): string {
  if (mode === "declineNone") return "no auto-decline"
  if (mode === "declineAllConflictingInvitations") return "auto-decline all conflicts"
  if (mode === "declineOnlyNewConflictingInvitations") return "auto-decline new conflicts"
  return mode
}
