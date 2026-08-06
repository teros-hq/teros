/**
 * SessionTraceView — the F2 drill-down of one turn: a session header, the LLM
 * calls and tool executions interleaved in chronological order (each LLM call
 * expandable to its message text), and the direct subagent sessions. This is
 * what lets a turn be inspected inside Teros instead of opening Latitude.
 *
 * Pure presentation: it takes an assembled `SessionTrace` and renders it.
 * Message text uses `<MarkdownContent>` (gotcha: not raw <Text>). Accessibility:
 * statuses are colour + glyph + text, never colour alone.
 */

import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  ExternalLink,
  GitBranch,
  ListTree,
  Loader,
  MessageSquare,
  Wrench,
  XCircle,
} from "@tamagui/lucide-icons"
import { seriesColor } from "@teros/shared"
import { useState } from "react"
import { Linking, Platform } from "react-native"
import { Separator, Text, XStack, YStack } from "tamagui"
import { MarkdownContent } from "../../../components/chat/bubbles/MarkdownContent"
import { tokens } from "../../../components/monitoring/colors"
import { useColors } from "../../../components/mca/primitives/useColors"
import { indicators } from "../../../components/mca/primitives/colors"
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
  STATUS_COLORS,
  type TraceStatusLevel,
  toolStatusLevel,
} from "../format"

/** One cell of the turn-header stat grid (design's 7-up strip). */
function StatCell({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <YStack flex={1} minWidth={104} gap={3} paddingVertical={10} paddingHorizontal={12} backgroundColor={tokens.bgCard}>
      <Text fontSize={10} fontWeight="600" letterSpacing={0.5} textTransform="uppercase" color={tokens.textTertiary} numberOfLines={1}>
        {label}
      </Text>
      <Text fontFamily="$mono" fontSize={15} fontWeight="600" color={color ?? tokens.text} numberOfLines={1}>
        {value}
      </Text>
      {sub ? (
        <Text fontSize={10} color={tokens.textMuted} numberOfLines={1}>
          {sub}
        </Text>
      ) : null}
    </YStack>
  )
}

function StatusBadge({ level, text }: { level: ReturnType<typeof toolStatusLevel>; text: string }) {
  const color = STATUS_COLORS[level]
  return (
    <XStack ai="center" gap={5} aria-label={`Status: ${text}`}>
      <YStack width={8} height={8} borderRadius={4} backgroundColor={color} />
      <Text fontSize={12} fontWeight="600" color={color}>
        {text}
      </Text>
    </XStack>
  )
}

/**
 * Latitude "known signal" badge (F4·C1 return path). Shown when Latitude has
 * clustered this trace's failures into a signal — a clickable banner that deep-
 * links into Latitude. The backend sends only structural data (name/priority/
 * link); the phrase is composed here. Absent signal → nothing rendered.
 */
