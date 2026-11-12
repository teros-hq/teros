/**
 * Console Window - Muestra logs de console en tiempo real
 *
 * OS prototype chrome: a `PHead` strip (tile + serif title + level filter
 * chips + copy/clear) over a `Card` log list of mono lines on the sheet.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, ScrollView, View } from "react-native"
import { getDateLocale } from "../../i18n"
import { useColors } from "../../components/mca/primitives/useColors"
import { Card, ChipBtn, EmptyState, IconBtn, PHead, T } from "../../components/ui/ds"
import { consoleCapture, type LogEntry } from "./consoleCapture"

interface Props {
  windowId: string
}

type Level = LogEntry["level"]
const LEVELS: Level[] = ["log", "info", "warn", "error", "debug"]

function formatArg(arg: any): string {
  if (arg === null) return "null"
  if (arg === undefined) return "undefined"
  if (typeof arg === "string") return arg
  if (typeof arg === "number" || typeof arg === "boolean") return String(arg)
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`

  try {
    return JSON.stringify(arg, null, 2)
  } catch {
    return String(arg)
  }
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString(getDateLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  })
}

export function ConsoleWindowContent({ windowId }: Props) {
  const { t } = useTranslation()
  const c = useColors()
  const [logs, setLogs] = useState<LogEntry[]>([])
  // Level filter — every level visible by default; a chip toggles one off.
  const [hidden, setHidden] = useState<Set<Level>>(() => new Set())
  const scrollRef = useRef<ScrollView>(null)
  const autoScrollRef = useRef(true)

  // Log level colours — status tints from the theme (error red · warn amber
  // · info violet); plain `log` reads as text2, `debug` as text3.
  const levelColor: Record<Level, string> = {
    log: c.text2,
    info: c.tint.i.tx,
    warn: c.tint.a.tx,
    error: c.tint.r.tx,
    debug: c.text3,
  }

  useEffect(() => {
    // Install capture if not already installed
    consoleCapture.install()

    // Cargar logs existentes
    setLogs(consoleCapture.getLogs())

    // Suscribirse a nuevos logs
    const unsubscribe = consoleCapture.subscribe((entry) => {
      setLogs((prev) => [...prev, entry])
    })

    return unsubscribe
  }, [])

  useEffect(() => {
    // Auto-scroll al final cuando hay nuevos logs
    if (autoScrollRef.current && scrollRef.current) {
      setTimeout(() => {
        scrollRef.current?.scrollToEnd({ animated: false })
      }, 50)
    }
  }, [logs.length])

  const handleClear = () => {
    consoleCapture.clear()
    setLogs([])
  }

  const counts = useMemo(() => {
    const n: Record<Level, number> = { log: 0, info: 0, warn: 0, error: 0, debug: 0 }
    for (const entry of logs) n[entry.level] = (n[entry.level] ?? 0) + 1
    return n
  }, [logs])

  const visible = useMemo(
    () => (hidden.size === 0 ? logs : logs.filter((entry) => !hidden.has(entry.level))),
    [logs, hidden],
  )

  const toggleLevel = useCallback((level: Level) => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(level)) next.delete(level)
      else next.add(level)
      return next
    })
  }, [])

  const handleCopy = useCallback(async () => {
    const text = visible
      .map(
        (entry) =>
          `${formatTime(entry.timestamp)} ${entry.level.toUpperCase()} ${entry.args.map(formatArg).join(" ")}`,
      )
      .join("\n")
    try {
      if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(text)
      }
    } catch {
      // clipboard not available — silently ignore
    }
  }, [visible])

  return (
    <View style={{ flex: 1, backgroundColor: c.bgSheet }}>
      <PHead
        icon="terminal-window"
        title={t("windows.console")}
        right={
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {LEVELS.map((level) => (
              <ChipBtn
                key={level}
                on={!hidden.has(level)}
                count={counts[level]}
                mono
                onPress={() => toggleLevel(level)}
                testID={`console-filter-${level}`}
              >
                {level}
              </ChipBtn>
            ))}
            <T step="codenote" tone="text3" style={{ marginLeft: 6 }}>
              {visible.length} logs
            </T>
            {Platform.OS === "web" ? (
              <IconBtn
                icon="copy"
                plain
                sm
                title={t("common.copy")}
                onPress={handleCopy}
                testID="console-copy"
              />
            ) : null}
            <IconBtn
              icon="trash"
              plain
              sm
              title={t("console.clear", { defaultValue: "Limpiar" })}
              onPress={handleClear}
              testID="console-clear"
            />
          </View>
        }
      />

      {/* Logs */}
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 20 }}
        onScroll={(e) => {
          const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent
          const isAtBottom = layoutMeasurement.height + contentOffset.y >= contentSize.height - 50
          autoScrollRef.current = isAtBottom
        }}
        scrollEventThrottle={100}
      >
        {visible.length === 0 ? (
          <EmptyState
            icon="terminal-window"
            title={
              logs.length === 0
                ? "No logs yet"
                : t("console.allFiltered", { defaultValue: "Nada con estos filtros" })
            }
            text={
              logs.length === 0
                ? t("console.emptyHint", {
                    defaultValue: "Los mensajes de console.* de esta pestaña aparecerán aquí.",
                  })
                : undefined
            }
          />
        ) : (
          <Card pad={8}>
            {visible.map((entry) => (
              <LogLine key={entry.id} entry={entry} color={levelColor[entry.level]} />
            ))}
          </Card>
        )}
      </ScrollView>
    </View>
  )
}

function LogLine({ entry, color }: { entry: LogEntry; color: string }) {
  const c = useColors()
  const [hover, setHover] = useState(false)
  return (
    <View
      {...(Platform.OS === "web"
        ? ({ onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) } as any)
        : {})}
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        paddingVertical: 3,
        paddingHorizontal: 8,
        borderRadius: 6,
        backgroundColor: hover ? c.nest : "transparent",
      }}
    >
      <T
        step="codenote"
        tone="text3"
        numberOfLines={1}
        style={{ width: 108, flexShrink: 0, paddingTop: 2, textTransform: "none" }}
      >
        {formatTime(entry.timestamp)}
      </T>
      <T step="codenote" color={color} style={{ width: 40, flexShrink: 0, paddingTop: 2 }}>
        {entry.level}
      </T>
      <T
        step="code"
        color={entry.level === "error" ? color : c.text}
        selectable
        style={{ flex: 1 }}
      >
        {entry.args.map(formatArg).join(" ")}
      </T>
    </View>
  )
}
