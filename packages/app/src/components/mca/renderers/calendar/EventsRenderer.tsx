/**
 * Calendar Renderer — Events domain
 *
 * Sub-renderers: List, Get, Create, Update, Delete, Search, RespondToEvent (RSVP),
 * QuickAddEvent (NLP).
 *
 * Composes only global primitives + prop factories from `./shared`.
 * No local components. Backend-data-driven (responseStatus, organizer,
 * colorId, hangoutLink, recurrenceDescription) drives every visual choice.
 */

import type React from "react"
import { useTranslation } from "react-i18next"
import { Linking, ScrollView } from "react-native"
import { Text, XStack, YStack } from "tamagui"
import { MarkdownContent } from "../../../chat/bubbles/MarkdownContent"
import {
  Avatar,
  Calendar,
  CalendarClock,
  type DualAction,
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
  PillList,
  parseOutput,
  ResourceCard,
  Sparkles,
  SuccessBlock,
} from "../../primitives"
import type { ToolCallRendererProps } from "../../types"
import {
  attachmentChipProps,
  attendeeChipProps,
  type CalendarAttachment,
  type CalendarAttendee,
  type CalendarEvent,
  CalendarToolShell,
  COLOR_DEFAULT,
  eventLeadingTileProps,
  eventTypeChipProps,
  formatEventTime,
  formatTimestampWithZone,
  getMyAttendee,
  meetChipProps,
  parseRecurrence,
  RSVP_COLORS,
  rsvpChipProps,
  unwrap,
  unwrapList,
  useScrollStyle,
  workingLocationLabel,
} from "./shared"

// ============================================================================
// Local helpers (data shaping for the renderer — no UI components)
// ============================================================================

function eventBadges(event: CalendarEvent, myEmail?: string): React.ReactNode {
  const me = getMyAttendee(event.attendees, myEmail)
  const rsvp = rsvpChipProps(me?.responseStatus)
  const hasMeet = Boolean(event.hangoutLink) || Boolean(event.conferenceData?.entryPoints?.length)
  // eventType chip va PRIMERO para destacar la naturaleza del evento.
  const typeChip = eventTypeChipProps(event.eventType)
  if (!typeChip && !rsvp && !hasMeet) return null
  return (
    <XStack gap={4} alignItems="center">
      {typeChip ? <IconChip {...typeChip} /> : null}
      {rsvp ? <IconChip {...rsvp} /> : null}
      {hasMeet ? <IconChip {...meetChipProps()} /> : null}
    </XStack>
  )
}

function eventRowSubtitle(event: CalendarEvent): string {
  const time = formatEventTime(event)
  const attendees = event.attendees?.length
  if (!attendees) return time
  return `${time} · ${attendees} attendee${attendees === 1 ? "" : "s"}`
}

function eventDetailRows(event: CalendarEvent): KeyValueRow[] {
  const rows: KeyValueRow[] = []
  rows.push({ key: "start", value: formatTimestampWithZone(event.start, event.timeZone) })
  rows.push({ key: "end", value: formatTimestampWithZone(event.end, event.timeZone) })
  if (event.location) rows.push({ key: "location", value: event.location })
  const recurrence = event.recurrenceDescription ?? parseRecurrence(event.recurrence)
  if (recurrence) rows.push({ key: "recurrence", value: recurrence })
  if (event.organizer) {
    const name = event.organizer.displayName ?? event.organizer.email ?? "—"
    const email =
      event.organizer.email && event.organizer.email !== name ? ` (${event.organizer.email})` : ""
    rows.push({ key: "organizer", value: `${name}${email}` })
  }
  if (event.creator && event.creator.email !== event.organizer?.email) {
    const name = event.creator.displayName ?? event.creator.email ?? "—"
    rows.push({ key: "creator", value: name })
  }
  if (event.status) rows.push({ key: "status", value: event.status })
  if (event.htmlLink) rows.push({ key: "link", value: event.htmlLink })
  if (event.hangoutLink) rows.push({ key: "meet", value: event.hangoutLink })
  if (typeof event.sequence === "number")
    rows.push({ key: "sequence", value: String(event.sequence) })
  // Sprint 4 — specialized eventType properties surfaced contextually.
  if (event.focusTimeProperties) {
    if (event.focusTimeProperties.chatStatus)
      rows.push({ key: "chatStatus", value: event.focusTimeProperties.chatStatus })
    if (event.focusTimeProperties.autoDeclineMode)
      rows.push({ key: "autoDecline", value: event.focusTimeProperties.autoDeclineMode })
  }
  if (event.outOfOfficeProperties) {
    if (event.outOfOfficeProperties.autoDeclineMode)
      rows.push({ key: "autoDecline", value: event.outOfOfficeProperties.autoDeclineMode })
  }
  if (event.workingLocationProperties) {
    rows.push({
      key: "workingLocation",
      value: workingLocationLabel(event.workingLocationProperties),
    })
  }
  return rows
}