const SIGNAL_PRIORITY_COLOR: Record<string, string> = {
  urgent: STATUS_COLORS.bad,
  high: STATUS_COLORS.bad,
  medium: STATUS_COLORS.warn,
  low: STATUS_COLORS.muted,
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
  const accent =
    (signal.priority && SIGNAL_PRIORITY_COLOR[signal.priority.toLowerCase()]) || STATUS_COLORS.warn
  const label = `Known Latitude signal: ${signal.name}${
    signal.priority ? ` (${signal.priority} priority)` : ""
  }. Opens in Latitude.`
  return (
    <XStack
      ai="center"
      gap={10}
      padding={12}
      borderRadius={10}
      backgroundColor="rgba(242,153,74,0.08)"
      borderColor="rgba(242,153,74,0.28)"
      borderWidth={1}
      borderLeftWidth={3}
      borderLeftColor={accent}
      cursor="pointer"
      hoverStyle={{ backgroundColor: "rgba(242,153,74,0.14)" }}
      onPress={() => openSignal(signal.deepLinkUrl)}
      aria-label={label}
      role="link"
    >
      <Activity size={16} color={accent} />
      <YStack gap={2} flex={1}>
        <XStack ai="center" gap={8} flexWrap="wrap">
          <Text fontSize={11} color="$gray9" textTransform="uppercase" letterSpacing={0.4}>
            Known signal
          </Text>
          {signal.priority ? (
            <Text fontSize={11} fontWeight="700" color={accent} textTransform="uppercase">
              {signal.priority}
            </Text>
          ) : null}
        </XStack>
        <Text fontSize={13} fontWeight="600" color="$gray12">
          {signal.name}
        </Text>
      </YStack>
      <ExternalLink size={14} color="$gray9" />
    </XStack>
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
  const StatusIcon = LEVEL_ICON[level]
  const channel = session.channelId ? session.channelId.replace(/^ch_(demo_)?/, "") : ""
  return (
    <YStack gap={14} padding={16} borderRadius={12} backgroundColor={tokens.bgInner} borderColor={tokens.border} borderWidth={1}>
      <XStack ai="flex-start" jc="space-between" gap={12} flexWrap="wrap">
        <YStack gap={6} minWidth={0} flex={1}>
          <XStack ai="center" gap={10} flexWrap="wrap">
            <MessageSquare size={16} color={tokens.accent} />
            <Text fontSize={17} fontWeight="660" color={tokens.text}>
              {agentName ?? session.agentId}
            </Text>
            {channel ? (
              <Text fontFamily="$mono" fontSize={12} color={tokens.textTertiary}>
                #{channel}
              </Text>
            ) : null}
          </XStack>
          {userName || workspaceName ? (
            <Text fontSize={12} color={tokens.textTertiary} numberOfLines={1}>
              {[userName, workspaceName].filter(Boolean).join(" · ")}
            </Text>
          ) : null}
          <XStack ai="center" gap={8} flexWrap="wrap">
            {requestedDiffers ? (
              <>
                <Text fontSize={12} color={tokens.textTertiary}>
                  requested
                </Text>
                <Text fontFamily="$mono" fontSize={12} color={tokens.textMuted} textDecorationLine="line-through">
                  {session.provider}·{shortModel(session.modelId)}
                </Text>
                <ArrowRight size={13} color={tokens.textMuted} />
                <Text fontSize={12} color={tokens.textTertiary}>
                  served
                </Text>
              </>
            ) : null}
            <XStack ai="center" gap={6}>
              <YStack width={9} height={9} borderRadius={3} backgroundColor={seriesColor(`${servedProvider}::${servedModel}`)} />
              <Text fontFamily="$mono" fontSize={12} fontWeight="560" color={tokens.text}>
                {servedProvider}·{shortModel(servedModel)}
              </Text>
            </XStack>
            {session.fallbackUsed ? (
              <XStack ai="center" gap={5} paddingVertical={2} paddingHorizontal={8} borderRadius={9999} backgroundColor="rgba(245,158,11,0.12)" borderWidth={1} borderColor="rgba(245,158,11,0.25)">
                <GitBranch size={12} color={tokens.warning} />
                <Text fontFamily="$mono" fontSize={11} fontWeight="600" color={tokens.warning}>
                  fallback
                </Text>
              </XStack>
            ) : null}
          </XStack>
        </YStack>
        <XStack ai="center" gap={7} paddingVertical={6} paddingHorizontal={12} borderRadius={9999} backgroundColor={`${STATUS_COLORS[level]}1A`} borderWidth={1} borderColor={`${STATUS_COLORS[level]}3D`}>
          <StatusIcon size={13} color={STATUS_COLORS[level]} />
          <Text fontSize={13} fontWeight="600" color={STATUS_COLORS[level]}>
            {session.status}
          </Text>
          {session.stopReason ? (
            <Text fontFamily="$mono" fontSize={11} color={tokens.textTertiary} paddingLeft={5}>
              {session.stopReason}
            </Text>
          ) : null}
        </XStack>
      </XStack>

      <XStack flexWrap="wrap" gap={1} borderRadius={8} overflow="hidden" borderWidth={1} borderColor={tokens.border} backgroundColor={tokens.border}>
        <StatCell label="TTFT" value={formatMs(session.ttftMs)} sub="to first token" />
        <StatCell label="Duration" value={formatMs(session.durationMs)} sub="wall clock" />
        <StatCell label="Tokens" value={formatTokens(session.totalTokens)} />
        <StatCell label="Cost" value={formatCost(session.costUsd)} />
        <StatCell label="LLM calls" value={String(session.llmCallCount)} />
        <StatCell label="Tools" value={String(session.toolCallCount)} />
        <StatCell label="Stop reason" value={session.stopReason ?? "—"} color={session.status === "completed" ? STATUS_COLORS.ok : undefined} />
      </XStack>

      {session.status === "errored" && session.errorMessage ? (
        <XStack
          ai="center"
          gap={6}
          padding={8}
          borderRadius={8}
          backgroundColor={indicators.irreversible.bg}
          borderColor={indicators.irreversible.border}
          borderWidth={1}
        >
          <AlertTriangle size={14} color={STATUS_COLORS.bad} />
          <Text fontSize={12} color={STATUS_COLORS.bad}>
            {session.errorKind ? `[${session.errorKind}] ` : ""}
            {session.errorMessage}
          </Text>
        </XStack>
      ) : null}
    </YStack>
  )
}

/** Render a message's text; non-text content (image/file/tool…) shows a typed hint. */
function MessageBody({ message }: { message: TraceMessage }) {
  const c = useColors()
  return (
    <YStack
      gap={8}
      marginTop={8}
      padding={10}
      borderRadius={8}
      backgroundColor={c.bgInner}
    >
      {message.text != null && message.text !== "" ? (
        <MarkdownContent text={message.text} />
      ) : message.contentType === "text" ? (
        <Text fontSize={12} color="$gray9">
          (empty message)
        </Text>
      ) : (
        <Text fontSize={11} color="$gray9">
          {message.contentType} content (not text)
        </Text>
      )}
    </YStack>
  )
}

/* ── Timeline (design F2): LLM calls & tools on one time axis, bar = duration ── */

const COL = { time: 52, icon: 26, main: 196, status: 58 } as const
const ROW_GAP = 10
const TRACK_H = 22

const LEVEL_ICON: Record<TraceStatusLevel, typeof Check> = {
  ok: Check,
  bad: XCircle,
  warn: AlertTriangle,
  muted: Ban,
  info: Loader,
}

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
    <XStack ai="center" gap={ROW_GAP} paddingHorizontal={6} paddingBottom={4} aria-hidden>
      <YStack width={COL.time} />
      <YStack width={COL.icon} />
      <YStack width={COL.main} />
      <YStack flex={1} minWidth={64} height={12} position="relative">
        {ticks.map((t, i) => (
          <Text
            key={t.pct}
            position="absolute"
            left={`${t.pct}%`}
            x={i === 0 ? 0 : i === last ? "-100%" : "-50%"}
            fontSize={9}
            fontFamily="$mono"
            color={tokens.textMuted}
          >
            {t.label}
          </Text>
        ))}
      </YStack>
      <YStack width={COL.status} />
    </XStack>
  )
}

