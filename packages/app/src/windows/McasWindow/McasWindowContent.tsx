/**
 * MCAs Window Content — the admin "Controls" view of the MCA catalog, in the
 * OS prototype's language: Stats · filter chips · per-availability `LGroup`
 * lists of expandable rows (Tile · name · badges · meta · Edit) · an edit
 * Sheet built from Switch rows and pill buttons.
 *
 * - List all MCAs with their configurations
 * - View availability settings (enabled, system, hidden, role, multi)
 * - View tools, secrets, and auth configuration
 */

import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Sheet } from "tamagui"
import { getTerosClient } from "../../services/terosClientSingleton"
import { FullscreenLoader } from "../../components/ui"
import { useColors } from "../../components/mca/primitives/useColors"
import { McaIcon } from "../../components/mca/McaIcon"
import {
  Badge,
  type BadgeTone,
  Btn,
  ChipBtn,
  EmptyState,
  IconBtn,
  LGroup,
  LRow,
  Page,
  Ph,
  SectionLabel,
  Stat,
  Stats,
  Switch,
  T,
  Tile,
} from "../../components/ui/ds"

interface Mca {
  mcaId: string
  name: string
  description: string
  icon?: string
  color?: string
  category: string
  tools: string[]
  status: string
  availability: {
    enabled: boolean
    multi: boolean
    system: boolean
    hidden: boolean
    role: "user" | "admin" | "super"
  }
  systemSecrets: string[]
  userSecrets: string[]
  auth?: {
    type: string
    provider?: string
  }
}

const ROLE_TONE: Record<string, BadgeTone> = {
  user: "g",
  admin: "a",
  super: "r",
}

interface McaCardProps {
  mca: Mca
  expanded: boolean
  onToggle: () => void
  onEdit: () => void
}

/** A mono-pill list (tools, secrets). */
function PillList({ items }: { items: string[] }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
      {items.map((item, i) => (
        <Badge key={`${item}-${i}`} mono sm>
          {item}
        </Badge>
      ))}
    </View>
  )
}

