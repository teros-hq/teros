/**
 * PermissionsPanel Component
 *
 * Collapsible panel for tool permissions configuration, in the OS prototype's
 * language: a lifted Card whose rows show the tool name as a mono pill, the
 * "solo lectura" badge when the read-only policy auto-allows, and a three-way
 * segmented toggle (allow / ask / forbid). Shows all tools without internal
 * scroll — it scrolls with the page.
 */

import type React from "react"
import { useState } from "react"
import { Platform, Pressable, View } from "react-native"
import { AppSpinner } from "../../components/ui"
import { colors as semantic } from "../../components/mca/primitives/colors"
import { useColors } from "../../components/mca/primitives/useColors"
import { Badge, Card, IconBtn, Ph, T } from "../ui/ds"

// ============================================================================
// Types
// ============================================================================

export type ToolPermission = "allow" | "ask" | "forbid"

export interface ToolWithPermission {
  name: string
  description?: string
  permission: ToolPermission
  /**
   * The tool runs WITHOUT asking purely because of the read-only auto-allow
   * policy (it's read-only and its `ask` is inherited from the default, not
   * pinned). Drives the "solo lectura" badge. The backend sets this to `false`
   * the moment the tool is pinned explicitly, so the badge never lies.
   */
  autoAllowed?: boolean
}

export interface PermissionsPanelProps {
  /** List of tools with their permissions */
  tools: ToolWithPermission[]
  /** Summary counts */
  summary?: {
    allow: number
    ask: number
    forbid: number
  }
  /** Loading state */
  loading?: boolean
  /** Saving state */
  saving?: boolean
  /** Callback when a tool's permission changes */
  onToolPermissionChange?: (toolName: string, permission: ToolPermission) => void
  /** Callback to set all tools to a permission */
  onSetAllPermissions?: (permission: ToolPermission) => void
  /** Initial expanded state */
  defaultExpanded?: boolean
}

// ============================================================================
// Permission signal palette — allow/ask/forbid → g/a/r tints (theme-adaptive)
// ============================================================================

const PERM_ICON: Record<ToolPermission, string> = { allow: "check", ask: "user", forbid: "x" }

function usePermTints() {
  const c = useColors()
  return {
    allow: c.tint.g,
    ask: c.tint.a,
    forbid: c.tint.r,
  } as const
}

// ============================================================================
// Triple Toggle Component (`.ap-seg`)
// ============================================================================

interface TripleToggleProps {
  value: ToolPermission
  onChange: (value: ToolPermission) => void
  disabled?: boolean
}

function TripleToggle({ value, onChange, disabled }: TripleToggleProps) {
  const c = useColors()
  const tints = usePermTints()
  const keys: ToolPermission[] = ["allow", "ask", "forbid"]
  return (
    <View
      style={{
        flexDirection: "row",
        gap: 2,
        padding: 3,
        borderRadius: 100,
        backgroundColor: c.wash,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {keys.map((key) => {
        const on = value === key
        return (
          <Pressable
            key={key}
            accessibilityRole="radio"
            accessibilityState={{ checked: on, disabled }}
            disabled={disabled}
            onPress={() => !disabled && onChange(key)}
            style={[
              {
                width: 32,
                height: 24,
                borderRadius: 100,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: on ? tints[key].bg : "transparent",
              },
              Platform.OS === "web"
                ? ({
                    cursor: disabled ? "default" : "pointer",
                    transition: "background 0.2s",
                  } as any)
                : null,
            ]}
          >
            <Ph
              name={PERM_ICON[key]}
              size={12}
              color={on ? tints[key].tx : c.text3}
              weight={on ? "bold" : "regular"}
            />
          </Pressable>
        )
      })}
    </View>
  )
}

// ============================================================================
// Bulk Actions Component
// ============================================================================

interface BulkActionsProps {
  onSetAll: (permission: ToolPermission) => void
  disabled?: boolean
}

function BulkActions({ onSetAll, disabled }: BulkActionsProps) {
  const keys: ToolPermission[] = ["allow", "ask", "forbid"]
  return (
    <View style={{ flexDirection: "row", gap: 2 }}>
      {keys.map((key) => (
        <IconBtn
          key={key}
          icon={PERM_ICON[key]}
          sm
          disabled={disabled}
          onPress={() => !disabled && onSetAll(key)}
        />
      ))}
    </View>
  )
}

// ============================================================================
// Summary Bar Component
// ============================================================================

interface SummaryBarProps {
  summary: { allow: number; ask: number; forbid: number }
  onSetAll?: (permission: ToolPermission) => void
  disabled?: boolean
}

function SummaryBar({ summary, onSetAll, disabled }: SummaryBarProps) {
  const c = useColors()
  const tints = usePermTints()
  const keys: ToolPermission[] = ["allow", "ask", "forbid"]
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        paddingVertical: 10,
        paddingHorizontal: 16,
        backgroundColor: c.wash,
        borderTopWidth: 1,
        borderTopColor: c.border,
      }}
    >
      {/* Counts */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
        {keys.map((key) => (
          <View key={key} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <Ph name={PERM_ICON[key]} size={12} color={tints[key].tx} />
            <T step="code" color={tints[key].tx}>
              {String(summary[key])}
            </T>
          </View>
        ))}
      </View>

      {/* Bulk actions */}
      {onSetAll ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <T step="codenote" tone="text3">
            todos
          </T>
          <BulkActions onSetAll={onSetAll} disabled={disabled} />
        </View>
      ) : null}
    </View>
  )
}