function llmMeta(call: TraceLlmCall): string {
  const parts = [`${formatTokens(call.promptTokens)}→${formatTokens(call.completionTokens)} tok`, formatCost(call.costTotal)]
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
  const [open, setOpen] = useState(false)
  const e = row.event

  const level: TraceStatusLevel = e.kind === "llm" ? "ok" : toolStatusLevel(e.tool.status)
  const barColor = e.kind === "llm" ? tokens.accent : STATUS_COLORS[level]
  const TypeIcon = e.kind === "llm" ? MessageSquare : Wrench
  const StatusIcon = e.kind === "llm" ? MessageSquare : LEVEL_ICON[level]

  const label =
    e.kind === "llm" ? `${e.llm.actualProvider || e.llm.provider}·${shortModel(e.llm.modelId)}` : e.tool.toolName
  const meta = e.kind === "llm" ? llmMeta(e.llm) : toolMeta(e.tool)
  const feedback = e.kind === "llm" ? e.llm.feedback : null

  // Expandable when there is something more to show than the compact row.
  const expandable =
    e.kind === "llm" || (e.kind === "tool" && (!!e.tool.errorMessage || e.tool.inputSizeBytes != null || e.tool.outputSizeBytes != null))

  const end = row.leftPct + row.wPct
  const durAtRight = end > 78 // flip the duration label inside the track when the bar runs long
  const Caret = open ? ChevronDown : ChevronRight

  return (
    <YStack borderBottomWidth={1} borderBottomColor={tokens.border}>
      <XStack
        ai="center"
        gap={ROW_GAP}
        paddingVertical={9}
        paddingHorizontal={6}
        borderRadius={6}
        cursor={expandable ? "pointer" : "default"}
        hoverStyle={expandable ? { backgroundColor: tokens.bgHover } : undefined}
        onPress={expandable ? () => setOpen((v) => !v) : undefined}
        aria-label={`${label} — ${meta}`}
      >
        <Text width={COL.time} textAlign="right" fontFamily="$mono" fontSize={11} color={tokens.textTertiary}>
          +{(row.startMs / 1000).toFixed(2)}s
        </Text>

        <YStack
          width={COL.icon}
          height={COL.icon}
          ai="center"
          jc="center"
          borderRadius={7}
          backgroundColor={`${barColor}26`}
        >
          <TypeIcon size={14} color={barColor} />
        </YStack>

        <YStack width={COL.main} gap={1} minWidth={0}>
          <Text fontSize={13} fontWeight="600" color={tokens.text} numberOfLines={1}>
            {label}
          </Text>
          <XStack ai="center" gap={6}>
            <Text fontFamily="$mono" fontSize={10.5} color={tokens.textTertiary} numberOfLines={1} flexShrink={1}>
              {meta}
            </Text>
            {feedback ? (
              <Text fontSize={10.5} color={feedback.rating === "up" ? STATUS_COLORS.ok : STATUS_COLORS.bad} numberOfLines={1}>
                {feedback.rating === "up" ? "👍" : "👎"}
                {feedback.comment ? ` "${feedback.comment}"` : ""}
              </Text>
            ) : null}
          </XStack>
        </YStack>

        <YStack flex={1} minWidth={64} height={TRACK_H} position="relative">
          <YStack position="absolute" top={TRACK_H / 2} left={0} right={0} height={1} backgroundColor={tokens.border} />
          <YStack
            position="absolute"
            top={(TRACK_H - 12) / 2}
            left={`${row.leftPct}%`}
            width={`${row.wPct}%`}
            height={12}
            borderRadius={4}
            backgroundColor={barColor}
          />
          <Text
            position="absolute"
            top={3}
            left={durAtRight ? undefined : `${end}%`}
            right={durAtRight ? 2 : undefined}
            x={durAtRight ? 0 : 6}
            fontFamily="$mono"
            fontSize={10}
            color={tokens.textTertiary}
            numberOfLines={1}
          >
            {formatMs(row.durMs)}
          </Text>
        </YStack>

        <XStack width={COL.status} ai="center" jc="flex-end" gap={5}>
          <StatusIcon size={14} color={barColor} aria-label={e.kind === "tool" ? `Status: ${e.tool.status}` : "LLM call"} />
          {expandable ? <Caret size={13} color={tokens.textMuted} /> : null}
        </XStack>
      </XStack>

      {open && expandable ? (
        <YStack
          marginLeft={96}
          marginRight={6}
          marginBottom={10}
          padding={10}
          borderRadius={6}
          backgroundColor={tokens.bgDark}
          borderWidth={1}
          borderColor={tokens.border}
          borderLeftWidth={2}
          borderLeftColor={barColor}
          gap={6}
        >
          {e.kind === "llm" ? (
            <>
              <XStack gap={16} flexWrap="wrap">
                {e.llm.ttftMs != null ? <Detail label="TTFT" value={formatMs(e.llm.ttftMs)} /> : null}
                {e.llm.latencyMs != null ? <Detail label="Latency" value={formatMs(e.llm.latencyMs)} /> : null}
                {e.llm.stopReason ? <Detail label="Stop" value={e.llm.stopReason} /> : null}
              </XStack>
              {e.llm.message ? (
                <MessageBody message={e.llm.message} />
              ) : (
                <Text fontSize={12} color={tokens.textTertiary}>
                  Message {e.llm.messageId} not found (may have been compacted or pruned).
                </Text>
              )}
            </>
          ) : (
            <>
              {e.tool.status === "error" && e.tool.errorMessage ? (
                <Text fontSize={11.5} color={STATUS_COLORS.bad}>
                  {e.tool.errorMessage}
                </Text>
              ) : null}
              {e.tool.inputSizeBytes != null || e.tool.outputSizeBytes != null ? (
                <Text fontFamily="$mono" fontSize={11.5} color={tokens.textSecondary}>
                  {formatBytes(e.tool.inputSizeBytes)} in · {formatBytes(e.tool.outputSizeBytes)} out
                </Text>
              ) : null}
            </>
          )}
        </YStack>
      ) : null}
    </YStack>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <XStack gap={5} ai="baseline">
      <Text fontSize={10} textTransform="uppercase" letterSpacing={0.4} color={tokens.textMuted}>
        {label}
      </Text>
      <Text fontFamily="$mono" fontSize={12} color={tokens.textSecondary}>
        {value}
      </Text>
    </XStack>
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
    <XStack
      ai="center"
      gap={10}
      padding={10}
      borderRadius={8}
      backgroundColor={c.bgInner}
      borderColor={c.border}
      borderWidth={1}
      cursor={clickable ? "pointer" : undefined}
      hoverStyle={clickable ? { backgroundColor: c.bgCardHover } : undefined}
      onPress={clickable ? () => onOpen?.(child.sessionUsageId) : undefined}
      aria-label={clickable ? `Open subagent trace ${child.sessionUsageId}` : undefined}
    >
      <CornerDownRight size={14} color="$gray9" />
      <Text fontSize={12} fontWeight="600" color="$gray12">
        {child.agentName ?? child.agentId}
      </Text>
      <StatusBadge level={sessionStatusLevel(child.status)} text={child.status} />
      <XStack flex={1} />
      <Text fontSize={11} color="$gray10">
        {formatTokens(child.totalTokens)} tok · {formatCost(child.costUsd)}
      </Text>
      {clickable ? <ChevronRight size={14} color="$gray9" /> : null}
    </XStack>
  )
}

