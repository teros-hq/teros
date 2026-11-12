/**
 * SystemCapabilitiesSection — the ONE "System capabilities" section (v1.4.4).
 *
 * Renders the platform's system capabilities, completely isolated from the
 * user's third-party apps, in three internal groups (Pablo, 30-oct):
 *
 *   🍃 Ambient      always on, no toggle — one dimmed line each, collapsed
 *                   by default (messaging, conversations, guide, …)
 *   🪟 Toggleable   default ON, Switch toggle per capability + link to its
 *                   window when it has one (memory, tasks, boards, automate,
 *                   workflows)
 *   ⚡ Power        default OFF, explicit activation — visually distinct
 *                   from third-party apps (Terminal = bash+terminal unified,
 *                   Filesystem, Browser, UI)
 *
 * The capability taxonomy lives in @teros/shared (mca/system-capabilities)
 * so backend and UI can never drift. Toggle state is persisted through
 * agent.update (disabledSystemApps / enabledSystemApps, full-list PUT).
 *
 * Two modes:
 *  - agent mode (agentId given): toggles are live — flipping a Switch calls
 *    agent.update for that agent.
 *  - workspace mode (no agentId): read-only view of the capability groups
 *    (defaults), used by the Apps window as a discoverability section.
 */

import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Pressable, View, type ViewStyle } from "react-native"
import {
  SYSTEM_CAPABILITIES,
  type SystemCapabilityDef,
  type SystemCapabilityGroup,
} from "@teros/shared"
import { getTerosClient } from "../services/terosClientSingleton"
import { useTilingStore } from "../store/tilingStore"
import { useColors } from "./mca/primitives/useColors"
import { Badge, LGroup, LRow, Ph, SectionLabel, Switch, T, Tile } from "./ui/ds"

/** Window each capability opens, when it has a dedicated surface. */
const CAPABILITY_WINDOWS: Record<string, { type: string; props?: Record<string, unknown> }> = {
  tasks: { type: "todo" },
  boards: { type: "board" },
  automate: { type: "automate" },
  workflows: { type: "flowList" },
}

/** Icon per capability (Phosphor, kebab-case). */
const CAPABILITY_ICONS: Record<string, string> = {
  memory: "brain",
  tasks: "check-square",
  boards: "kanban",
  automate: "lightning",
  workflows: "git-branch",
  terminal: "terminal-window",
  filesystem: "folder-open",
  browser: "globe",
  ui: "computer-tower",
  messaging: "paper-plane-tilt",
  conversations: "chats",
  guide: "book-open",
  "file-processor": "file-magnifying-glass",
  datetime: "clock",
  feedback: "chat-centered-text",
}

export interface SystemCapabilitiesSectionProps {
  /** Agent context — when present, toggles are live for this agent. */
  agentId?: string
  /** Current per-agent state (from agent.list / agent.updated). */
  disabledSystemApps?: string[]
  enabledSystemApps?: string[]
  /** Called after a successful toggle so the parent can refresh its state. */
  onToggled?: (next: { disabled: string[]; enabled: string[] }) => void
  style?: ViewStyle
}

/**
 * Resolve whether a capability is ON for an agent, mirroring the backend
 * resolution in mca-service.ensureProvisionedApps:
 *   ON iff enabledSystemApps includes any member
 *        || (defaultEnabled && !disabledSystemApps includes any member)
 */
function isCapabilityOn(
  cap: SystemCapabilityDef,
  disabled: Set<string>,
  enabled: Set<string>,
  defaultEnabled: boolean,
): boolean {
  for (const m of cap.mcaIds) {
    if (enabled.has(m)) return true
    if (disabled.has(m)) return false
  }
  return defaultEnabled
}

