/**
 * GateEditor — Editor for a single gate (input or output port)
 *
 * In the Flowing model, gates reference Artifacts via schemaId.
 * This editor allows:
 * - Gate label
 * - Artifact selector (schemaId) — dropdown of available artifacts, or signal-only
 * - Allow modifying toggle (for input gates)
 *
 * Theme-adaptive via useFlowEditorTheme()
 */

import { useState, useEffect, useRef } from "react"
import type { Gate, Artifact } from "@teros/workflows"
import { IconBtn, Ph } from "../../components/ui/ds"
import { useFlowEditorTheme, useFlowEditorStyles } from "./useFlowEditorTheme"

interface GateEditorProps {
  gate: Gate
  direction: "input" | "output"
  index: number
  onChange: (gate: Gate) => void
  onRemove: () => void
  canRemove: boolean
  /** Available artifacts for the schemaId selector */
  artifacts?: Artifact[]
  /** Whether artifacts are currently loading */
  artifactsLoading?: boolean
  /** Called when user clicks "Edit Schema" on a selected artifact */
  onEditArtifact?: (artifact: Artifact) => void
  /** Called when user clicks "Create New Artifact" */
  onCreateArtifact?: () => void
}

export function GateEditor({
  gate,
  direction,
  onChange,
  onRemove,
  canRemove,
  artifacts = [],
  artifactsLoading = false,
  onEditArtifact,
  onCreateArtifact,
}: GateEditorProps) {
  const t = useFlowEditorTheme()
  const ds = useFlowEditorStyles()
  const [artifactSearch, setArtifactSearch] = useState("")
  const [showArtifactDropdown, setShowArtifactDropdown] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowArtifactDropdown(false)
      }
    }
    if (showArtifactDropdown) {
      document.addEventListener("mousedown", handleClickOutside)
      return () => document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [showArtifactDropdown])

  // Find the currently selected artifact
  const selectedArtifact = gate.schemaId
    ? artifacts.find((a) => a.artifactId === gate.schemaId)
    : null

  // Filter artifacts by search
  const filteredArtifacts = artifactSearch
    ? artifacts.filter(
        (a) =>
          a.name.toLowerCase().includes(artifactSearch.toLowerCase()) ||
          a.title.toLowerCase().includes(artifactSearch.toLowerCase()),
      )
    : artifacts

  const handleSelectArtifact = (artifact: Artifact | null) => {
    onChange({
      ...gate,
      schemaId: artifact ? artifact.artifactId : null,
    })
    setShowArtifactDropdown(false)
    setArtifactSearch("")
  }

  const labelStyle = ds.label
  const inputStyle = ds.input

  const dirColor = direction === "input" ? t.tint.a.tx : t.tint.g.tx
  const dirIcon = direction === "input" ? t.warning : t.success

  return (
    <div style={ds.nestCard}>
      {/* Header row: direction badge + remove button */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            fontFamily: t.fontMono,
            fontSize: 10,
            lineHeight: "12px",
            color: dirColor,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            display: "flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          {direction === "input" ? (
            <>
              <Ph name="arrow-left" size={11} color={dirIcon} /> Input
            </>
          ) : (
            <>
              Output <Ph name="arrow-right" size={11} color={dirIcon} />
            </>
          )}
        </span>
        <div style={{ flex: 1 }} />
        {canRemove && <IconBtn icon="x" plain sm danger onPress={onRemove} title="Remove gate" />}
      </div>

      {/* Label */}
      <div>
        <label style={labelStyle}>Label</label>
        <input
          type="text"
          value={gate.label || ""}
          onChange={(e) => onChange({ ...gate, label: e.target.value })}
          style={inputStyle}
          placeholder="Gate label"
        />
      </div>

      {/* Artifact selector (schemaId) */}
      <div ref={dropdownRef} style={{ position: "relative" }}>
        <label style={labelStyle}>Artifact (Schema)</label>
        {selectedArtifact ? (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <div
              style={{
                ...inputStyle,
                display: "flex",
                alignItems: "center",
                gap: 6,
                cursor: "pointer",
              }}
              onClick={() => setShowArtifactDropdown(true)}
            >
              <Ph name="package" size={14} color={t.text3} />
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {selectedArtifact.name}
              </span>
              <span
                style={{
                  fontFamily: t.fontMono,
                  fontSize: 9,
                  letterSpacing: 0.5,
                  color: selectedArtifact.color || t.text3,
                  textTransform: "uppercase",
                }}
              >
                {selectedArtifact.source}
              </span>
              <Ph name="caret-down" size={12} color={t.text3} />
            </div>
            <button
              onClick={() => handleSelectArtifact(null)}
              style={ds.btnSm}
              title="Set to signal-only (no data)"
            >
              Clear
            </button>
            {onEditArtifact && selectedArtifact && (
              <button
                onClick={() => onEditArtifact(selectedArtifact)}
                style={{ ...ds.btnSm, background: t.navActive, color: t.accent }}
                title="Edit artifact schema"
              >
                <Ph name="pencil-simple" size={11} color={t.accent} />
                Edit
              </button>
            )}
          </div>
        ) : (
          <button
            onClick={() => setShowArtifactDropdown(true)}
            style={{
              ...inputStyle,
              cursor: "pointer",
              textAlign: "left",
              color: t.text3,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Ph name="lightning" size={13} color={t.text3} />
            <span
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {artifactsLoading
                ? "Loading artifacts…"
                : "Signal-only — click to select an artifact"}
            </span>
            <Ph name="caret-down" size={12} color={t.text3} />
          </button>
        )}

        {/* Artifact dropdown */}
        {showArtifactDropdown && (
          <div
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              right: 0,
              marginTop: 4,
              background: t.cardBg,
              borderRadius: 12,
              boxShadow: t.elevRaised,
              zIndex: 100,
              maxHeight: 240,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {/* Search input */}
            <input
              type="text"
              value={artifactSearch}
              onChange={(e) => setArtifactSearch(e.target.value)}
              style={{
                background: "transparent",
                border: "none",
                borderBottom: `1px solid ${t.sidebarBorder}`,
                padding: "10px 12px",
                color: t.inputText,
                fontFamily: t.fontSans,
                fontSize: 13,
                outline: "none",
              }}
              placeholder="Search artifacts…"
              autoFocus
            />

            {/* Create new artifact option */}
            {onCreateArtifact && (
              <div
                onClick={() => {
                  setShowArtifactDropdown(false)
                  onCreateArtifact()
                }}
                style={{
                  padding: "8px 10px",
                  cursor: "pointer",
                  fontSize: 13,
                  color: t.accent,
                  borderBottom: `1px solid ${t.sidebarBorder}`,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = t.nestHoverBg
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent"
                }}
              >
                <Ph name="plus" size={12} color={t.accent} /> Create new artifact…
              </div>
            )}

            {/* Signal-only option */}
            <div
              onClick={() => handleSelectArtifact(null)}
              style={{
                padding: "8px 10px",
                cursor: "pointer",
                fontSize: 13,
                color: t.text3,
                borderBottom: `1px solid ${t.sidebarBorder}`,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = t.nestHoverBg
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent"
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Ph name="lightning" size={12} color={t.text3} /> Signal-only (no data)
              </span>
            </div>

            {/* Artifact list */}
            <div style={{ overflowY: "auto", flex: 1 }}>
              {filteredArtifacts.length === 0 && !artifactsLoading && (
                <div
                  style={{
                    padding: "12px 10px",
                    fontSize: 12,
                    color: t.text3,
                    textAlign: "center",
                  }}
                >
                  No artifacts found
                </div>
              )}
              {artifactsLoading && (
                <div
                  style={{
                    padding: "12px 10px",
                    fontSize: 12,
                    color: t.text3,
                    textAlign: "center",
                  }}
                >
                  Loading…
                </div>
              )}
              {filteredArtifacts.map((artifact) => (
                <div
                  key={artifact.artifactId}
                  onClick={() => handleSelectArtifact(artifact)}
                  style={{
                    padding: "8px 10px",
                    cursor: "pointer",
                    fontSize: 13,
                    color: t.text,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    borderBottom: `1px solid ${t.sidebarBorder}`,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = t.nestHoverBg
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent"
                  }}
                >
                  <Ph name="package" size={14} color={t.text3} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {artifact.name}
                    </div>
                    {artifact.description && (
                      <div
                        style={{
                          fontSize: 11,
                          color: t.text3,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {artifact.description}
                      </div>
                    )}
                  </div>
                  <span
                    style={{
                      fontFamily: t.fontMono,
                      fontSize: 9,
                      letterSpacing: 0.5,
                      color: artifact.color || t.text3,
                      textTransform: "uppercase",
                      flexShrink: 0,
                    }}
                  >
                    {artifact.source}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Allow modifying toggle (only for input gates with artifact) */}
      {direction === "input" && gate.schemaId && (
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            cursor: "pointer",
            fontSize: 13,
            color: t.text2,
          }}
        >
          <input
            type="checkbox"
            checked={gate.allowModifying ?? false}
            onChange={(e) => onChange({ ...gate, allowModifying: e.target.checked })}
            style={{ cursor: "pointer" }}
          />
          Allow modifying input
        </label>
      )}

      {/* Signal-only indicator */}
      {!gate.schemaId && (
        <div
          style={{
            fontSize: 12,
            color: t.text3,
            padding: "2px 0",
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <Ph name="lightning" size={11} color={t.text3} /> Signal-only gate — carries control
            flow, no data
          </span>
        </div>
      )}
    </div>
  )
}
