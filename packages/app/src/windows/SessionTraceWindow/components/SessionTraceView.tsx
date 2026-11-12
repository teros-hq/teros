/**
 * SessionTraceView — the F2 drill-down of one turn: a session header card, the
 * Stat tiles, the LLM calls and tool executions interleaved in chronological
 * order as an `LGroup` of rows (each expandable to its message text / detail),
 * and the direct subagent sessions. This is what lets a turn be inspected
 * inside Teros instead of opening Latitude.
 *
 * Pure presentation: it takes an assembled `SessionTrace` and renders it.
 * Message text uses `<MarkdownContent>` (gotcha: not raw <Text>). Accessibility:
 * statuses are colour + glyph + text, never colour alone.
 */

import { seriesColor } from "@teros/shared"
import { useState } from "react"
import { Linking, Platform, Pressable, View } from "react-native"
import { MarkdownContent } from "../../../components/chat/bubbles/MarkdownContent"
import { useColors } from "../../../components/mca/primitives/useColors"
import { Badge, Dot } from "../../../components/ui/ds/Badge"
import { Card, LGroup, LRow, Stat, Stats } from "../../../components/ui/ds/Card"
import { Ph } from "../../../components/ui/ds/Icon"
import { SectionLabel } from "../../../components/ui/ds/Page"
import { T } from "../../../components/ui/ds/Text"
import { Tile } from "../../../components/ui/ds/Tile"
import type {
  LatitudeSignalBadge,
  SessionTrace,
  TraceChild,
  TraceEvent,
  TraceLlmCall,
  TraceSession,
  TraceToolCall,
} from "../../../services/AdminApi"

type TraceMessage = NonNullable<TraceLlmCall["message"]>
import {
  formatBytes,
  formatCost,
  formatMs,
  formatTokens,
  sessionStatusLevel,
  shortModel,
  STATUS_TONE,
  statusColor,
  statusFill,
  type TraceStatusLevel,
  toolStatusLevel,
} from "../format"

function StatusBadge({ level, text }: { level: TraceStatusLevel; text: string }) {
  return (
    <View {...({ "aria-label": `Status: ${text}` } as any)}>
      <Badge tone={STATUS_TONE[level]} dot pill>
        {text}
      </Badge>
    </View>
  )
}

/**
 * Latitude "known signal" badge (F4·C1 return path). Shown when Latitude has
 * clustered this trace's failures into a signal — a clickable banner that deep-
 * links into Latitude. The backend sends only structural data (name/priority/
 * link); the phrase is composed here. Absent signal → nothing rendered.
 */
const SIGNAL_PRIORITY_LEVEL: Record<string, TraceStatusLevel> = {
  urgent: "bad",
  high: "bad",
  medium: "warn",
  low: "muted",
}

function openSignal(url: string) {
  if (!url) return
  if (Platform.OS === "web") {
    window.open(url, "_blank", "noopener,noreferrer")
  } else {
    Linking.openURL(url).catch(() => {})
  }
}

function SignalBadge({ signal }: { signal: LatitudeSignalBadge }) {
  const c = useColors()
  const [hover, setHover] = useState(false)
  const level = (signal.priority && SIGNAL_PRIORITY_LEVEL[signal.priority.toLowerCase()]) || "warn"
  const accent = statusColor(c, level)
  const label = `Known Latitude signal: ${signal.name}${
    signal.priority ? ` (${signal.priority} priority)` : ""
  }. Opens in Latitude.`
  return (
    <Pressable
      onPress={() => openSignal(signal.deepLinkUrl)}
      accessibilityRole="link"
      {...({ "aria-label": label, role: "link" } as any)}
      {...(Platform.OS === "web"
        ? { onHoverIn: () => setHover(true), onHoverOut: () => setHover(false) }
        : {})}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          padding: 14,
          borderRadius: 16,
          backgroundColor: c.tint.a.bg,
          borderWidth: 1,
          borderColor: hover ? c.tint.a.bd : "transparent",
          borderLeftWidth: 3,
          borderLeftColor: statusFill(c, level),
        },
        Platform.OS === "web"
          ? ({ cursor: "pointer", transition: "border-color 0.2s" } as any)
          : null,
      ]}
    >
      <Ph name="pulse" size={16} color={accent} />
      <View style={{ gap: 2, flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <T step="xs" tone="text3">
            Known signal
          </T>
          {signal.priority ? (
            <Badge tone={STATUS_TONE[level]} sm pill>
              {signal.priority}
            </Badge>
          ) : null}
        </View>
        <T step="sm">{signal.name}</T>
      </View>
      <Ph name="arrow-square-out" size={14} color={c.text3} />
    </Pressable>
  )
}