function attendeesPills(attendees: CalendarAttendee[] | undefined): React.ReactElement[] {
  if (!attendees || attendees.length === 0) return []
  return attendees.map((att) => (
    <IconChip key={att.email ?? Math.random().toString(36)} {...attendeeChipProps(att)} />
  ))
}

function attachmentsPills(attachments: CalendarAttachment[] | undefined): React.ReactElement[] {
  if (!attachments || attachments.length === 0) return []
  return attachments.map((att, idx) => (
    <XStack
      key={att.fileId ?? att.fileUrl ?? idx}
      onPress={att.fileUrl ? () => Linking.openURL(att.fileUrl) : undefined}
      cursor={att.fileUrl ? "pointer" : undefined}
    >
      <IconChip {...attachmentChipProps(att)} />
    </XStack>
  ))
}

interface ListEventsOutput {
  account?: string
  calendarId?: string
  events?: CalendarEvent[]
  total?: number
  hasMore?: boolean
  nextCursor?: string | null
}

interface SingleEventOutput {
  account?: string
  calendarId?: string
  event?: CalendarEvent
}

interface MutationOutput {
  success?: boolean
  account?: string
  calendarId?: string
  eventId?: string | null
  event?: CalendarEvent
  sendUpdates?: "all" | "externalOnly" | "none"
  meetGenerated?: boolean
  attendeeChange?:
    | { mode: "merge"; added: number; removed: number }
    | { mode: "replace"; total: number }
}

interface DeleteOutput {
  success?: boolean
  account?: string
  calendarId?: string
  eventId?: string
  sendUpdates?: "all" | "externalOnly" | "none"
}

// ============================================================================
// ListEventsRenderer
// ============================================================================

export function ListEventsRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const raw = output ? parseOutput<ListEventsOutput>(output) : null
  const parsed = raw && typeof raw === "object" ? raw : null
  const list = parsed ? unwrapList<CalendarEvent>(parsed, "events") : { items: [] }
  const events = list.items
  const account = parsed?.account
  const scrollStyle = useScrollStyle(360)

  const filters: string[] = []
  if (input?.calendarId && input.calendarId !== "primary")
    filters.push(`calendar ${input.calendarId}`)
  if (input?.startDate && input?.endDate) {
    filters.push(`${shortDate(String(input.startDate))} → ${shortDate(String(input.endDate))}`)
  }
  const description = filters.length ? `Events (${filters.join(", ")})` : undefined

  return (
    <CalendarToolShell
      toolName={toolName}
      status={status}
      description={description}
      defaultExpanded={false}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <>
          {events.length === 0 ? (
            <Empty message="No events in this range" />
          ) : (
            <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
              <YStack>
                {events.map((event) => (
                  <EntityRow
                    key={event.id ?? Math.random().toString(36)}
                    leading={<IconTile {...eventLeadingTileProps(event)} />}
                    title={event.summary && event.summary.length > 0 ? event.summary : "(no title)"}
                    subtitle={eventRowSubtitle(event)}
                    badges={eventBadges(event, account)}
                    meta={
                      event.timeZone ? (
                        <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
                          {event.timeZone}
                        </Text>
                      ) : undefined
                    }
                    onPress={
                      event.htmlLink ? () => Linking.openURL(event.htmlLink as string) : undefined
                    }
                    trailing={
                      event.htmlLink ? (
                        <ExternalLink size={12} color={globalColors.muted} />
                      ) : undefined
                    }
                  />
                ))}
              </YStack>
            </ScrollView>
          )}
          {(list.nextCursor || typeof list.total === "number" || list.hasMore) && (
            <XStack gap={6} justifyContent="flex-end" paddingHorizontal={4} paddingTop={2}>
              {typeof list.total === "number" && (
                <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
                  {list.total} shown
                </Text>
              )}
              {list.nextCursor && (
                <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
                  · more
                </Text>
              )}
            </XStack>
          )}
        </>
      )}
    </CalendarToolShell>
  )
}

// ============================================================================
// GetEventRenderer
// ============================================================================

