/**
 * AutoplayPanel — the prototype's Autoplay side panel for a project board:
 * "Autoplay" · "Runners · slots · Play", one row per runner (avatar, name,
 * state line, slots −/+, the round play/pause, ✕), "+ Add runner" and a
 * footer that explains how Teros wakes runners. Opens from the "Autoplay ·
 * n playing" chip on the hint line (and from the board's more-actions menu)
 * as a right overlay, like the task detail panel.
 */
import type { BoardAgentInfo } from "../../services/BoardApi"
import React, { useRef, useState } from "react"
import { Modal, Platform, Pressable, ScrollView, View } from "react-native"
import { useTranslation } from "react-i18next"
import { Avatar } from "../../components/Avatar"
import { useColors } from "../../components/mca/primitives/useColors"
import { colors as semantic } from "../../components/mca/primitives/colors"
import { ChipBtn, IconBtn, Ph, T } from "../../components/ui/ds"

/** Local UI state for one agent's autoplay config in this project */
export interface AgentRelationshipState {
  agentId: string
  agentName: string
  avatarUrl?: string
  slots: number
  playEnabled: boolean
  activeSlots: number
}

export const AUTOPLAY_PANEL_WIDTH = 320

export interface AutoplayPanelProps {
  relationships: AgentRelationshipState[]
  availableAgents: BoardAgentInfo[]
  onSetSlots: (agentId: string, slots: number) => void
  onSetPlay: (agentId: string, enabled: boolean) => void
  onAddRunner: (agentId: string) => void
  onRemoveRunner: (agentId: string) => void
  onClose: () => void
}

