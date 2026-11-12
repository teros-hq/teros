/**
 * GettingStartedWidget — Navbar checklist widget
 *
 * Shows an icon with a numeric badge (pending steps).
 * On click, opens a dropdown with 5 checklist items.
 * Each item links to the relevant window.
 *
 * State is computed in real-time via profile.onboarding-status.
 * The widget disappears silently when all 5 items are complete.
 * The user can also dismiss it manually.
 */

import React, { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, View } from "react-native"
import { getTerosClient } from "../../services/terosClientSingleton"
import type { OnboardingStatus } from "../../services/ProfileApi"
import { storage, STORAGE_KEYS } from "../../services/storage"
import { useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import { useColors } from "../mca/primitives/useColors"
import { CountPill, IconBtn, Ph, T } from "../ui/ds"

interface ChecklistItem {
  id: keyof OnboardingStatus
  label: string
  action: () => void
}

interface GettingStartedWidgetProps {
  /** Called when the user opens a window so the navbar can close mobile menu */
  onOpenWindow?: () => void
}

export function GettingStartedWidget({ onOpenWindow }: GettingStartedWidgetProps) {
  const { t } = useTranslation()
  const c = useColors()
  const client = getTerosClient()
  const { openWindow } = useTilingStore()
  const { activeWorkspaceId } = useWorkspaceStore()

  const [status, setStatus] = useState<OnboardingStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => {
    storage.get<string>(STORAGE_KEYS.GETTING_STARTED).then((val) => {
      if (val === "1") setDismissed(true)
    })
  }, [])

  // ── Load status ─────────────────────────────────────────────────────────

  const loadStatus = useCallback(async () => {
    try {
      const s = await client.profile.getOnboardingStatus()
      setStatus(s)
    } catch (err) {
      console.warn("[GettingStartedWidget] Failed to load onboarding status:", err)
    }
  }, [client])

  useEffect(() => {
    if (dismissed) return
    if (client.isConnected()) {
      loadStatus()
    } else {
      const onConnected = () => {
        loadStatus()
        client.off("connected", onConnected)
      }
      client.on("connected", onConnected)
      return () => client.off("connected", onConnected)
    }
  }, [dismissed, loadStatus])

  // Refresh every 30s while open
  useEffect(() => {
    if (!open || dismissed) return
    const id = setInterval(loadStatus, 30_000)
    return () => clearInterval(id)
  }, [open, dismissed, loadStatus])

  // Close dropdown on outside click (web)
  useEffect(() => {
    if (!open || Platform.OS !== "web") return
    const handler = (e: MouseEvent) => {
      const el = document.getElementById("getting-started-widget")
      if (el && !el.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open])

  // ── Actions ──────────────────────────────────────────────────────────────

  const openW = (type: string, props: Record<string, any> = {}) => {
    onOpenWindow?.()
    setOpen(false)
    openWindow(type as any, props)
  }

  const items: ChecklistItem[] = [
    {
      id: "hasProvider",
      label: t("onboarding.connectAProvider"),
      action: () => openW("providers"),
    },
    {
      id: "hasOnboardingCompleted",
      label: t("onboarding.customizeYourAgent"),
      action: () => openW("agent", { agentId: undefined }),
    },
    {
      id: "hasAppWithCredentials",
      label: t("onboarding.configureAppCredentials"),
      action: () => openW("apps", { workspaceId: activeWorkspaceId ?? undefined }),
    },
    {
      id: "hasAppAssigned",
      label: t("onboarding.grantAgentAccessToApps"),
      action: () => openW("apps", { workspaceId: activeWorkspaceId ?? undefined }),
    },
    {
      id: "hasFirstMessage",
      label: t("onboarding.sendYourFirstMessage"),
      action: () => openW("chat", { workspaceId: activeWorkspaceId ?? undefined }),
    },
  ]

  // ── Derived state ────────────────────────────────────────────────────────

  const pendingCount = status ? items.filter((item) => !status[item.id]).length : 0

  // Hide if dismissed or all complete
  if (dismissed) return null
  if (status && pendingCount === 0) return null
  if (!status) return null

  const completedCount = items.filter((i) => status[i.id]).length
  const progressPct = Math.round((completedCount / items.length) * 100)

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <View
      // @ts-ignore — id prop for web click-outside detection
      id="getting-started-widget"
      style={{ position: "relative" }}
    >
      {/* Trigger button */}
      <View style={{ position: "relative" }}>
        <IconBtn
          icon="rocket-launch"
          on={open}
          onPress={() => setOpen((v) => !v)}
          title={t("onboarding.gettingStarted")}
        />
        {pendingCount > 0 && (
          <View style={{ position: "absolute", top: -4, right: -4 }} pointerEvents="none">
            <CountPill n={pendingCount} />
          </View>
        )}
      </View>

      {/* Dropdown */}
      {open && (
        <Pressable
          onPress={(e: any) => e?.stopPropagation?.()} // web-only: stopPropagation not typed in RN events
          style={[
            {
              position: "absolute",
              bottom: Platform.OS === "web" ? 44 : undefined,
              top: Platform.OS !== "web" ? 44 : undefined,
              left: 0,
              width: 280,
              backgroundColor: c.bgStep,
              borderRadius: 16,
              padding: 14,
              zIndex: 9999,
            },
            Platform.OS === "web" ? ({ boxShadow: c.elevRaised, cursor: "default" } as any) : null,
          ]}
        >
          {/* Header */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 10,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Ph name="rocket-launch" size={14} color={c.accent} />
              <T step="sm">{t("onboarding.gettingStarted")}</T>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <T step="codenote" tone="text3">
                {completedCount}/{items.length}
              </T>
              <IconBtn
                icon="x"
                plain
                sm
                onPress={() => {
                  storage.set(STORAGE_KEYS.GETTING_STARTED, "1")
                  setDismissed(true)
                  setOpen(false)
                }}
              />
            </View>
          </View>

          {/* Progress bar */}
          <View
            style={{
              height: 3,
              backgroundColor: c.wash2,
              borderRadius: 2,
              marginBottom: 10,
              overflow: "hidden",
            }}
          >
            <View
              style={[
                { height: 3, width: `${progressPct}%`, backgroundColor: c.accent, borderRadius: 2 },
                Platform.OS === "web" ? ({ transition: "width 0.3s" } as any) : null,
              ]}
            />
          </View>

          {/* Checklist items */}
          <View style={{ gap: 2 }}>
            {items.map((item) => {
              const done = !!status[item.id]
              return (
                <Pressable
                  key={item.id}
                  disabled={done}
                  onPress={done ? undefined : item.action}
                  accessibilityRole="button"
                  style={({ pressed }) => [
                    {
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 10,
                      paddingVertical: 8,
                      paddingHorizontal: 8,
                      borderRadius: 10,
                      backgroundColor: pressed && !done ? c.wash2 : "transparent",
                      opacity: done ? 0.5 : 1,
                    },
                    Platform.OS === "web"
                      ? ({ cursor: done ? "default" : "pointer" } as any)
                      : null,
                  ]}
                >
                  <Ph
                    name={done ? "check-circle" : "circle"}
                    size={16}
                    color={done ? c.tint.g.tx : c.text3}
                    weight={done ? "fill" : "regular"}
                  />
                  <T
                    step="sm"
                    color={done ? c.text2 : c.text}
                    style={[{ flex: 1 }, done ? { textDecorationLine: "line-through" } : null]}
                  >
                    {item.label}
                  </T>
                  {!done && <Ph name="caret-right" size={12} color={c.text3} />}
                </Pressable>
              )
            })}
          </View>
        </Pressable>
      )}
    </View>
  )
}