// ============================================================================
// Tool Row Component
// ============================================================================

interface ToolRowProps {
  tool: ToolWithPermission
  onPermissionChange: (permission: ToolPermission) => void
  disabled?: boolean
  isLast?: boolean
}

/** "solo lectura · no pregunta" — shown when the read-only policy auto-allows. */
function ReadOnlyBadge() {
  return (
    <Badge tone="i" sm pill icon="eye">
      solo lectura · no pregunta
    </Badge>
  )
}

function ToolRow({ tool, onPermissionChange, disabled, isLast }: ToolRowProps) {
  const c = useColors()
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        paddingVertical: 10,
        paddingHorizontal: 16,
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: c.border,
      }}
    >
      <View
        style={{
          flex: 1,
          minWidth: 0,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <Badge mono>{tool.name}</Badge>
        {tool.autoAllowed ? <ReadOnlyBadge /> : null}
      </View>
      <TripleToggle value={tool.permission} onChange={onPermissionChange} disabled={disabled} />
    </View>
  )
}

// ============================================================================
// Legend Component
// ============================================================================

function Legend() {
  const c = useColors()
  const items: Array<{ key: ToolPermission; label: string }> = [
    { key: "allow", label: "Auto" },
    { key: "ask", label: "Confirmar" },
    { key: "forbid", label: "Bloquear" },
  ]
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 16,
        paddingVertical: 10,
        paddingHorizontal: 16,
        borderTopWidth: 1,
        borderTopColor: c.border,
      }}
    >
      {items.map((it) => (
        <View key={it.key} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <Ph name={PERM_ICON[it.key]} size={10} color={c.text3} />
          <T step="12" tone="text3">
            {it.label}
          </T>
        </View>
      ))}
    </View>
  )
}

// ============================================================================
// Main PermissionsPanel Component
// ============================================================================

export function PermissionsPanel({
  tools,
  summary: propSummary,
  loading = false,
  saving = false,
  onToolPermissionChange,
  onSetAllPermissions,
  defaultExpanded = true,
}: PermissionsPanelProps) {
  const c = useColors()
  const [expanded, setExpanded] = useState(defaultExpanded)

  // Calculate summary if not provided. Counts the EFFECTIVE permission
  // (effective = autoAllowed ? 'allow' : permission) to match the backend
  // summary and the per-row badges.
  const summary =
    propSummary ||
    tools.reduce(
      (acc, tool) => {
        acc[tool.autoAllowed ? "allow" : tool.permission]++
        return acc
      },
      { allow: 0, ask: 0, forbid: 0 },
    )

  const totalTools = tools.length

  return (
    <Card>
      {/* Header */}
      <Pressable
        accessibilityRole="button"
        onPress={() => setExpanded(!expanded)}
        style={[
          {
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            paddingVertical: 14,
            paddingHorizontal: 16,
          },
          Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
        ]}
      >
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: semantic.green,
            flexShrink: 0,
          }}
        />
        <Ph name="shield-check" size={16} color={c.accent} />
        <T step="sm" style={{ flex: 1 }}>
          Permisos
        </T>
        {loading ? (
          <AppSpinner size="sm" variant="muted" />
        ) : (
          <Badge mono sm>{`${totalTools} tools`}</Badge>
        )}
        {saving ? <AppSpinner size="sm" variant="muted" /> : null}
        <Ph name={expanded ? "caret-up" : "caret-down"} size={14} color={c.text3} />
      </Pressable>

      {/* Content - NO SCROLL, all tools visible */}
      {expanded ? (
        <View>
          {/* Summary bar with bulk actions */}
          <SummaryBar
            summary={summary}
            onSetAll={onSetAllPermissions}
            disabled={saving || !onSetAllPermissions}
          />

          {/* Tools list - renders all tools, no ScrollView */}
          <View>
            {tools.map((tool, index) => (
              <ToolRow
                key={tool.name}
                tool={tool}
                onPermissionChange={(perm) => onToolPermissionChange?.(tool.name, perm)}
                disabled={saving || !onToolPermissionChange}
                isLast={index === tools.length - 1}
              />
            ))}
          </View>

          {/* Legend */}
          <Legend />
        </View>
      ) : null}
    </Card>
  )
}

export default PermissionsPanel