export function GetEventRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const raw = output ? parseOutput<SingleEventOutput>(output) : null
  const parsed = raw && typeof raw === "object" ? raw : null
  const event = unwrap<CalendarEvent>(parsed, "event") ?? parsed?.event
  const account = parsed?.account

  return (
    <CalendarToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && event && (
        <ResourceCard
          leading={<IconTile {...eventLeadingTileProps(event, 36)} />}
          title={event.summary && event.summary.length > 0 ? event.summary : "(no title)"}
          subtitle={formatEventTime(event)}
          meta={eventBadges(event, account)}
        >
          <KeyValueGrid rows={eventDetailRows(event)} />
          {event.attendees && event.attendees.length > 0 && (
            <YStack gap={3}>
              <Text
                textTransform="uppercase"
                color={globalColors.muted}
                fontSize={9}
                fontFamily="$mono"
              >
                attendees
              </Text>
              <PillList items={attendeesPills(event.attendees)} max={10} />
            </YStack>
          )}
          {event.attachments && event.attachments.length > 0 && (
            <YStack gap={3}>
              <Text
                textTransform="uppercase"
                color={globalColors.muted}
                fontSize={9}
                fontFamily="$mono"
              >
                attachments
              </Text>
              <PillList items={attachmentsPills(event.attachments)} max={8} />
            </YStack>
          )}
          {event.description && (
            <YStack gap={3}>
              <Text
                textTransform="uppercase"
                color={globalColors.muted}
                fontSize={9}
                fontFamily="$mono"
              >
                description
              </Text>
              <MarkdownContent text={event.description} />
            </YStack>
          )}
        </ResourceCard>
      )}
    </CalendarToolShell>
  )
}

// ============================================================================
// CreateEventRenderer
// ============================================================================

export function CreateEventRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const { t } = useTranslation()
  const raw = output ? parseOutput<MutationOutput>(output) : null
  const parsed = raw && typeof raw === "object" ? raw : null
  const event = parsed?.event ?? unwrap<CalendarEvent>(parsed, "event")
  const meetGenerated = parsed?.meetGenerated ?? false
  const sendUpdates = parsed?.sendUpdates ?? (input?.sendUpdates as MutationOutput["sendUpdates"])
  const previewTitle =
    event?.summary ??
    (typeof input?.summary === "string" ? input.summary : t("mca.calendar.newEvent"))

  return (
    <CalendarToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <ResourceCard
          leading={
            event ? (
              <IconTile {...eventLeadingTileProps(event)} />
            ) : (
              <IconTile
                accent="#1A73E8"
                icon={<CalendarClock size={11} color="#1A73E8" />}
                size={22}
              />
            )
          }
          title={previewTitle}
          subtitle={event ? formatEventTime(event) : undefined}
          verb="created"
          meta={event ? eventBadges(event, parsed?.account) : undefined}
        >
          {event && <KeyValueGrid rows={eventDetailRows(event)} />}
          {meetGenerated && event?.hangoutLink && (
            <SuccessBlock message={`Meet link generated · ${event.hangoutLink}`} />
          )}
          {sendUpdates && sendUpdates !== "none" && (
            <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
              notifications: sent{" "}
              {sendUpdates === "all" ? "to all attendees" : "to external attendees only"}
            </Text>
          )}
        </ResourceCard>
      )}
    </CalendarToolShell>
  )
}

// ============================================================================
// UpdateEventRenderer
// ============================================================================

export function UpdateEventRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const raw = output ? parseOutput<MutationOutput>(output) : null
  const parsed = raw && typeof raw === "object" ? raw : null
  const event = parsed?.event ?? unwrap<CalendarEvent>(parsed, "event")
  const sendUpdates = parsed?.sendUpdates ?? (input?.sendUpdates as MutationOutput["sendUpdates"])
  const change = parsed?.attendeeChange
  const id = String(input?.eventId ?? parsed?.eventId ?? "")

  return (
    <CalendarToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <ResourceCard
          leading={
            event ? (
              <IconTile {...eventLeadingTileProps(event)} />
            ) : (
              <IconTile
                accent="#F2994A"
                icon={<CalendarClock size={11} color="#F2994A" />}
                size={22}
              />
            )
          }
          title={event?.summary ?? `Updated ${shortIdEnding(id)}`}
          subtitle={event ? formatEventTime(event) : undefined}
          verb="updated"
          meta={event ? eventBadges(event, parsed?.account) : undefined}
        >
          {event && <KeyValueGrid rows={eventDetailRows(event)} />}
          {change?.mode === "merge" && (
            <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
              attendees: +{change.added} / −{change.removed}
            </Text>
          )}
          {change?.mode === "replace" && (
            <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
              attendees replaced ({change.total} total)
            </Text>
          )}
          {sendUpdates && sendUpdates !== "none" && (
            <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
              notifications: sent{" "}
              {sendUpdates === "all" ? "to all attendees" : "to external attendees only"}
            </Text>
          )}
        </ResourceCard>
      )}
    </CalendarToolShell>
  )
}