function TraceHeader({
  session,
  agentName,
  userName,
  workspaceName,
}: {
  session: TraceSession
  /** Backend-resolved names (P6); absent → honest fallback to the raw id. */
  agentName?: string
  userName?: string
  workspaceName?: string
}) {
  const c = useColors()
  const servedModel = session.actualModel || session.modelId
  const servedProvider = session.actualProvider || session.provider
  const requestedDiffers =
    !!session.fallbackUsed ||
    (!!session.actualModel && session.actualModel !== session.modelId) ||
    (!!session.actualProvider && session.actualProvider !== session.provider)
  const level = sessionStatusLevel(session.status)
  const channel = session.channelId ? session.channelId.replace(/^ch_(demo_)?/, "") : ""
  return (
    <View style={{ gap: 16 }}>
      <Card pad>
        <View
          style={{
            flexDirection: "row",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <View style={{ gap: 6, minWidth: 0, flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <Tile xs icon="chat-circle" />
              <T step="xl">{agentName ?? session.agentId}</T>
              {channel ? (
                <T step="code" tone="text3">
                  #{channel}
                </T>
              ) : null}
            </View>
            {userName || workspaceName ? (
              <T step="sm" tone="text3" numberOfLines={1}>
                {[userName, workspaceName].filter(Boolean).join(" · ")}
              </T>
            ) : null}
            <T step="code" tone="text3" selectable>
              {session.sessionUsageId}
            </T>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {requestedDiffers ? (
                <>
                  <T step="12" tone="text3">
                    requested
                  </T>
                  <T step="code" tone="text3" style={{ textDecorationLine: "line-through" }}>
                    {session.provider}·{shortModel(session.modelId)}
                  </T>
                  <Ph name="arrow-right" size={13} color={c.text3} />
                  <T step="12" tone="text3">
                    served
                  </T>
                </>
              ) : null}
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Dot color={seriesColor(`${servedProvider}::${servedModel}`)} size={8} />
                <T step="code">
                  {servedProvider}·{shortModel(servedModel)}
                </T>
              </View>
              {session.fallbackUsed ? (
                <Badge tone="a" icon="git-branch" mono pill>
                  fallback
                </Badge>
              ) : null}
            </View>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Badge tone={STATUS_TONE[level]} dot pill lg>
              {session.status}
            </Badge>
            {session.stopReason ? (
              <T step="code" tone="text3">
                {session.stopReason}
              </T>
            ) : null}
          </View>
        </View>

        {session.status === "errored" && session.errorMessage ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              padding: 10,
              marginTop: 14,
              borderRadius: 10,
              backgroundColor: c.tint.r.bg,
              borderWidth: 1,
              borderColor: c.tint.r.bd,
            }}
          >
            <Ph name="warning" size={14} color={c.tint.r.tx} />
            <T step="12" color={c.tint.r.tx} style={{ flex: 1 }}>
              {session.errorKind ? `[${session.errorKind}] ` : ""}
              {session.errorMessage}
            </T>
          </View>
        ) : null}
      </Card>

      <Stats cols={4}>
        <Stat label="TTFT" v={formatMs(session.ttftMs)} sub="to first token" />
        <Stat label="Duration" v={formatMs(session.durationMs)} sub="wall clock" />
        <Stat label="Tokens" v={formatTokens(session.totalTokens)} />
        <Stat label="Cost" v={formatCost(session.costUsd)} />
        <Stat label="LLM calls" v={String(session.llmCallCount)} />
        <Stat label="Tools" v={String(session.toolCallCount)} />
        <Stat
          label="Stop reason"
          v={session.stopReason ?? "—"}
          accent={session.status === "completed"}
        />
      </Stats>
    </View>
  )
}

/** Render a message's text; non-text content (image/file/tool…) shows a typed hint. */
function MessageBody({ message }: { message: TraceMessage }) {
  const c = useColors()
  return (
    <View
      style={{ gap: 8, marginTop: 8, padding: 12, borderRadius: 10, backgroundColor: c.bgStep }}
    >
      {message.text != null && message.text !== "" ? (
        <MarkdownContent text={message.text} />
      ) : message.contentType === "text" ? (
        <T step="12" tone="text3">
          (empty message)
        </T>
      ) : (
        <T step="12" tone="text3">
          {message.contentType} content (not text)
        </T>
      )}
    </View>
  )
}

/* ── Timeline (design F2): LLM calls & tools on one time axis, bar = duration ── */

const COL = { time: 56, icon: 28, main: 200, status: 96 } as const
const ROW_GAP = 12
const TRACK_H = 22

interface TimelineRowData {
  key: string
  event: TraceEvent
  startMs: number
  durMs: number
  leftPct: number
  wPct: number
}

export function eventDurationMs(e: TraceEvent): number {
  const raw = e.kind === "llm" ? e.llm.latencyMs : e.tool.durationMs
  return raw != null && Number.isFinite(raw) && raw > 0 ? raw : 0
}

/**
 * Lay out each event on a shared time axis. Real timestamps are used when they
 * actually differ; otherwise the events are placed end-to-start sequentially so
 * the bars still read as a duration waterfall (production `at` values can be
 * coarse or identical — see the channel_messages join gotcha). Everything is
 * scaled to a "nice" total so the axis ticks land on round numbers.
 */
export function buildTimeline(events: TraceEvent[], session: TraceSession) {
  const durs = events.map(eventDurationMs)
  const ats = events.map((e) => Date.parse(e.at))
  const allValid = ats.every((t) => Number.isFinite(t))
  const t0 = allValid ? Math.min(...ats) : 0
  const spread = allValid ? Math.max(...ats) - t0 : 0

  let starts: number[]
  if (allValid && spread > 0) {
    starts = ats.map((t) => t - t0)
  } else {
    starts = []
    let acc = 0
    for (let i = 0; i < events.length; i++) {
      starts.push(acc)
      acc += durs[i]!
    }
  }

  const rawTotal = Math.max(1, session.durationMs ?? 0, ...starts.map((s, i) => s + durs[i]!))
  const mag = 10 ** Math.floor(Math.log10(rawTotal))
  const total = Math.ceil(rawTotal / (mag / 2)) * (mag / 2) || rawTotal

  const rows: TimelineRowData[] = events.map((e, i) => ({
    key: `e${i}`,
    event: e,
    startMs: starts[i]!,
    durMs: durs[i]!,
    leftPct: (starts[i]! / total) * 100,
    wPct: Math.max(1.4, (durs[i]! / total) * 100),
  }))

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    pct: f * 100,
    label: total >= 1000 ? `${+((f * total) / 1000).toFixed(2)}s` : `${Math.round(f * total)}ms`,
  }))

  return { rows, ticks }
}