function SectionTitle({ icon: Icon, title }: { icon: typeof ListTree; title: string }) {
  return (
    <XStack ai="center" gap={8}>
      <Icon size={15} color="$blue10" />
      <Text fontSize={13} fontWeight="600" color="$gray12">
        {title}
      </Text>
    </XStack>
  )
}

export function SessionTraceView({
  trace,
  onOpenChild,
}: {
  trace: SessionTrace
  onOpenChild?: (sessionUsageId: string) => void
}) {
  const c = useColors()
  const timeline = buildTimeline(trace.events, trace.session)
  return (
    <YStack gap={16}>
      {trace.latitudeSignal ? <SignalBadge signal={trace.latitudeSignal} /> : null}
      <TraceHeader session={trace.session} agentName={trace.agentName} userName={trace.userName} workspaceName={trace.workspaceName} />

      <YStack gap={8}>
        <XStack ai="baseline" jc="space-between" gap={12} flexWrap="wrap">
          <SectionTitle icon={ListTree} title={`Timeline · ${trace.events.length} events`} />
          <Text fontSize={11} color={tokens.textTertiary}>
            bar length = duration · click a row to expand
          </Text>
        </XStack>
        {trace.events.length === 0 ? (
          <Text fontSize={13} color="$gray10" padding={12}>
            No LLM calls or tool executions recorded for this turn.
          </Text>
        ) : (
          <YStack>
            <TimelineAxis ticks={timeline.ticks} />
            {timeline.rows.map((r) => (
              <TimelineRow key={r.key} row={r} />
            ))}
          </YStack>
        )}
      </YStack>

      {trace.children.length > 0 ? (
        <YStack gap={8}>
          <Separator borderColor={c.borderStrong} />
          <SectionTitle icon={GitBranch} title={`Subagents · ${trace.children.length}`} />
          {trace.children.map((c) => (
            <ChildRow key={c.sessionUsageId} child={c} onOpen={onOpenChild} />
          ))}
        </YStack>
      ) : null}
    </YStack>
  )
}