// ============================================================================
// DeleteEventRenderer
// ============================================================================

export function DeleteEventRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const raw = output ? parseOutput<DeleteOutput>(output) : null
  const parsed = raw && typeof raw === "object" ? raw : null
  const id = String(input?.eventId ?? parsed?.eventId ?? "")
  const calendarId = parsed?.calendarId ?? (input?.calendarId as string | undefined) ?? "primary"
  const sendUpdates =
    parsed?.sendUpdates ?? (input?.sendUpdates as DeleteOutput["sendUpdates"]) ?? "none"

  return (
    <CalendarToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <ResourceCard
          leading={
            <IconTile
              accent="#D50000"
              icon={<CalendarClock size={11} color="#D50000" />}
              size={22}
            />
          }
          title={`Deleted ${shortIdEnding(id) || "event"}`}
          subtitle="Permanently removed — cannot be undone."
          verb="deleted"
        >
          {parsed?.success && (
            <SuccessBlock
              message={
                sendUpdates !== "none"
                  ? "Event deleted; cancellation notice sent."
                  : "Event deleted."
              }
            />
          )}
          <KeyValueGrid
            rows={[
              { key: "eventId", value: id || "—" },
              { key: "calendarId", value: calendarId },
              { key: "notifications", value: sendUpdates === "none" ? "silent" : sendUpdates },
            ]}
          />
        </ResourceCard>
      )}
    </CalendarToolShell>
  )
}

// ============================================================================
// SearchEventsRenderer
// ============================================================================

export function SearchEventsRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const raw = output ? parseOutput<ListEventsOutput & { query?: string }>(output) : null
  const parsed = raw && typeof raw === "object" ? raw : null
  const list = parsed ? unwrapList<CalendarEvent>(parsed, "events") : { items: [] }
  const events = list.items
  const account = parsed?.account
  const query = parsed?.query ?? (typeof input?.query === "string" ? input.query : "")
  const description = query ? `Search · "${query}"` : undefined
  const scrollStyle = useScrollStyle(360)

  return (
    <CalendarToolShell
      toolName={toolName}
      status={status}
      description={description}
      defaultExpanded={false}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <>
          {events.length === 0 ? (
            <Empty message="No events match this query" />
          ) : (
            <ScrollView style={scrollStyle} showsVerticalScrollIndicator>
              <YStack>
                {events.map((event) => (
                  <EntityRow
                    key={event.id ?? Math.random().toString(36)}
                    leading={<IconTile {...eventLeadingTileProps(event)} />}
                    title={event.summary && event.summary.length > 0 ? event.summary : "(no title)"}
                    subtitle={eventRowSubtitle(event)}
                    badges={eventBadges(event, account)}
                    onPress={
                      event.htmlLink ? () => Linking.openURL(event.htmlLink as string) : undefined
                    }
                    trailing={
                      event.htmlLink ? (
                        <ExternalLink size={12} color={globalColors.muted} />
                      ) : undefined
                    }
                  />
                ))}
              </YStack>
            </ScrollView>
          )}
          {(list.nextCursor || typeof list.total === "number") && (
            <XStack gap={6} justifyContent="flex-end" paddingHorizontal={4} paddingTop={2}>
              {typeof list.total === "number" && (
                <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
                  {list.total} shown
                </Text>
              )}
              {list.nextCursor && (
                <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
                  · more
                </Text>
              )}
            </XStack>
          )}
        </>
      )}
    </CalendarToolShell>
  )
}

// ============================================================================
// Internal helpers
// ============================================================================

function shortDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ]
  return `${months[d.getMonth()]} ${d.getDate()}`
}

function shortIdEnding(id: string): string {
  if (!id) return ""
  return id.length <= 8 ? id : `…${id.slice(-6)}`
}

// ============================================================================
// RespondToEventRenderer (Sprint 2 — RSVP)
// ============================================================================