/** The tick strip above the rows — spacers mirror the row columns so ticks land on the track. */
function TimelineAxis({ ticks }: { ticks: { pct: number; label: string }[] }) {
  const last = ticks.length - 1
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: ROW_GAP,
        paddingHorizontal: 16,
        paddingVertical: 8,
      }}
      {...({ "aria-hidden": true } as any)}
    >
      <View style={{ width: COL.time }} />
      <View style={{ width: COL.icon }} />
      <View style={{ width: COL.main }} />
      <View style={{ flex: 1, minWidth: 64, height: 12, position: "relative" }}>
        {ticks.map((t, i) => (
          <T
            key={t.pct}
            step="codenote"
            tone="text3"
            style={[
              { position: "absolute", left: `${t.pct}%` },
              Platform.OS === "web"
                ? ({
                    transform:
                      i === 0 ? "none" : i === last ? "translateX(-100%)" : "translateX(-50%)",
                  } as any)
                : null,
            ]}
          >
            {t.label}
          </T>
        ))}
      </View>
      <View style={{ width: COL.status }} />
    </View>
  )
}

function llmMeta(call: TraceLlmCall): string {
  const parts = [
    `${formatTokens(call.promptTokens)}→${formatTokens(call.completionTokens)} tok`,
    formatCost(call.costTotal),
  ]
  if (call.step != null) parts.push(`step ${call.step}`)
  return parts.join(" · ")
}