export function SystemCapabilitiesSection({
  agentId,
  disabledSystemApps,
  enabledSystemApps,
  onToggled,
  style,
}: SystemCapabilitiesSectionProps) {
  const { t } = useTranslation()
  const c = useColors()
  const { openWindow } = useTilingStore()
  const client = getTerosClient()

  const [ambientOpen, setAmbientOpen] = useState(false)
  const [toggling, setToggling] = useState<string | null>(null)
  const [localDisabled, setLocalDisabled] = useState<string[] | null>(null)
  const [localEnabled, setLocalEnabled] = useState<string[] | null>(null)

  // Local override wins until the parent refreshes its state (optimistic).
  const disabled = new Set(localDisabled ?? disabledSystemApps ?? [])
  const enabled = new Set(localEnabled ?? enabledSystemApps ?? [])

  const groups = useMemo(() => {
    const byGroup: Record<SystemCapabilityGroup, SystemCapabilityDef[]> = {
      ambient: [],
      toggleable: [],
      power: [],
    }
    for (const cap of Object.values(SYSTEM_CAPABILITIES)) {
      byGroup[cap.group].push(cap)
    }
    return byGroup
  }, [])

  /** Flip one capability for the target agent via agent.update (PUT lists). */
  const toggleCapability = async (cap: SystemCapabilityDef, next: boolean) => {
    if (!agentId || toggling) return
    setToggling(cap.id)
    // Optimistic local state; rolled back on error by clearing the override.
    const nextDisabled = new Set(localDisabled ?? disabledSystemApps ?? [])
    const nextEnabled = new Set(localEnabled ?? enabledSystemApps ?? [])
    for (const m of cap.mcaIds) {
      if (next) {
        nextDisabled.delete(m)
        nextEnabled.add(m)
      } else {
        nextEnabled.delete(m)
        nextDisabled.add(m)
      }
    }
    const disabledArr = [...nextDisabled]
    const enabledArr = [...nextEnabled]
    setLocalDisabled(disabledArr)
    setLocalEnabled(enabledArr)
    try {
      await client.agent.updateAgent({
        agentId,
        disabledSystemApps: disabledArr,
        enabledSystemApps: enabledArr,
      })
      onToggled?.({ disabled: disabledArr, enabled: enabledArr })
    } catch (err) {
      console.error("Failed to toggle system capability:", err)
      setLocalDisabled(null)
      setLocalEnabled(null)
    } finally {
      setToggling(null)
    }
  }

  const renderCapRow = (cap: SystemCapabilityDef, group: SystemCapabilityGroup) => {
    const isPower = group === "power"
    // Power caps are default-OFF in the manifest (availability.defaultEnabled:
    // false); everything else defaults ON.
    const defaultEnabled = !isPower
    const on = isCapabilityOn(cap, disabled, enabled, defaultEnabled)
    const window = CAPABILITY_WINDOWS[cap.id]
    const icon = CAPABILITY_ICONS[cap.id] ?? "gear"
    const busy = toggling === cap.id

    return (
      <LRow
        key={cap.id}
        padV={10}
        padH={12}
        gap={12}
        style={group === "ambient" ? { opacity: 0.65 } : undefined}
      >
        <Tile sm icon={icon} tone={group === "power" ? (on ? "accent" : "muted") : "muted"} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T step="sm" ellipsis>
            {t(`caps.${cap.id}.name`, { defaultValue: cap.id })}
            {isPower && cap.id === "terminal" ? (
              <T step="12" tone="text3">
                {"  "}
                {t("caps.terminalHint", { defaultValue: "bash + sessions" })}
              </T>
            ) : null}
          </T>
          <T step="12" tone="text3" ellipsis numberOfLines={1}>
            {t(`caps.${cap.id}.desc`, { defaultValue: "" })}
          </T>
        </View>
        {window ? (
          <Pressable
            onPress={() => openWindow(window.type as any, window.props ?? {}, false)}
            style={{ paddingHorizontal: 4 }}
          >
            <Ph name="arrow-square-out" size={14} color={c.text2} />
          </Pressable>
        ) : null}
        {group === "ambient" ? (
          <Badge mono tone="m">
            {t("caps.alwaysOn", { defaultValue: "always on" })}
          </Badge>
        ) : agentId ? (
          <Switch
            on={on}
            disabled={busy}
            onToggle={(next: boolean) => toggleCapability(cap, next)}
          />
        ) : (
          <Badge mono tone={on ? "m" : "muted"}>
            {on
              ? t("caps.defaultOn", { defaultValue: "default on" })
              : t("caps.defaultOff", { defaultValue: "default off" })}
          </Badge>
        )}
      </LRow>
    )
  }

  return (
    <View style={style}>
      <SectionLabel
        label={t("caps.sectionTitle", { defaultValue: "System capabilities" })}
        count={
          Object.keys(SYSTEM_CAPABILITIES).length -
          groups.ambient.length +
          groups.ambient.length // all of them; ambient counted in the collapsed line
        }
      />

      {/* 🪟 Toggleable — default ON, per-agent Switch */}
      {groups.toggleable.length > 0 ? (
        <View style={{ marginBottom: 14 }}>
          <LGroup>{groups.toggleable.map((cap) => renderCapRow(cap, "toggleable"))}</LGroup>
        </View>
      ) : null}

      {/* ⚡ Power — default OFF, explicit activation */}
      {groups.power.length > 0 ? (
        <View style={{ marginBottom: 14 }}>
          <T step="12" tone="text3" style={{ marginBottom: 6 }}>
            {t("caps.powerHint", {
              defaultValue:
                "Off by default — activate explicitly. These give the agent deep access.",
            })}
          </T>
          <LGroup>{groups.power.map((cap) => renderCapRow(cap, "power"))}</LGroup>
        </View>
      ) : null}

      {/* 🍃 Ambient — always on, dimmed, collapsed */}
      {groups.ambient.length > 0 ? (
        <View>
          <Pressable
            onPress={() => setAmbientOpen((v) => !v)}
            style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 }}
          >
            <Ph
              name={ambientOpen ? "caret-down" : "caret-right"}
              size={12}
              color={c.text2}
            />
            <T step="12" tone="text3">
              {t("caps.ambientToggle", {
                count: groups.ambient.length,
                defaultValue: "{{count}} ambient capabilities · always on",
              })}
            </T>
          </Pressable>
          {ambientOpen ? <LGroup>{groups.ambient.map((cap) => renderCapRow(cap, "ambient"))}</LGroup> : null}
        </View>
      ) : null}
    </View>
  )
}