interface RespondOutput {
  success?: boolean
  account?: string
  calendarId?: string
  eventId?: string
  eventSummary?: string | null
  response?: "accepted" | "declined" | "tentative"
  previousResponse?: "accepted" | "declined" | "tentative" | null
  sendUpdates?: "all" | "externalOnly" | "none"
  addedAttendee?: boolean
}

const RSVP_ACTION: Record<NonNullable<RespondOutput["response"]>, DualAction> = {
  accepted: "grant",
  declined: "revoke",
  tentative: "role-change",
}

export function RespondToEventRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const { t } = useTranslation()
  const raw = output ? parseOutput<RespondOutput>(output) : null
  const parsed = raw && typeof raw === "object" ? raw : null
  const response = (parsed?.response ??
    (input?.response as RespondOutput["response"]) ??
    "tentative") as NonNullable<RespondOutput["response"]>
  const summary = parsed?.eventSummary ?? "(event)"
  const account = parsed?.account ?? "you"
  const previous = parsed?.previousResponse
  const sendUpdates = parsed?.sendUpdates ?? "none"
  const accent = RSVP_COLORS[response] ?? RSVP_COLORS.needsAction

  return (
    <CalendarToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <YStack gap={6}>
          <DualEntity
            left={{
              visual: <Avatar name={account} size={28} />,
              title: account,
              subtitle: "you",
            }}
            right={{
              visual: (
                <IconTile accent={accent} icon={<Calendar size={12} color={accent} />} size={28} />
              ),
              title: summary || "(event)",
              subtitle:
                parsed?.eventId && parsed.eventId.length > 8
                  ? `…${parsed.eventId.slice(-6)}`
                  : (parsed?.eventId ?? undefined),
            }}
            action={RSVP_ACTION[response]}
            meta={
              previous && previous !== response
                ? `was ${previous}`
                : t("mca.calendar.markedTentative")
            }
          />
          {sendUpdates !== "none" && (
            <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
              notifications: sent{" "}
              {sendUpdates === "all" ? "to organizer + attendees" : "to external attendees only"}
            </Text>
          )}
          {parsed?.addedAttendee && (
            <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
              note: you were not in the attendee list and have been added.
            </Text>
          )}
        </YStack>
      )}
    </CalendarToolShell>
  )
}

// ============================================================================
// QuickAddEventRenderer (Sprint 2 — NLP shortcut)
// ============================================================================

interface QuickAddOutput {
  success?: boolean
  account?: string
  calendarId?: string
  eventId?: string | null
  sourceText?: string
  event?: CalendarEvent
  sendUpdates?: "all" | "externalOnly" | "none"
}

export function QuickAddEventRenderer({
  toolName,
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const { t } = useTranslation()
  const raw = output ? parseOutput<QuickAddOutput>(output) : null
  const parsed = raw && typeof raw === "object" ? raw : null
  const event = parsed?.event ?? unwrap<CalendarEvent>(parsed, "event")
  const sourceText =
    parsed?.sourceText ?? (typeof input?.text === "string" ? input.text : undefined)
  const sendUpdates = parsed?.sendUpdates ?? "none"
  const previewTitle =
    event?.summary && event.summary.length > 0
      ? event.summary
      : (sourceText ?? t("mca.calendar.quickAdd"))

  return (
    <CalendarToolShell toolName={toolName} status={status} defaultExpanded={false}>
      {error && <ErrorBlock error={error} />}
      {!error && status === "completed" && (
        <ResourceCard
          leading={
            event ? (
              <IconTile {...eventLeadingTileProps(event)} />
            ) : (
              <IconTile
                accent={COLOR_DEFAULT}
                icon={<Sparkles size={12} color={COLOR_DEFAULT} />}
                size={22}
              />
            )
          }
          title={previewTitle}
          subtitle={event ? formatEventTime(event) : undefined}
          verb="created"
          meta={event ? eventBadges(event, parsed?.account) : undefined}
        >
          {sourceText && (
            <YStack gap={3}>
              <Text
                textTransform="uppercase"
                color={globalColors.muted}
                fontSize={9}
                fontFamily="$mono"
              >
                from
              </Text>
              <Text color={globalColors.primary} fontSize={11}>
                "{sourceText}"
              </Text>
            </YStack>
          )}
          {event && <KeyValueGrid rows={eventDetailRows(event)} />}
          {sendUpdates !== "none" && (
            <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
              notifications: sent{" "}
              {sendUpdates === "all" ? "to all attendees" : "to external attendees only"}
            </Text>
          )}
        </ResourceCard>
      )}
    </CalendarToolShell>
  )
}