function McaCard({ mca, expanded, onToggle, onEdit }: McaCardProps) {
  const c = useColors()
  const roleTone = ROLE_TONE[mca.availability.role] || ROLE_TONE["user"]
  const isDisabled = !mca.availability.enabled

  const meta = [
    mca.category,
    mca.availability.role,
    `${mca.tools.length} tools`,
    mca.availability.multi ? "multi" : null,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <View style={{ opacity: isDisabled ? 0.7 : 1 }}>
      {/* Header */}
      <LRow hov gap={12} onPress={onToggle}>
        <Tile sm tone={isDisabled ? "muted" : "accent"}>
          <McaIcon
            icon={mca.icon}
            mcaId={mca.mcaId}
            size={20}
            color={c.accent}
            backgroundColor="transparent"
            borderRadius={0}
          />
        </Tile>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <T step="sm" numberOfLines={1} style={{ flexShrink: 1 }}>
              {mca.name}
            </T>
            {isDisabled ? (
              <Badge tone="r" sm pill icon="lock">
                disabled
              </Badge>
            ) : null}
            {mca.availability.system ? (
              <Badge tone="i" sm pill icon="shield-check">
                system
              </Badge>
            ) : null}
            {mca.availability.hidden ? (
              <Badge tone="muted" sm pill icon="eye-slash">
                hidden
              </Badge>
            ) : null}
          </View>
          <T step="codenote" tone="text3" numberOfLines={1} style={{ textTransform: "none" }}>
            {meta}
          </T>
        </View>
        <Badge tone={roleTone} sm pill dot>
          {mca.availability.role}
        </Badge>
        <Ph name={expanded ? "caret-up" : "caret-down"} size={14} color={c.text3} />
      </LRow>

      {/* Expanded Content */}
      {expanded ? (
        <View
          style={{
            padding: 16,
            paddingLeft: 64,
            gap: 16,
            backgroundColor: c.wash,
            borderTopWidth: 1,
            borderTopColor: c.border,
          }}
        >
          {/* Description */}
          <T step="sm" tone="text2">
            {mca.description}
          </T>

          {/* Availability Settings (Read-only with Edit button) */}
          <View style={{ gap: 8 }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <T step="xs" tone="text3">
                Availability
              </T>
              <Btn variant="sec" size="sm" icon="pencil-simple" onPress={onEdit}>
                Edit
              </Btn>
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              <Badge
                tone={mca.availability.enabled ? "g" : "r"}
                sm
                pill
                icon={mca.availability.enabled ? "lock-open" : "lock"}
              >
                {mca.availability.enabled ? "Enabled" : "Disabled"}
              </Badge>
              <Badge tone={roleTone} sm pill icon="users-three">
                {mca.availability.role}
              </Badge>
              {mca.availability.system ? (
                <Badge tone="i" sm pill icon="shield-check">
                  System
                </Badge>
              ) : null}
              {mca.availability.hidden ? (
                <Badge tone="muted" sm pill icon="eye-slash">
                  Hidden
                </Badge>
              ) : null}
              {mca.availability.multi ? (
                <Badge tone="m" sm pill icon="stack">
                  Multi
                </Badge>
              ) : null}
            </View>
          </View>

          {/* Tools */}
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Ph name="wrench" size={12} color={c.text3} />
              <T step="xs" tone="text3">
                Tools ({mca.tools.length})
              </T>
            </View>
            <PillList items={mca.tools} />
          </View>

          {/* Secrets */}
          {(mca.systemSecrets.length > 0 || mca.userSecrets.length > 0) && (
            <View style={{ gap: 8 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Ph name="key" size={12} color={c.text3} />
                <T step="xs" tone="text3">
                  Secrets
                </T>
              </View>
              {mca.systemSecrets.length > 0 && (
                <View style={{ gap: 4 }}>
                  <T step="12" tone="text3">
                    System secrets:
                  </T>
                  <PillList items={mca.systemSecrets} />
                </View>
              )}
              {mca.userSecrets.length > 0 && (
                <View style={{ gap: 4 }}>
                  <T step="12" tone="text3">
                    User secrets:
                  </T>
                  <PillList items={mca.userSecrets} />
                </View>
              )}
            </View>
          )}

          {/* Auth */}
          {mca.auth && (
            <View style={{ gap: 8 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Ph name="shield-check" size={12} color={c.text3} />
                <T step="xs" tone="text3">
                  Authentication
                </T>
              </View>
              <T step="sm" tone="text2">
                type: {mca.auth.type}
                {mca.auth.provider && ` • provider: ${mca.auth.provider}`}
              </T>
            </View>
          )}

          {/* MCP ID */}
          <T step="code" tone="text3">
            {mca.mcaId}
          </T>
        </View>
      ) : null}
    </View>
  )
}

/** One switch row of the edit Sheet. */
function SwitchRow({
  icon,
  iconColor,
  title,
  sub,
  on,
  onToggle,
}: {
  icon: string
  iconColor: string
  title: string
  sub: string
  on: boolean
  onToggle: () => void
}) {
  return (
    <LRow>
      <Ph name={icon} size={16} color={iconColor} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T step="sm">{title}</T>
        <T step="12" tone="text3">
          {sub}
        </T>
      </View>
      <Switch on={on} onToggle={onToggle} />
    </LRow>
  )
}

export interface McasWindowContentProps {
  windowId: string
}

export function McasWindowContent({ windowId }: McasWindowContentProps) {
  const { t } = useTranslation()
  const c = useColors()
  const client = getTerosClient()
  const insets = useSafeAreaInsets()

  const [mcas, setMcas] = useState<Mca[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedMcas, setExpandedMcas] = useState<Set<string>>(new Set())
  const [filterCategory, setFilterCategory] = useState<string | null>(null)
  const [showDisabled, setShowDisabled] = useState(true)
  const [showSystem, setShowSystem] = useState(true)
  const [showHidden, setShowHidden] = useState(true)
  const [editingMca, setEditingMca] = useState<Mca | null>(null)
  const [editForm, setEditForm] = useState({
    enabled: true,
    system: false,
    hidden: false,
    role: "user" as "user" | "admin" | "super",
  })
  const [saving, setSaving] = useState(false)

  const toggleMca = (mcaId: string) => {
    setExpandedMcas((prev) => {
      const next = new Set(prev)
      if (next.has(mcaId)) {
        next.delete(mcaId)
      } else {
        next.add(mcaId)
      }
      return next
    })
  }

  const loadMcas = async () => {
    setLoading(true)
    try {
      const mcasList = (await client.app.listAllMcas()).mcas as Mca[]
      setMcas(mcasList as Mca[])
    } catch (err) {
      console.error("Failed to load MCAs:", err)
      setError(err instanceof Error ? err.message : t("errors.mcas.loadFailed"))
    } finally {
      setLoading(false)
    }
  }

  const openEditSheet = (mca: Mca) => {
    setEditForm({
      enabled: mca.availability.enabled,
      system: mca.availability.system,
      hidden: mca.availability.hidden,
      role: mca.availability.role,
    })
    setEditingMca(mca)
  }

  const closeEditSheet = () => {
    setEditingMca(null)
  }

  const saveAvailability = async () => {
    if (!editingMca) return

    console.log("💾 Saving MCA availability:", editingMca.mcaId, editForm)
    setSaving(true)
    try {
      const updatedMca = (await client.app.updateMca(editingMca.mcaId, editForm)).mca as Mca
      console.log("✅ MCA updated successfully:", updatedMca)
      // Update local state with the updated MCA
      setMcas((prev) =>
        prev.map((mca) => (mca.mcaId === editingMca.mcaId ? { ...mca, ...updatedMca } : mca)),
      )
      setEditingMca(null)
    } catch (err) {
      console.error("❌ Failed to update MCA:", err)
      alert(
        t("errors.mcas.updateFailed", {
          error: err instanceof Error ? err.message : t("errors.unknownError"),
        }),
      )
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    if (client.isConnected()) {
      loadMcas()
    } else {
      const onConnected = () => {
        loadMcas()
        client.off("connected", onConnected)
      }
      client.on("connected", onConnected)

      return () => {
        client.off("connected", onConnected)
      }
    }
  }, [client])

  if (loading) {
    return <FullscreenLoader variant="default" label={t("common.loading")} />
  }

  if (error) {
    return (
      <Page padTop={0}>
        <EmptyState icon="warning" title={error} />
      </Page>
    )
  }

  // Get categories
  const categories = [...new Set(mcas.map((m) => m.category))].sort()

  // Filter MCAs
  let filteredMcas = mcas
  if (filterCategory) {
    filteredMcas = filteredMcas.filter((m) => m.category === filterCategory)
  }
  if (!showDisabled) {
    filteredMcas = filteredMcas.filter((m) => m.availability.enabled)
  }
  if (!showSystem) {
    filteredMcas = filteredMcas.filter((m) => !m.availability.system)
  }
  if (!showHidden) {
    filteredMcas = filteredMcas.filter((m) => !m.availability.hidden)
  }

  // Sort MCAs by name
  const sortedMcas = [...filteredMcas].sort((a, b) => a.name.localeCompare(b.name))

  // Stats
  const enabledCount = mcas.filter((m) => m.availability.enabled).length
  const systemCount = mcas.filter((m) => m.availability.system).length
  const hiddenCount = mcas.filter((m) => m.availability.hidden).length
  const disabledCount = mcas.filter((m) => !m.availability.enabled).length
  const totalTools = mcas.reduce((acc, m) => acc + m.tools.length, 0)

  // Group MCAs by availability type
  const groups = {
    system: sortedMcas.filter(
      (m) => m.availability.system && m.availability.enabled && !m.availability.hidden,
    ),
    admin: sortedMcas.filter(
      (m) =>
        !m.availability.system &&
        m.availability.enabled &&
        !m.availability.hidden &&
        (m.availability.role === "admin" || m.availability.role === "super"),
    ),
    user: sortedMcas.filter(
      (m) =>
        !m.availability.system &&
        m.availability.enabled &&
        !m.availability.hidden &&
        m.availability.role === "user",
    ),
    hidden: sortedMcas.filter((m) => m.availability.enabled && m.availability.hidden),
    disabled: sortedMcas.filter((m) => !m.availability.enabled),
  }

  const groupConfig = [
    { key: "system", label: "System", mcas: groups.system },
    { key: "admin", label: "Admin Only", mcas: groups.admin },
    { key: "user", label: "User", mcas: groups.user },
    { key: "hidden", label: "Hidden", mcas: groups.hidden },
    { key: "disabled", label: "Disabled", mcas: groups.disabled },
  ]

  const nonEmptyGroups = groupConfig.filter((g) => g.mcas.length > 0)

  return (
    <View style={{ flex: 1 }}>
      <Page padTop={0}>
        <View style={{ gap: 20 }}>
          {/* Summary */}
          <View
            style={{ flexDirection: "row", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}
          >
            <View style={{ flex: 1, minWidth: 320 }}>
              <Stats cols={4}>
                <Stat v={mcas.length} label="Total" />
                <Stat v={enabledCount} label="Enabled" accent />
                <Stat v={systemCount} label="System" />
                <Stat v={totalTools} label="Tools" />
              </Stats>
            </View>
            <Btn variant="sec" icon="arrows-clockwise" onPress={loadMcas} style={{ marginTop: 5 }}>
              Refresh
            </Btn>
          </View>

          {/* Filters */}
          <View style={{ gap: 8 }}>
            {/* Category Filter */}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              <ChipBtn
                on={filterCategory === null}
                count={mcas.length}
                onPress={() => setFilterCategory(null)}
              >
                All
              </ChipBtn>
              {categories.map((category) => {
                const count = mcas.filter((m) => m.category === category).length
                return (
                  <ChipBtn
                    key={category}
                    on={filterCategory === category}
                    count={count}
                    onPress={() => setFilterCategory(category)}
                  >
                    {category}
                  </ChipBtn>
                )
              })}
            </View>

            {/* Toggle Filters */}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              <ChipBtn
                icon={showDisabled ? "eye" : "eye-slash"}
                on={showDisabled}
                count={disabledCount}
                onPress={() => setShowDisabled(!showDisabled)}
              >
                Disabled
              </ChipBtn>
              <ChipBtn
                icon="shield-check"
                on={showSystem}
                count={systemCount}
                onPress={() => setShowSystem(!showSystem)}
              >
                System
              </ChipBtn>
              <ChipBtn
                icon="eye-slash"
                on={showHidden}
                count={hiddenCount}
                onPress={() => setShowHidden(!showHidden)}
              >
                Hidden
              </ChipBtn>
            </View>
          </View>

          {/* MCAs List - Grouped by availability */}
          {nonEmptyGroups.length === 0 ? (
            <EmptyState icon="package" title="No MCAs match the current filters" />
          ) : (
            <View style={{ gap: 8 }}>
              {nonEmptyGroups.map((group) => (
                <View key={group.key}>
                  <SectionLabel label={group.label} count={group.mcas.length} />
                  <LGroup style={{ marginBottom: 12 }}>
                    {group.mcas.map((mca) => (
                      <McaCard
                        key={mca.mcaId}
                        mca={mca}
                        expanded={expandedMcas.has(mca.mcaId)}
                        onToggle={() => toggleMca(mca.mcaId)}
                        onEdit={() => openEditSheet(mca)}
                      />
                    ))}
                  </LGroup>
                </View>
              ))}
            </View>
          )}
        </View>
      </Page>

      {/* Edit Availability Sheet */}
      <Sheet
        modal
        open={!!editingMca}
        onOpenChange={(open: boolean) => !open && closeEditSheet()}
        snapPoints={[70]}
        dismissOnSnapToBottom
        zIndex={100000}
      >
        <Sheet.Overlay
          animation={"lazy" as any}
          enterStyle={{ opacity: 0 }}
          exitStyle={{ opacity: 0 }}
          backgroundColor="rgba(23, 20, 31, 0.55)"
        />
        <Sheet.Frame
          backgroundColor={c.bgSheet}
          borderTopLeftRadius={24}
          borderTopRightRadius={24}
          padding={24}
          paddingBottom={Math.max(insets.bottom, 40)}
          gap={16}
        >
          <Sheet.Handle backgroundColor={c.borderStrong} />

          {editingMca && (
            <View style={{ gap: 20, width: "100%", maxWidth: 760, alignSelf: "center" }}>
              {/* Header */}
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T step="xl">Edit Availability</T>
                  <T step="sm" tone="text2" ellipsis>
                    {editingMca.name}
                  </T>
                </View>
                <IconBtn icon="x" plain onPress={closeEditSheet} />
              </View>

              {/* Toggle Controls */}
              <LGroup>
                <SwitchRow
                  icon={editForm.enabled ? "lock-open" : "lock"}
                  iconColor={editForm.enabled ? c.tint.g.tx : c.tint.r.tx}
                  title="Enabled"
                  sub="Allow this MCA to be installed"
                  on={editForm.enabled}
                  onToggle={() => setEditForm((prev) => ({ ...prev, enabled: !prev.enabled }))}
                />
                <SwitchRow
                  icon="shield-check"
                  iconColor={editForm.system ? c.accent : c.text3}
                  title="System MCA"
                  sub="Auto-install for all agents"
                  on={editForm.system}
                  onToggle={() => setEditForm((prev) => ({ ...prev, system: !prev.system }))}
                />
                <SwitchRow
                  icon={editForm.hidden ? "eye-slash" : "eye"}
                  iconColor={editForm.hidden ? c.text3 : c.tint.g.tx}
                  title="Hidden"
                  sub="Hide from catalog listing"
                  on={editForm.hidden}
                  onToggle={() => setEditForm((prev) => ({ ...prev, hidden: !prev.hidden }))}
                />
                {/* Role Selector */}
                <LRow style={{ alignItems: "flex-start" }}>
                  <Ph
                    name="users-three"
                    size={16}
                    color={c.tint[ROLE_TONE[editForm.role] as "g" | "a" | "r"].tx}
                  />
                  <View style={{ flex: 1, minWidth: 0, gap: 10 }}>
                    <View>
                      <T step="sm">Required Role</T>
                      <T step="12" tone="text3">
                        Minimum role to install this MCA
                      </T>
                    </View>
                    <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
                      {(["user", "admin", "super"] as const).map((role) => (
                        <ChipBtn
                          key={role}
                          mono
                          on={editForm.role === role}
                          onPress={() => setEditForm((prev) => ({ ...prev, role }))}
                        >
                          {role}
                        </ChipBtn>
                      ))}
                    </View>
                  </View>
                </LRow>
              </LGroup>

              {/* Action Buttons */}
              <View style={{ flexDirection: "row", gap: 10 }}>
                <Btn
                  variant="sec"
                  full
                  style={{ flex: 1 }}
                  onPress={closeEditSheet}
                  disabled={saving}
                >
                  Cancel
                </Btn>
                <Btn
                  variant="primary"
                  icon="check"
                  full
                  style={{ flex: 1 }}
                  onPress={saveAvailability}
                  loading={saving}
                >
                  {saving ? "Saving..." : "Save"}
                </Btn>
              </View>
            </View>
          )}
        </Sheet.Frame>
      </Sheet>
    </View>
  )
}