function toolMeta(tool: TraceToolCall): string {
  const parts: string[] = [tool.status]
  if (tool.mcaId) parts.push(tool.mcaId)
  if (tool.inputSizeBytes != null || tool.outputSizeBytes != null) {
    parts.push(`${formatBytes(tool.inputSizeBytes)} in · ${formatBytes(tool.outputSizeBytes)} out`)
  }
  return parts.join(" · ")
}

/** One timeline row: time · type-icon · label/meta · duration bar · status. Expandable. */
function TimelineRow({ row }: { row: TimelineRowData }) {
  const c = useColors()
  const [open, setOpen] = useState(false)
  const e = row.event

  const level: TraceStatusLevel = e.kind === "llm" ? "info" : toolStatusLevel(e.tool.status)
  const barColor = e.kind === "llm" ? c.accent : statusFill(c, level)
  const tileTone =
    e.kind === "llm"
      ? "accent"
      : level === "ok"
        ? "mint"
        : level === "warn"
          ? "amber"
          : level === "bad"
            ? "pink"
            : "muted"

  const label =
    e.kind === "llm"
      ? `${e.llm.actualProvider || e.llm.provider}·${shortModel(e.llm.modelId)}`
      : e.tool.toolName
  const meta = e.kind === "llm" ? llmMeta(e.llm) : toolMeta(e.tool)
  const feedback = e.kind === "llm" ? e.llm.feedback : null

  // Expandable when there is something more to show than the compact row.
  const expandable =
    e.kind === "llm" ||
    (e.kind === "tool" &&
      (!!e.tool.errorMessage || e.tool.inputSizeBytes != null || e.tool.outputSizeBytes != null))

  const end = row.leftPct + row.wPct
  const durAtRight = end > 78 // flip the duration label inside the track when the bar runs long

  return (
    <View>
      <LRow
        gap={ROW_GAP}
        padV={10}
        onPress={expandable ? () => setOpen((v) => !v) : undefined}
        {...({ "aria-label": `${label} — ${meta}` } as any)}
      >
        <T step="code" tone="text3" style={{ width: COL.time, textAlign: "right" }}>
          +{(row.startMs / 1000).toFixed(2)}s
        </T>

        <Tile xs tone={tileTone} icon={e.kind === "llm" ? "chat-circle" : "wrench"} />

        <View style={{ width: COL.main, gap: 1, minWidth: 0 }}>
          <T step="sm" numberOfLines={1}>
            {label}
          </T>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <T step="code" tone="text3" numberOfLines={1} style={{ flexShrink: 1, fontSize: 10.5 }}>
              {meta}
            </T>
            {feedback ? (
              <T
                step="12"
                color={feedback.rating === "up" ? c.tint.g.tx : c.tint.r.tx}
                numberOfLines={1}
              >
                {feedback.rating === "up" ? "👍" : "👎"}
                {feedback.comment ? ` "${feedback.comment}"` : ""}
              </T>
            ) : null}
          </View>
        </View>

        <View style={{ flex: 1, minWidth: 64, height: TRACK_H, position: "relative" }}>
          <View
            style={{
              position: "absolute",
              top: TRACK_H / 2,
              left: 0,
              right: 0,
              height: 1,
              backgroundColor: c.border,
            }}
          />
          <View
            style={{
              position: "absolute",
              top: (TRACK_H - 6) / 2,
              left: `${row.leftPct}%`,
              width: `${row.wPct}%`,
              height: 6,
              borderRadius: 3,
              backgroundColor: barColor,
            }}
          />
          <T
            step="code"
            tone="text3"
            numberOfLines={1}
            style={[
              { position: "absolute", top: 3, fontSize: 10 },
              durAtRight ? { right: 2 } : { left: `${end}%`, paddingLeft: 6 },
            ]}
          >
            {formatMs(row.durMs)}
          </T>
        </View>

        <View
          style={{
            width: COL.status,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 6,
          }}
        >
          {e.kind === "tool" ? (
            <StatusBadge level={level} text={e.tool.status} />
          ) : (
            <Badge tone="i" sm pill icon="chat-circle">
              LLM
            </Badge>
          )}
          {expandable ? (
            <Ph name={open ? "caret-down" : "caret-right"} size={12} color={c.text3} />
          ) : null}
        </View>
      </LRow>

      {open && expandable ? (
        <View
          style={{
            marginLeft: 16 + COL.time + ROW_GAP + COL.icon + ROW_GAP,
            marginRight: 16,
            marginBottom: 12,
            padding: 12,
            borderRadius: 10,
            backgroundColor: c.nest,
            borderLeftWidth: 2,
            borderLeftColor: barColor,
            gap: 6,
          }}
        >
          {e.kind === "llm" ? (
            <>
              <View style={{ flexDirection: "row", gap: 16, flexWrap: "wrap" }}>
                {e.llm.ttftMs != null ? (
                  <Detail label="TTFT" value={formatMs(e.llm.ttftMs)} />
                ) : null}
                {e.llm.latencyMs != null ? (
                  <Detail label="Latency" value={formatMs(e.llm.latencyMs)} />
                ) : null}
                {e.llm.stopReason ? <Detail label="Stop" value={e.llm.stopReason} /> : null}
              </View>
              {e.llm.message ? (
                <MessageBody message={e.llm.message} />
              ) : (
                <T step="12" tone="text3">
                  Message {e.llm.messageId} not found (may have been compacted or pruned).
                </T>
              )}
            </>
          ) : (
            <>
              {e.tool.status === "error" && e.tool.errorMessage ? (
                <T step="12" color={c.tint.r.tx}>
                  {e.tool.errorMessage}
                </T>
              ) : null}
              {e.tool.inputSizeBytes != null || e.tool.outputSizeBytes != null ? (
                <T step="code" tone="text2">
                  {formatBytes(e.tool.inputSizeBytes)} in · {formatBytes(e.tool.outputSizeBytes)}{" "}
                  out
                </T>
              ) : null}
            </>
          )}
        </View>
      ) : null}
    </View>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", gap: 6, alignItems: "baseline" }}>
      <T step="codenote" tone="text3">
        {label}
      </T>
      <T step="code" tone="text2">
        {value}
      </T>
    </View>
  )
}