export function AutoplayPanel({
  relationships,
  availableAgents,
  onSetSlots,
  onSetPlay,
  onAddRunner,
  onRemoveRunner,
  onClose,
}: AutoplayPanelProps) {
  const { t } = useTranslation()
  const c = useColors()
  const [showAdd, setShowAdd] = useState(false)
  const [anchor, setAnchor] = useState<{ x: number; y: number; h: number } | null>(null)
  const addRef = useRef<View>(null)

  const addedIds = new Set(relationships.map((r) => r.agentId))
  const candidates = availableAgents.filter((a) => !addedIds.has(a.agentId))

  const openAdd = () => {
    if (addRef.current) {
      addRef.current.measure((_fx, _fy, _w, h, px, py) => {
        setAnchor({ x: px, y: py, h })
        setShowAdd(true)
      })
    } else setShowAdd(true)
  }

  return (
    <View
      testID="autoplay-panel"
      style={[
        {
          position: "absolute",
          right: 0,
          top: 0,
          bottom: 0,
          width: AUTOPLAY_PANEL_WIDTH,
          maxWidth: "100%",
          backgroundColor: c.bgSheet,
          borderLeftWidth: 1,
          borderLeftColor: c.border,
          zIndex: 50,
        },
        Platform.OS === "web" ? ({ boxShadow: c.lift } as any) : null,
      ]}
    >
      {/* Head */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 10,
          paddingHorizontal: 18,
          paddingTop: 18,
          paddingBottom: 14,
          borderBottomWidth: 1,
          borderBottomColor: c.border,
        }}
      >
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Ph name="play-circle" size={20} color={c.accent} />
            <T step="2xl">{t("board.autoplay", { defaultValue: "Autoplay" })}</T>
          </View>
          <T step="12" tone="text3">
            {t("board.autoplaySubtitle", { defaultValue: "Runners · slots · Play" })}
          </T>
        </View>
        <IconBtn
          icon="x"
          plain
          sm
          onPress={onClose}
          title={t("common.close", { defaultValue: "Close" })}
        />
      </View>

      {/* Runners */}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 12 }}>
        {relationships.map((rel) => {
          const stateLine = rel.playEnabled
            ? rel.activeSlots > 0
              ? t("board.runnerWorking", { defaultValue: "Working" })
              : t("board.runnerWaiting", { defaultValue: "Waiting for tasks" })
            : t("board.runnerPaused", { defaultValue: "Paused" })
          return (
            <View
              key={rel.agentId}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingHorizontal: 18,
                paddingVertical: 14,
                borderBottomWidth: 1,
                borderBottomColor: c.border,
              }}
            >
              <Avatar
                name={rel.agentName}
                imageUrl={rel.avatarUrl}
                size={28}
                isAgent
                status={rel.playEnabled ? "live" : "idle"}
              />
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <T step="sm" ellipsis>
                  {rel.agentName}
                </T>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Ph
                    name={rel.playEnabled ? "circle-notch" : "pause"}
                    size={11}
                    color={rel.playEnabled ? c.accent : c.text3}
                  />
                  <T step="12" tone="text3" ellipsis style={{ flexShrink: 1 }}>
                    {stateLine}
                  </T>
                </View>
                <T step="codenote" tone="text3">
                  {t("board.runnerInProgress", {
                    defaultValue: "{{active}}/{{slots}} in progress",
                    active: rel.activeSlots,
                    slots: rel.slots,
                  })}
                </T>
              </View>

              {/* Slots −/+ */}
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <IconBtn
                  icon="minus"
                  sm
                  plain
                  onPress={() => onSetSlots(rel.agentId, Math.max(0, rel.slots - 1))}
                  title={t("board.statusSlots")}
                />
                <T step="sm" style={{ minWidth: 14, textAlign: "center" }}>
                  {String(rel.slots)}
                </T>
                <IconBtn
                  icon="plus"
                  sm
                  plain
                  onPress={() => onSetSlots(rel.agentId, rel.slots + 1)}
                  title={t("board.statusSlots")}
                />
              </View>

              {/* Play / pause — the violet disc while in play */}
              <Pressable
                accessibilityRole="button"
                disabled={rel.slots === 0}
                onPress={() => onSetPlay(rel.agentId, !rel.playEnabled)}
                aria-label={
                  rel.playEnabled
                    ? t("board.statusActive", { defaultValue: "In play" })
                    : t("board.statusPaused", { defaultValue: "Paused" })
                }
                style={({ pressed }) => [
                  {
                    width: 32,
                    height: 32,
                    borderRadius: 16,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: rel.playEnabled ? semantic.purple300 : c.wash2,
                    opacity: rel.slots === 0 ? 0.45 : 1,
                    transform: pressed ? [{ scale: 0.94 }] : undefined,
                  },
                  Platform.OS === "web"
                    ? ({
                        cursor: rel.slots === 0 ? "default" : "pointer",
                        transition: "background 0.25s",
                      } as any)
                    : null,
                ]}
              >
                <Ph
                  name={rel.playEnabled ? "pause" : "play"}
                  weight="fill"
                  size={13}
                  color={rel.playEnabled ? "#FFFFFF" : c.accent}
                />
              </Pressable>

              <IconBtn
                icon="x"
                sm
                plain
                onPress={() => onRemoveRunner(rel.agentId)}
                title={t("board.unassign")}
              />
            </View>
          )
        })}

        {/* + Add runner */}
        <View style={{ paddingHorizontal: 18, paddingTop: 14 }}>
          <View ref={addRef} collapsable={false} style={{ alignSelf: "flex-start" }}>
            <ChipBtn icon="plus" on={showAdd} onPress={openAdd}>
              {t("board.addRunner")}
            </ChipBtn>
          </View>
        </View>
      </ScrollView>

      {/* Footer: how it works */}
      <View
        style={{
          paddingHorizontal: 18,
          paddingVertical: 16,
          borderTopWidth: 1,
          borderTopColor: c.border,
        }}
      >
        <T step="12" tone="text3">
          {t("board.autoplayHow", {
            defaultValue:
              "Teros wakes each runner when one of its tasks is in To Do and its dependencies are Done, honouring slots and priority. Agents move to Review; you move to Done. Limit of 5 auto-wakes per agent.",
          })}
        </T>
      </View>

      {/* Add-runner dropdown — a Modal so it floats above everything */}
      <Modal
        visible={showAdd}
        transparent
        animationType="none"
        onRequestClose={() => setShowAdd(false)}
      >
        <Pressable style={{ flex: 1 }} onPress={() => setShowAdd(false)}>
          <View
            style={[
              {
                position: "absolute",
                top: anchor ? anchor.y + anchor.h + 6 : 100,
                left: anchor ? anchor.x : 100,
                backgroundColor: c.bgStep,
                borderRadius: 12,
                padding: 6,
                minWidth: 220,
              },
              Platform.OS === "web" ? ({ boxShadow: c.elevRaised } as any) : { elevation: 20 },
            ]}
          >
            {candidates.length === 0 ? (
              <T step="12" tone="text3" style={{ paddingHorizontal: 10, paddingVertical: 8 }}>
                {t("board.noAgentsAvailable")}
              </T>
            ) : (
              candidates.map((agent) => (
                <Pressable
                  key={agent.agentId}
                  onPress={() => {
                    onAddRunner(agent.agentId)
                    setShowAdd(false)
                  }}
                  style={({ pressed }) => [
                    {
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 10,
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      borderRadius: 8,
                      backgroundColor: pressed ? c.wash2 : "transparent",
                    },
                    Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
                  ]}
                >
                  <Avatar name={agent.name} imageUrl={agent.avatarUrl} size={22} isAgent />
                  <T step="sm">{agent.name}</T>
                </Pressable>
              ))
            )}
          </View>
        </Pressable>
      </Modal>
    </View>
  )
}