function ChildRow({
  child,
  onOpen,
}: {
  child: TraceChild
  onOpen?: (sessionUsageId: string) => void
}) {
  const c = useColors()
  const clickable = !!onOpen
  return (
    <LRow
      onPress={clickable ? () => onOpen?.(child.sessionUsageId) : undefined}
      {...(clickable
        ? ({ "aria-label": `Open subagent trace ${child.sessionUsageId}` } as any)
        : {})}
    >
      <Ph name="arrow-elbow-down-right" size={14} color={c.text3} />
      <T step="sm">{child.agentName ?? child.agentId}</T>
      <StatusBadge level={sessionStatusLevel(child.status)} text={child.status} />
      <View style={{ flex: 1 }} />
      <T step="code" tone="text3">
        {formatTokens(child.totalTokens)} tok · {formatCost(child.costUsd)}
      </T>
      {clickable ? <Ph name="caret-right" size={14} color={c.text3} /> : null}
    </LRow>
  )
}

export function SessionTraceView({
  trace,
  onOpenChild,
}: {
  trace: SessionTrace
  onOpenChild?: (sessionUsageId: string) => void
}) {
  const timeline = buildTimeline(trace.events, trace.session)
  return (
    <View style={{ gap: 16 }}>
      {trace.latitudeSignal ? <SignalBadge signal={trace.latitudeSignal} /> : null}
      <TraceHeader
        session={trace.session}
        agentName={trace.agentName}
        userName={trace.userName}
        workspaceName={trace.workspaceName}
      />

      <View>
        <SectionLabel
          label={`Timeline · ${trace.events.length} events`}
          right={
            <T step="12" tone="text3">
              bar length = duration · click a row to expand
            </T>
          }
        />
        {trace.events.length === 0 ? (
          <T step="sm" tone="text3" style={{ paddingHorizontal: 4 }}>
            No LLM calls or tool executions recorded for this turn.
          </T>
        ) : (
          <LGroup>
            <TimelineAxis ticks={timeline.ticks} />
            {timeline.rows.map((r) => (
              <TimelineRow key={r.key} row={r} />
            ))}
          </LGroup>
        )}
      </View>

      {trace.children.length > 0 ? (
        <View>
          <SectionLabel label={`Subagents · ${trace.children.length}`} />
          <LGroup>
            {trace.children.map((ch) => (
              <ChildRow key={ch.sessionUsageId} child={ch} onOpen={onOpenChild} />
            ))}
          </LGroup>
        </View>
      ) : null}
    </View>
  )
}
