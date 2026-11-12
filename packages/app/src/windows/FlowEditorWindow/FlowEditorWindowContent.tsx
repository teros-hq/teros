/**
 * FlowEditorWindowContent — Main component for the visual flow editor
 *
 * Layout (responsive):
 * - Desktop (≥768px): [NodePalette] [React Flow Canvas] [NodePropertiesPanel]
 *   Sidebars are inline, fixed-width columns.
 * - Mobile (<768px): [React Flow Canvas] with toggle buttons in the toolbar.
 *   NodePalette and NodePropertiesPanel open as overlay drawers.
 *
 * Features:
 * - Drag & drop nodes from palette to canvas
 * - Click palette item to add node at center
 * - Visual connections between output→input gates
 * - Node properties panel for editing gates, instructions, role
 * - Artifact selector in gate editor (loads artifacts from MCA)
 * - Save/load flows via mca.teros.workflows MCA
 * - Toolbar with flow name, save, and status
 * - Responsive: drawers on mobile, inline sidebars on desktop
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Alert } from "react-native"
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type Node,
  type Edge,
  BackgroundVariant,
  useReactFlow,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { useTranslation } from "react-i18next"
import { Badge, Btn, EmptyState, IconBtn, Ph, T } from "../../components/ui/ds"

import { useMcaTools } from "../../hooks/useMcaTools"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useWorkspaceStore } from "../../store/workspaceStore"
import { useAuthStore } from "../../store/authStore"
import type { AgentMapEntry } from "../BoardWindow/board-utils"
import type { ProjectData } from "../../services/ProjectApi"
import type { BoardColumn } from "../../services/BoardApi"

import { FlowNodeComponent } from "./FlowNodeComponent"
import { FlowEdge } from "./FlowEdge"
import { FlowEditorContext } from "./FlowEditorContext"
import { NodePalette } from "./NodePalette"
import { NodePropertiesPanel } from "./NodePropertiesPanel"
import { Drawer } from "./Drawer"
import { ArtifactEditor, type ArtifactEditorSaveData } from "./ArtifactEditor"
import { FlowSettingsPanel, type FlowSettingsData } from "./FlowSettingsPanel"
import { useResponsive } from "./useResponsive"
import {
  NODE_TYPE_META,
  type FlowNodeData,
  type FlowRFNode,
  type FlowRFEdge,
  type NodeType,
  type Artifact,
  type Trigger,
  createDefaultGate,
  generateNodeId,
  generateEdgeId,
  flowToReactFlow,
  reactFlowToWorkflow,
} from "./types"
import type { FlowEditorWindowProps } from "./definition"
import { useFlowEditorTheme } from "./useFlowEditorTheme"
import { extractFlowError, type ParsedFlowError } from "../FlowExecutionWindow/parseFlowError"

// ============================================================================
// TYPES
// ============================================================================

interface FlowEditorWindowContentProps extends FlowEditorWindowProps {
  windowId: string
}

interface FlowData {
  flowId: string
  name: string
  description: string
  nodes: FlowRFNode[]
  edges: FlowRFEdge[]
  status: string
  projectId?: string
  triggers?: Trigger[]
}

// ============================================================================
// INNER COMPONENT (has access to React Flow context)
// ============================================================================

function FlowEditorInner({ appId: propAppId, flowId: propFlowId }: FlowEditorWindowContentProps) {
  const t = useFlowEditorTheme()
  const s = useEditorStyles()
  const { t: tr } = useTranslation()
  const client = getTerosClient()
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const userId = useAuthStore((s) => s.user?.userId)
  const userName = useAuthStore((s) => s.user?.name)
  const userAvatarUrl = useAuthStore((s) => s.user?.avatarUrl)
  const { isMobile } = useResponsive()

  // State — appId comes from props (serialized) or is resolved from backend
  const [resolvedAppId, setResolvedAppId] = useState(propAppId ?? "")
  const { executeTool } = useMcaTools(resolvedAppId)
  const { screenToFlowPosition } = useReactFlow()

  // State
  const [flowData, setFlowData] = useState<FlowData | null>(null)
  const [flowName, setFlowName] = useState("Untitled Flow")
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle")
  const [saveErrorMessage, setSaveErrorMessage] = useState<string>("")
  const [appNotInstalled, setAppNotInstalled] = useState(false)

  // Auto-save: track whether there are unsaved changes and debounce the save
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isInitialLoadRef = useRef(true)

  // Execute / Activate state
  const [isExecuting, setIsExecuting] = useState(false)
  const [isTogglingActive, setIsTogglingActive] = useState(false)
  const [executeError, setExecuteError] = useState<ParsedFlowError | null>(null)
  const [showProjectPicker, setShowProjectPicker] = useState(false)
  const [flowProjectId, setFlowProjectId] = useState<string>("")
  const [projects, setProjects] = useState<ProjectData[]>([])
  const [projectsLoading, setProjectsLoading] = useState(false)

  // Artifacts state (loaded from MCA for the gate selector)
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [artifactsLoading, setArtifactsLoading] = useState(false)

  // Trigger state — now managed via Start node's data.trigger
  // (no component-level trigger state needed; trigger config lives on the Start node)

  // Workspace members (agents + humans) for the assignee selector
  const [workspaceMembers, setWorkspaceMembers] = useState<Record<string, AgentMapEntry>>({})

  // Board columns for the column selector (action nodes) — loaded for the
  // currently relevant project (node override or flow default)
  const [boardColumns, setBoardColumns] = useState<BoardColumn[]>([])
  const [boardColumnsLoading, setBoardColumnsLoading] = useState(false)

  // Artifact editor state
  const [artifactEditorVisible, setArtifactEditorVisible] = useState(false)
  const [editingArtifact, setEditingArtifact] = useState<Artifact | null>(null)
  const [artifactSaving, setArtifactSaving] = useState(false)

  // Flow settings panel state
  const [settingsVisible, setSettingsVisible] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)

  // React Flow state
  const [nodes, setNodes] = useState<FlowRFNode[]>([])
  const [edges, setEdges] = useState<FlowRFEdge[]>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  // Drawer state (mobile only)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [propertiesOpen, setPropertiesOpen] = useState(false)

  // Desktop sidebar visibility (toggle on desktop too, not just mobile)
  const [paletteVisible, setPaletteVisible] = useState(true)
  const [propertiesVisible, setPropertiesVisible] = useState(true)

  // Refs
  const wrapperRef = useRef<HTMLDivElement>(null)
  const isDraggingFromPalette = useRef(false)

  // ========================================================================
  // APP ID RESOLUTION + FLOW LOADING + ARTIFACT LOADING
  // ========================================================================

  useEffect(() => {
    let cancelled = false

    const resolveAndLoad = async () => {
      // Step 1: Resolve appId if not provided
      if (!resolvedAppId) {
        try {
          const wsId = activeWorkspaceId ?? undefined
          if (!wsId) {
            setAppNotInstalled(true)
            setIsLoading(false)
            return
          }
          const { apps: wsApps } = await client.workspace.listWorkspaceApps(wsId)
          if (cancelled) return
          const found = wsApps.find((a: any) => a.mcaId === "mca.teros.workflows")
          if (found) {
            setResolvedAppId(found.appId)
          } else {
            setAppNotInstalled(true)
            setIsLoading(false)
            return
          }
        } catch (err) {
          console.error("[FlowEditor] Failed to resolve appId:", err)
          setAppNotInstalled(true)
          setIsLoading(false)
          return
        }
      }

      // Step 2: Load flow if flowId provided
      if (propFlowId && resolvedAppId) {
        try {
          const result = await executeTool<any>("get-flow", { flowId: propFlowId })
          if (cancelled) return
          if (result.success && result.result?.flowId) {
            const flow = result.result
            const { nodes: rfNodes, edges: rfEdges } = flowToReactFlow(flow)

            // Flowing-style: resolve edge colors from source gate artifact colors
            // When edges are loaded from backend, they may not have a color set.
            // We look up the source node's output gate schemaId → artifact → color.
            const coloredEdges = rfEdges.map((e: FlowRFEdge) => {
              if (e.data?.color) return e // already has color
              const sourceNode = rfNodes.find((n) => n.id === e.source)
              if (!sourceNode) return e
              const sourceData = sourceNode.data as FlowNodeData
              const sourceOutput = sourceData.outputs.find((o) => o.gateId === e.sourceHandle)
              if (!sourceOutput?.schemaId) return e
              // Artifact lookup will happen at render time via FlowEdge reading data.color,
              // but we can set it now if artifacts are already loaded
              return e
            })

            setFlowData({
              flowId: flow.flowId,
              name: flow.name,
              description: flow.description,
              nodes: rfNodes,
              edges: rfEdges,
              status: flow.status,
              projectId: flow.projectId,
            })
            setFlowName(flow.name)
            setFlowProjectId(flow.projectId ?? "")
            setNodes(rfNodes)
            setEdges(rfEdges)
            // Inject existing triggers into the Start node's data.trigger
            if (flow.triggers && Array.isArray(flow.triggers) && flow.triggers.length > 0) {
              const trigger = flow.triggers[0] // Start node carries the primary trigger
              const updatedNodes = rfNodes.map((n: FlowRFNode) =>
                n.data.nodeType === "start"
                  ? { ...n, data: { ...n.data, trigger } as FlowNodeData }
                  : n,
              )
              setNodes(updatedNodes)
            }
          }
        } catch (err) {
          console.error("[FlowEditor] Failed to load flow:", err)
        }
      } else if (!propFlowId) {
        // Start with a blank canvas + default start node
        const startNode = createDefaultNode("start", { x: 250, y: 200 })
        setNodes([startNode])
      }

      if (!cancelled) setIsLoading(false)
    }

    resolveAndLoad()
    return () => {
      cancelled = true
    }
  }, [propFlowId, resolvedAppId, activeWorkspaceId, client, executeTool])

  // ========================================================================
  // ARTIFACT LOADING (loads available artifacts for the gate selector)
  // ========================================================================

  const loadArtifacts = useCallback(async () => {
    if (!resolvedAppId) return
    setArtifactsLoading(true)
    try {
      const result = await executeTool<{ artifacts: Artifact[] }>("list-artifacts", {
        workspaceId: activeWorkspaceId,
      })
      if (result.success && result.result?.artifacts) {
        setArtifacts(result.result.artifacts)
      }
    } catch (err) {
      console.error("[FlowEditor] Failed to load artifacts:", err)
    } finally {
      setArtifactsLoading(false)
    }
  }, [resolvedAppId, activeWorkspaceId, executeTool])

  // Load artifacts when appId is resolved
  useEffect(() => {
    if (resolvedAppId) {
      loadArtifacts()
    }
  }, [resolvedAppId, loadArtifacts])

  // Flowing-style: update edge colors when artifacts are loaded
  // Edges loaded from backend may not have color set; resolve from source gate's artifact
  useEffect(() => {
    if (!artifacts.length || !edges.length) return
    setEdges((eds) =>
      eds.map((e) => {
        if (e.data?.color) return e // already has color
        const sourceNode = nodes.find((n) => n.id === e.source)
        if (!sourceNode) return e
        const sourceData = sourceNode.data as FlowNodeData
        const sourceOutput = sourceData.outputs.find((o) => o.gateId === e.sourceHandle)
        if (!sourceOutput?.schemaId) return e
        const artifact = artifacts.find((a) => a.artifactId === sourceOutput.schemaId)
        if (!artifact?.color) return e
        return { ...e, data: { ...e.data, color: artifact.color } } as FlowRFEdge
      }),
    )
  }, [artifacts, edges.length, nodes])

  // ========================================================================
  // AUTO-SAVE: Debounced save on any change to nodes, edges, or flow name
  // ========================================================================
  // We watch nodes, edges, and flowName. When any of them change (after the
  // initial load), we set hasUnsavedChanges=true and start a debounce timer.
  // When the timer fires, we call handleSave automatically.
  // The handleSave function is defined below via useCallback, so we use a ref
  // to always call the latest version without re-triggering the effect.

  const handleSaveRef = useRef<() => void>(() => {})
  handleSaveRef.current = () => {
    handleSave()
  }

  useEffect(() => {
    // Skip auto-save during initial load
    if (isInitialLoadRef.current) return
    if (!resolvedAppId) return
    if (!flowData?.flowId && !nodes.length) return // Don't auto-save a blank canvas with no flow

    setHasUnsavedChanges(true)
    setSaveStatus("idle")

    // Clear any existing timer
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
    }

    // Set a new timer — 1.5s debounce
    autoSaveTimerRef.current = setTimeout(() => {
      handleSaveRef.current()
    }, 1500)

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
      }
    }
  }, [nodes, edges, flowName, resolvedAppId, flowData?.flowId])

  // Mark initial load as complete after the first render with data
  useEffect(() => {
    if (!isLoading && resolvedAppId) {
      // Small delay to let state settle after load
      const t = setTimeout(() => {
        isInitialLoadRef.current = false
      }, 500)
      return () => clearTimeout(t)
    }
  }, [isLoading, resolvedAppId])

  // ── Artifact editor handlers ──────────────────────────────────────────

  const handleEditArtifact = useCallback((artifact: Artifact) => {
    setEditingArtifact(artifact)
    setArtifactEditorVisible(true)
  }, [])

  const handleCreateArtifact = useCallback(() => {
    setEditingArtifact(null)
    setArtifactEditorVisible(true)
  }, [])

  const handleSaveArtifact = useCallback(
    async (data: ArtifactEditorSaveData) => {
      setArtifactSaving(true)
      try {
        const baseInput = {
          name: data.name,
          title: data.title,
          description: data.description,
          color: data.color,
          icon: data.icon,
          source: data.source,
          schema: data.schema,
          workspaceId: activeWorkspaceId,
        }

        if (data.artifactId) {
          // Update existing artifact
          const result = await executeTool("update-artifact", {
            artifactId: data.artifactId,
            ...baseInput,
          })
          if (!result.success) {
            throw new Error(
              typeof result.result === "string" ? result.result : "Failed to update artifact",
            )
          }
        } else {
          // Create new artifact
          const result = await executeTool("create-artifact", baseInput)
          if (!result.success) {
            throw new Error(
              typeof result.result === "string" ? result.result : "Failed to create artifact",
            )
          }
        }

        // Refresh artifacts list
        await loadArtifacts()
        setArtifactEditorVisible(false)
        setEditingArtifact(null)
      } catch (err) {
        console.error("[FlowEditor] Failed to save artifact:", err)
        throw err
      } finally {
        setArtifactSaving(false)
      }
    },
    [activeWorkspaceId, executeTool, loadArtifacts],
  )

  // Load workspace projects (for the flow project selector and node override)
  useEffect(() => {
    if (!activeWorkspaceId) return
    let cancelled = false
    const loadProjects = async () => {
      try {
        const { projects: wsProjects } = await client.project.list(activeWorkspaceId)
        if (!cancelled) setProjects(wsProjects)
      } catch (err) {
        console.error("[FlowEditor] Failed to load projects:", err)
      }
    }
    loadProjects()
    return () => {
      cancelled = true
    }
  }, [activeWorkspaceId, client])

  // Load workspace agents + current user (human) for the assignee selector
  useEffect(() => {
    if (!activeWorkspaceId) return
    let cancelled = false
    const loadMembers = async () => {
      try {
        const { agents } = await client.agent.listAgents(activeWorkspaceId)
        if (cancelled) return
        const members: Record<string, AgentMapEntry> = {}
        for (const agent of agents) {
          members[agent.agentId] = {
            name: agent.name,
            avatarUrl: agent.avatarUrl,
            type: "agent" as const,
          }
        }
        // Add all human workspace members (MUW: previously only current user)
        try {
          const { humans } = await client.workspace.listHumans(activeWorkspaceId)
          if (cancelled) return
          for (const human of humans) {
            if (human.status === "active") {
              members[human.userId] = {
                name: human.displayName,
                avatarUrl: human.avatarUrl,
                type: "human" as const,
              }
            }
          }
        } catch {
          // Fallback: add current user as a human member
          if (userId) {
            members[userId] = {
              name: userName || "You",
              avatarUrl: userAvatarUrl,
              type: "human" as const,
            }
          }
        }
        setWorkspaceMembers(members)
      } catch (err) {
        console.error("[FlowEditor] Failed to load workspace members:", err)
      }
    }
    loadMembers()
    return () => {
      cancelled = true
    }
  }, [activeWorkspaceId, client, userId, userName, userAvatarUrl])

  // ========================================================================
  // REACT FLOW HANDLERS
  // ========================================================================

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds) as FlowRFNode[])
  }, [])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((eds) => applyEdgeChanges(changes, eds) as FlowRFEdge[])
  }, [])

  const onConnect = useCallback(
    (connection: Connection) => {
      // Flowing-style: derive edge color from the source gate's artifact color
      let edgeColor: string | undefined
      if (connection.source && connection.sourceHandle) {
        const sourceNode = nodes.find((n) => n.id === connection.source)
        if (sourceNode) {
          const sourceData = sourceNode.data as FlowNodeData
          const sourceOutput = sourceData.outputs.find((o) => o.gateId === connection.sourceHandle)
          if (sourceOutput?.schemaId) {
            const artifact = artifacts.find((a) => a.artifactId === sourceOutput.schemaId)
            if (artifact?.color) {
              edgeColor = artifact.color
            }
          }
        }
      }

      const edge: FlowRFEdge = {
        ...connection,
        id: generateEdgeId(),
        type: "flowEdge",
        data: {
          outputId: connection.sourceHandle ?? "",
          inputId: connection.targetHandle ?? "",
          ...(edgeColor ? { color: edgeColor } : {}),
        },
      } as FlowRFEdge
      setEdges((eds) => addEdge(edge, eds) as FlowRFEdge[])
    },
    [nodes, artifacts],
  )

  const onNodeClick = useCallback(
    (_: any, node: Node) => {
      setSelectedNodeId(node.id)
      if (isMobile) {
        setPropertiesOpen(true)
        setPaletteOpen(false)
      } else {
        // On desktop, auto-show the properties panel if it was hidden
        setPropertiesVisible(true)
      }
    },
    [isMobile],
  )

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null)
    // On mobile, close the properties drawer when clicking empty canvas
    if (isMobile) {
      setPropertiesOpen(false)
    }
  }, [isMobile])

  // ========================================================================
  // DRAG & DROP FROM PALETTE
  // ========================================================================

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = "move"
  }, [])

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      const nodeType = event.dataTransfer.getData("application/teros-flow-node") as NodeType
      if (!nodeType) return

      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      const newNode = createDefaultNode(nodeType, position)
      setNodes((nds) => [...nds, newNode])
      setSelectedNodeId(newNode.id)
    },
    [screenToFlowPosition],
  )

  // ========================================================================
  // NODE CREATION / DELETION / DUPLICATION
  // ========================================================================

  const handleAddNode = useCallback(
    (type: NodeType) => {
      // Add at a reasonable position (center-ish of current view)
      const position = { x: 300 + Math.random() * 100, y: 200 + Math.random() * 100 }
      const newNode = createDefaultNode(type, position)
      setNodes((nds) => [...nds, newNode])
      setSelectedNodeId(newNode.id)
      // On mobile, close the palette drawer after adding a node
      if (isMobile) {
        setPaletteOpen(false)
      }
    },
    [isMobile],
  )

  const handleDeleteNode = useCallback(() => {
    if (!selectedNodeId) return
    setNodes((nds) => nds.filter((n) => n.id !== selectedNodeId))
    setEdges((eds) => eds.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId))
    setSelectedNodeId(null)
    // On mobile, close the properties drawer after deleting
    if (isMobile) {
      setPropertiesOpen(false)
    }
  }, [selectedNodeId, isMobile])

  const handleDuplicateNode = useCallback(() => {
    if (!selectedNodeId) return
    const original = nodes.find((n) => n.id === selectedNodeId)
    if (!original) return
    const newData = { ...original.data } as FlowNodeData
    const newNode = createDefaultNode(newData.nodeType, {
      x: original.position.x + 50,
      y: original.position.y + 50,
    })
    // Copy the data from the original
    newNode.data = {
      ...newData,
      label: `${newData.label} (copy)`,
    }
    setNodes((nds) => [...nds, newNode])
    setSelectedNodeId(newNode.id)
  }, [selectedNodeId, nodes])

  // ========================================================================
  // NODE PROPERTIES UPDATE
  // ========================================================================

  const handleNodeDataChange = useCallback(
    (updates: Partial<FlowNodeData>) => {
      if (!selectedNodeId) return
      setNodes((nds) =>
        nds.map((n) =>
          n.id === selectedNodeId ? { ...n, data: { ...n.data, ...updates } as FlowNodeData } : n,
        ),
      )
    },
    [selectedNodeId],
  )

  // ========================================================================
  // TRIGGERS — build triggers for saving (Phase 4)
  // ========================================================================

  const buildTriggersForSave = useCallback(
    (overrideStatus?: string): Trigger[] => {
      const status = overrideStatus ?? flowData?.status ?? "draft"
      if (status !== "active") return []

      // Extract trigger config from the Start node's data.trigger
      const startNode = nodes.find((n) => n.data.nodeType === "start")
      const trigger = (startNode?.data as FlowNodeData)?.data?.trigger as Trigger | undefined
      if (trigger) {
        return [trigger]
      }
      // Default: manual trigger
      return [{ triggerId: "trigger_manual_1", type: "manual", config: {} }]
    },
    [nodes, flowData?.status],
  )

  // ========================================================================
  // SAVE FLOW
  // ========================================================================

  const handleSave = useCallback(async () => {
    if (!resolvedAppId) return
    setIsSaving(true)
    setSaveStatus("saving")
    setSaveErrorMessage("")
    try {
      const currentFlowId = flowData?.flowId || ""
      const { nodes: wfNodes, edges: wfEdges } = reactFlowToWorkflow(nodes, edges, currentFlowId)
      const input = {
        workspaceId: activeWorkspaceId,
        name: flowName,
        description: flowData?.description || "",
        nodes: wfNodes,
        edges: wfEdges,
        triggers: buildTriggersForSave(),
        status: flowData?.status || "draft",
        projectId: flowProjectId || undefined,
      }

      if (flowData?.flowId) {
        // Update existing flow — use create-flow with existing ID (MCA handles upsert)
        const result = await executeTool("create-flow", {
          ...input,
          flowId: flowData.flowId,
        })
        if (result.success) {
          setSaveStatus("saved")
          setHasUnsavedChanges(false)
          setTimeout(() => setSaveStatus("idle"), 2000)
        } else {
          const parsed = extractFlowError(result.result)
          const errMsg =
            parsed?.message ?? (typeof result.result === "string" ? result.result : "Save failed")
          console.error("[FlowEditor] Save failed (update):", errMsg)
          setSaveErrorMessage(errMsg)
          setSaveStatus("error")
        }
      } else {
        // Create new flow
        const result = await executeTool("create-flow", input)
        if (result.success && result.result?.flowId) {
          setFlowData({
            flowId: result.result.flowId,
            name: flowName,
            description: input.description,
            nodes,
            edges,
            status: input.status,
            projectId: input.projectId,
          })
          setSaveStatus("saved")
          setHasUnsavedChanges(false)
          setTimeout(() => setSaveStatus("idle"), 2000)
        } else {
          const parsed2 = extractFlowError(result.result)
          const errMsg2 =
            parsed2?.message ?? (typeof result.result === "string" ? result.result : "Save failed")
          console.error("[FlowEditor] Save failed (create):", errMsg2)
          setSaveErrorMessage(errMsg2)
          setSaveStatus("error")
        }
      }
    } catch (err) {
      const errMsg3 = err instanceof Error ? err.message : String(err)
      console.error("[FlowEditor] Save failed:", errMsg3)
      setSaveErrorMessage(errMsg3)
      setSaveStatus("error")
    } finally {
      setIsSaving(false)
    }
  }, [resolvedAppId, nodes, edges, flowName, flowData, activeWorkspaceId, executeTool])

  // ========================================================================
  // TOGGLE ACTIVE (draft ↔ active)
  // ========================================================================

  const handleToggleActive = useCallback(async () => {
    if (!resolvedAppId || !flowData?.flowId) return
    const currentStatus = flowData.status || "draft"
    const newStatus = currentStatus === "active" ? "draft" : "active"
    setIsTogglingActive(true)
    setExecuteError(null)
    try {
      const { nodes: wfNodes, edges: wfEdges } = reactFlowToWorkflow(nodes, edges, flowData.flowId)
      const result = await executeTool("create-flow", {
        workspaceId: activeWorkspaceId,
        name: flowName,
        description: flowData.description || "",
        nodes: wfNodes,
        edges: wfEdges,
        triggers: buildTriggersForSave(newStatus),
        status: newStatus,
        flowId: flowData.flowId,
        projectId: flowProjectId || undefined,
      })
      if (result.success) {
        setFlowData((prev) => (prev ? { ...prev, status: newStatus } : prev))
        setHasUnsavedChanges(false)
        setSaveStatus("saved")
        setTimeout(() => setSaveStatus("idle"), 2000)
      } else {
        const parsed = extractFlowError(result.result) ?? {
          code: "UNKNOWN",
          message:
            typeof result.result === "string" ? result.result : "Failed to toggle active status",
          suggestion: null,
          raw: String(result.result),
        }
        setExecuteError(parsed)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setExecuteError({ code: "EXCEPTION", message: msg, suggestion: null, raw: msg })
    } finally {
      setIsTogglingActive(false)
    }
  }, [resolvedAppId, flowData, nodes, edges, flowName, activeWorkspaceId, executeTool])

  // ========================================================================

  // ========================================================================
  // SAVE FLOW SETTINGS (from FlowSettingsPanel)
  // ========================================================================

  const handleSaveSettings = useCallback(
    async (data: FlowSettingsData) => {
      if (!resolvedAppId) return
      setSettingsSaving(true)
      try {
        const currentFlowId = flowData?.flowId || ""
        const { nodes: wfNodes, edges: wfEdges } = reactFlowToWorkflow(nodes, edges, currentFlowId)
        const input = {
          workspaceId: activeWorkspaceId,
          name: data.name,
          description: data.description,
          nodes: wfNodes,
          edges: wfEdges,
          triggers: buildTriggersForSave(data.status),
          status: data.status,
          projectId: data.projectId || undefined,
          ...(currentFlowId ? { flowId: currentFlowId } : {}),
        }

        const result = await executeTool("create-flow", input)
        if (result.success) {
          // Update local state with the new settings
          setFlowName(data.name)
          setFlowProjectId(data.projectId)
          if (result.result?.flowId && !flowData?.flowId) {
            // New flow was created — store the ID
            setFlowData({
              flowId: result.result.flowId,
              name: data.name,
              description: data.description,
              nodes,
              edges,
              status: data.status,
              projectId: data.projectId || undefined,
            })
          } else if (flowData) {
            // Existing flow — update in place
            setFlowData((prev) =>
              prev
                ? {
                    ...prev,
                    name: data.name,
                    description: data.description,
                    status: data.status,
                    projectId: data.projectId || undefined,
                  }
                : prev,
            )
          }
          setSettingsVisible(false)
          setHasUnsavedChanges(false)
          setSaveStatus("saved")
          setTimeout(() => setSaveStatus("idle"), 2000)
        } else {
          const errMsg =
            typeof result.result === "string" ? result.result : "Failed to save settings"
          throw new Error(errMsg)
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error("[FlowEditor] Settings save failed:", errMsg)
        throw err // Re-throw so the panel can display the error
      } finally {
        setSettingsSaving(false)
      }
    },
    [resolvedAppId, flowData, nodes, edges, activeWorkspaceId, executeTool, buildTriggersForSave],
  )

  // EXECUTE FLOW
  // ========================================================================

  const doExecute = useCallback(
    async (projectId: string) => {
      if (!flowData?.flowId) return
      setIsExecuting(true)
      setExecuteError(null)
      setShowProjectPicker(false)
      try {
        const result = await executeTool<any>("execute-flow", {
          flowId: flowData.flowId,
          projectId: projectId || flowProjectId || undefined,
          triggeredBy: "manual",
        })
        if (result.success) {
          const exec = result.result
          const execId = exec?.executionId || exec?.execution?.executionId || "unknown"
          Alert.alert(
            "Execution started",
            `Flow execution has been started.\nExecution ID: ${execId}`,
          )
        } else {
          const parsed = extractFlowError(result.result) ?? {
            code: "UNKNOWN",
            message: typeof result.result === "string" ? result.result : "Execution failed",
            suggestion: null,
            raw: String(result.result),
          }
          setExecuteError(parsed)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setExecuteError({ code: "EXCEPTION", message: msg, suggestion: null, raw: msg })
      } finally {
        setIsExecuting(false)
      }
    },
    [flowData, executeTool],
  )

  const loadProjectsAndShowPicker = useCallback(async () => {
    if (!activeWorkspaceId) return
    setProjectsLoading(true)
    setExecuteError(null)
    try {
      const { projects: wsProjects } = await client.project.list(activeWorkspaceId)
      setProjects(wsProjects)
      if (wsProjects.length === 0) {
        Alert.alert(
          "No projects",
          "Create a project on the board first — execution requires a target project.",
        )
        return
      }
      if (wsProjects.length === 1) {
        // Auto-select if only one project
        await doExecute(wsProjects[0].projectId)
      } else {
        setShowProjectPicker(true)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setExecuteError({ code: "PROJECTS_LOAD_FAILED", message: msg, suggestion: null, raw: msg })
    } finally {
      setProjectsLoading(false)
    }
  }, [activeWorkspaceId, client, doExecute])

  const handleExecuteClick = useCallback(async () => {
    if (!flowData?.flowId) {
      Alert.alert("Save required", "Please save the flow before executing it.")
      return
    }
    // If the flow has a default project, execute directly without showing the picker
    if (flowProjectId) {
      await doExecute(flowProjectId)
      return
    }
    if (flowData.status !== "active") {
      Alert.alert(
        "Activate required",
        "The flow must be activated before it can be executed. Activate it now?",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Activate & Execute",
            onPress: async () => {
              await handleToggleActive()
              // Wait for state to update, then open project picker
              setTimeout(() => loadProjectsAndShowPicker(), 100)
            },
          },
        ],
      )
      return
    }
    loadProjectsAndShowPicker()
  }, [flowData, handleToggleActive, loadProjectsAndShowPicker])

  // ========================================================================
  // SELECTED NODE DATA
  // ========================================================================

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null
  const selectedNodeData = selectedNode ? (selectedNode.data as FlowNodeData) : null

  // ========================================================================
  // BOARD COLUMNS — load columns for the column selector (action nodes)
  // ========================================================================

  // Determine which project's columns to load: the selected node's override,
  // or the flow's default project.
  const columnSourceProjectId = selectedNodeData?.projectId || flowProjectId || ""

  useEffect(() => {
    if (!columnSourceProjectId || !activeWorkspaceId) {
      setBoardColumns([])
      return
    }
    let cancelled = false
    const loadColumns = async () => {
      setBoardColumnsLoading(true)
      try {
        const result = await client.board.getBoard(columnSourceProjectId)
        if (cancelled) return
        // The board.get handler returns { board } where board has columns
        // (BoardColumn[] with columnId, name, slug, position)
        const board = (result as any)?.board
        if (board?.columns && Array.isArray(board.columns)) {
          // Sort by position to match board order
          const sorted = [...board.columns].sort(
            (a: any, b: any) => (a.position ?? 0) - (b.position ?? 0),
          )
          setBoardColumns(sorted as BoardColumn[])
        } else {
          setBoardColumns([])
        }
      } catch (err) {
        console.error("[FlowEditor] Failed to load board columns:", err)
        if (!cancelled) setBoardColumns([])
      } finally {
        if (!cancelled) setBoardColumnsLoading(false)
      }
    }
    loadColumns()
    return () => {
      cancelled = true
    }
  }, [columnSourceProjectId, activeWorkspaceId, client])

  // ========================================================================
  // RENDER
  // ========================================================================

  if (appNotInstalled) {
    return (
      <div style={s.container}>
        <div style={s.emptyState}>
          <EmptyState
            icon="package"
            title={tr("flowEditor.notInstalled.title", {
              defaultValue: "Workflows app not installed",
            })}
            text={tr("flowEditor.notInstalled.text", {
              defaultValue: "Install mca.teros.workflows from the catalog to use the Flow Editor.",
            })}
          />
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div style={s.container}>
        <div style={s.emptyState}>
          <T step="sm" tone="text3">
            {tr("flowEditor.loading", { defaultValue: "Loading flow editor…" })}
          </T>
        </div>
      </div>
    )
  }

  return (
    <div style={s.container} className="teros-flow-editor">
      {/* Pulse animation for the auto-save indicator + theme-aware React Flow chrome
          (the Controls / MiniMap widgets ship their own light-only CSS). */}
      <style>{`
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        .teros-flow-editor .react-flow__controls { box-shadow: ${t.liftSm}; }
        .teros-flow-editor .react-flow__controls-button {
          background: ${t.controlsBg};
          border-bottom: 1px solid ${t.toolbarBorder};
          color: ${t.controlsIconColor};
          width: 28px; height: 28px;
        }
        .teros-flow-editor .react-flow__controls-button svg { fill: ${t.controlsIconColor}; }
        .teros-flow-editor .react-flow__controls-button:hover { background: ${t.controlsHoverBg}; }
        .teros-flow-editor .react-flow__controls-button:last-child { border-bottom: none; }
        .teros-flow-editor .react-flow__minimap-mask { fill: ${t.miniMapMaskColor}; }
        .teros-flow-editor .react-flow__attribution { display: none; }
      `}</style>
      {/* Toolbar — the `.phead` strip: tile + serif name + status + tools */}
      <div style={s.toolbar}>
        {/* Left sidebar toggle — works on both desktop and mobile */}
        <IconBtn
          icon="sidebar-simple"
          plain
          on={isMobile ? paletteOpen : paletteVisible}
          onPress={() => {
            if (isMobile) {
              setPaletteOpen((v) => !v)
              setPropertiesOpen(false)
            } else {
              setPaletteVisible((v) => !v)
            }
          }}
          title={tr("flowEditor.toolbar.togglePalette", { defaultValue: "Toggle node palette" })}
        />

        {!isMobile && (
          <div style={s.tile}>
            <Ph name="flow-arrow" size={15} color={t.accent} />
          </div>
        )}

        {/* Flow name — serif title, editable in place */}
        <input
          type="text"
          value={flowName}
          onChange={(e) => setFlowName(e.target.value)}
          style={s.titleInput}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = t.inputFocusBorder
            e.currentTarget.style.background = t.inputBg
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = "transparent"
            e.currentTarget.style.background = "transparent"
          }}
          placeholder={tr("flowEditor.toolbar.namePlaceholder", { defaultValue: "Flow name" })}
        />

        {/* Active / draft indicator */}
        {flowData?.flowId && !isMobile && (
          <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
            <Badge tone={flowData.status === "active" ? "g" : "muted"} dot pill>
              {flowData.status === "active"
                ? tr("flowEditor.status.active", { defaultValue: "Active" })
                : flowData.status === "archived"
                  ? tr("flowEditor.status.archived", { defaultValue: "Archived" })
                  : tr("flowEditor.status.draft", { defaultValue: "Draft" })}
            </Badge>
          </div>
        )}

        <div style={{ flex: 1 }} />

        {/* Auto-save status indicator */}
        {saveStatus === "saving" && (
          <span style={s.saveNote}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: t.text3,
                animation: "pulse 1s infinite",
              }}
            />
            {tr("flowEditor.save.saving", { defaultValue: "Saving…" })}
          </span>
        )}
        {saveStatus === "saved" && !hasUnsavedChanges && (
          <span style={{ ...s.saveNote, color: t.tint.g.tx }}>
            <Ph name="check" size={12} color={t.success} />
            {tr("flowEditor.save.saved", { defaultValue: "Saved" })}
          </span>
        )}
        {saveStatus === "error" && (
          <span
            style={{ ...s.saveNote, color: t.tint.r.tx, cursor: "pointer" }}
            onClick={() => setSaveStatus("idle")}
            title={
              saveErrorMessage ||
              tr("flowEditor.save.failedHint", { defaultValue: "Save failed — click to dismiss" })
            }
          >
            <Ph name="x" size={12} color={t.error} />
            {tr("flowEditor.save.failed", { defaultValue: "Save failed" })}
          </span>
        )}

        {/* Execute error indicator (compact) */}
        {executeError && !isMobile && (
          <span
            style={{
              ...s.saveNote,
              color: t.tint.r.tx,
              maxWidth: 280,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              cursor: "pointer",
              textTransform: "none",
              letterSpacing: 0,
            }}
            title={
              executeError.suggestion
                ? `${executeError.message}\n\n${executeError.suggestion}`
                : executeError.message
            }
          >
            <Ph name="warning-circle" size={12} color={t.error} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {executeError.message}
            </span>
          </span>
        )}

        {/* Run — the primary pill (uses the existing execute flow, incl. activate + project picker) */}
        {flowData?.flowId && (
          <Btn
            variant="primary"
            size="sm"
            caps
            icon="play"
            loading={isExecuting || projectsLoading}
            onPress={handleExecuteClick}
            testID="flow-editor-run"
          >
            {tr("flowEditor.toolbar.run", { defaultValue: "Run" })}
          </Btn>
        )}

        {/* Settings — opens panel with Execute, Activate/Deactivate, and all flow config */}
        {isMobile ? (
          <IconBtn
            icon="gear-six"
            plain
            on={settingsVisible}
            onPress={() => setSettingsVisible(true)}
            title={tr("flowEditor.toolbar.settingsHint", {
              defaultValue: "Flow settings — execute, activate, configure",
            })}
          />
        ) : (
          <Btn
            variant={settingsVisible ? "sec" : "ghost"}
            size="sm"
            icon="gear-six"
            onPress={() => setSettingsVisible(true)}
            testID="flow-editor-settings"
          >
            {tr("flowEditor.toolbar.settings", { defaultValue: "Settings" })}
          </Btn>
        )}

        {/* Right sidebar toggle — works on both desktop and mobile */}
        <IconBtn
          icon="sliders-horizontal"
          plain
          on={isMobile ? propertiesOpen : propertiesVisible}
          onPress={() => {
            if (isMobile) {
              setPropertiesOpen((v) => !v)
              setPaletteOpen(false)
            } else {
              setPropertiesVisible((v) => !v)
            }
          }}
          title={tr("flowEditor.toolbar.toggleProperties", {
            defaultValue: "Toggle node properties",
          })}
        />
      </div>

      {/* Full-width error banner — shows when execute/save/toggle fails */}
      {executeError && (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            margin: "0 20px 10px",
            padding: "10px 14px",
            borderRadius: 12,
            background: t.errorBg,
            border: `1px solid ${t.errorBorder}`,
            fontFamily: t.fontSans,
            fontSize: 13,
            lineHeight: "18px",
            color: t.errorText,
            flexShrink: 0,
          }}
        >
          <Ph name="warning-circle" size={15} color={t.errorText} style={{ marginTop: 1 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div>{executeError.message}</div>
            {executeError.suggestion && (
              <div style={{ fontSize: 12, lineHeight: "16px", opacity: 0.85, marginTop: 2 }}>
                {executeError.suggestion}
              </div>
            )}
          </div>
          <IconBtn
            icon="x"
            plain
            sm
            color={t.errorText}
            onPress={() => setExecuteError(null)}
            title={tr("flowEditor.dismissError", { defaultValue: "Dismiss error" })}
          />
        </div>
      )}

      {/* Main content area */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden", position: "relative" }}>
        {/* Desktop: inline NodePalette (toggleable) */}
        {!isMobile && paletteVisible && <NodePalette onAddNode={handleAddNode} />}

        {/* React Flow canvas */}
        <div
          ref={wrapperRef}
          style={{ flex: 1, position: "relative", minWidth: 0 }}
          onDrop={onDrop}
          onDragOver={onDragOver}
        >
          <FlowEditorContext.Provider value={{ artifacts, workspaceMembers }}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={{ flowNode: FlowNodeComponent }}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={onNodeClick}
              onPaneClick={onPaneClick}
              fitView
              deleteKeyCode={["Delete", "Backspace"]}
              proOptions={{ hideAttribution: true }}
              defaultEdgeOptions={{ type: "flowEdge" }}
              edgeTypes={{ flowEdge: FlowEdge }}
            >
              <Background variant={BackgroundVariant.Dots} color={t.canvasDotColor} gap={20} />
              <Controls
                style={{
                  background: t.controlsBg,
                  border: `1px solid ${t.controlsBorder}`,
                  borderRadius: 12,
                  boxShadow: t.liftSm,
                  overflow: "hidden",
                }}
              />
              {/* MiniMap hidden on mobile to save screen space */}
              {!isMobile && (
                <MiniMap
                  style={{
                    background: t.miniMapBg,
                    border: `1px solid ${t.miniMapBorder}`,
                    borderRadius: 12,
                    boxShadow: t.liftSm,
                    overflow: "hidden",
                  }}
                  nodeColor={(node: Node) => {
                    const data = node.data as FlowNodeData
                    return data.color || (NODE_TYPE_META[data.nodeType]?.borderColor ?? "#6B7280")
                  }}
                  maskColor={t.miniMapMaskColor}
                />
              )}
            </ReactFlow>
          </FlowEditorContext.Provider>
        </div>

        {/* Desktop: inline NodePropertiesPanel (toggleable) */}
        {!isMobile && propertiesVisible && (
          <NodePropertiesPanel
            nodeData={selectedNodeData}
            nodeId={selectedNodeId}
            onChange={handleNodeDataChange}
            onDelete={handleDeleteNode}
            onDuplicate={handleDuplicateNode}
            artifacts={artifacts}
            artifactsLoading={artifactsLoading}
            projects={projects}
            workspaceMembers={workspaceMembers}
            onEditArtifact={handleEditArtifact}
            onCreateArtifact={handleCreateArtifact}
          />
        )}

        {/* Mobile: Palette drawer (overlay) */}
        {isMobile && (
          <Drawer
            side="left"
            open={paletteOpen}
            onClose={() => setPaletteOpen(false)}
            title="Node Types"
            width={260}
          >
            <NodePalette onAddNode={handleAddNode} variant="drawer" />
          </Drawer>
        )}

        {/* Mobile: Properties drawer (overlay) */}
        {isMobile && (
          <Drawer
            side="right"
            open={propertiesOpen}
            onClose={() => setPropertiesOpen(false)}
            title="Properties"
            width={300}
          >
            <NodePropertiesPanel
              nodeData={selectedNodeData}
              nodeId={selectedNodeId}
              onChange={handleNodeDataChange}
              onDelete={handleDeleteNode}
              onDuplicate={handleDuplicateNode}
              artifacts={selectedNodeId ? artifacts : []}
              artifactsLoading={artifactsLoading}
              projects={projects}
              boardColumns={boardColumns}
              boardColumnsLoading={boardColumnsLoading}
              workspaceMembers={workspaceMembers}
              variant="drawer"
              onClose={() => setPropertiesOpen(false)}
              onEditArtifact={handleEditArtifact}
              onCreateArtifact={handleCreateArtifact}
            />
          </Drawer>
        )}
      </div>

      {/* Project Picker Modal — shown when executing a flow with multiple projects */}
      {showProjectPicker && (
        <div
          onClick={() => setShowProjectPicker(false)}
          style={{
            position: "absolute",
            inset: 0,
            background: t.modalOverlay,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: t.modalBg,
              borderRadius: 16,
              padding: 20,
              minWidth: 320,
              maxWidth: 480,
              maxHeight: "70%",
              overflow: "auto",
              boxShadow: t.modalShadow,
              fontFamily: t.fontSans,
            }}
          >
            <T step="xl">
              {tr("flowEditor.projectPicker.title", { defaultValue: "Select a project" })}
            </T>
            <T step="sm" tone="text3" style={{ marginTop: 6, marginBottom: 16 }}>
              {tr("flowEditor.projectPicker.text", {
                defaultValue: "Choose the board project where the flow tasks will be created.",
              })}
            </T>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {projects.map((proj) => (
                <button
                  key={proj.projectId}
                  onClick={() => doExecute(proj.projectId)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    width: "100%",
                    textAlign: "left",
                    background: t.nestBg,
                    border: "1px solid transparent",
                    borderRadius: 12,
                    padding: "10px 14px",
                    cursor: "pointer",
                    fontFamily: t.fontSans,
                    transition: "background 0.2s, border-color 0.2s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = t.nestHoverBg
                    e.currentTarget.style.borderColor = t.cardHoverBorder
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = t.nestBg
                    e.currentTarget.style.borderColor = "transparent"
                  }}
                >
                  <div style={s.tile}>
                    <Ph name="kanban" size={15} color={t.accent} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <T step="sm" ellipsis>
                      {proj.name}
                    </T>
                    {proj.description ? (
                      <T step="12" tone="text3" ellipsis>
                        {proj.description}
                      </T>
                    ) : null}
                  </div>
                  <Ph name="caret-right" size={13} color={t.text3} />
                </button>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
              <Btn variant="ghost" onPress={() => setShowProjectPicker(false)}>
                {tr("common.cancel", { defaultValue: "Cancel" })}
              </Btn>
            </div>
          </div>
        </div>
      )}

      {/* Artifact Editor Modal */}
      <ArtifactEditor
        visible={artifactEditorVisible}
        artifact={editingArtifact}
        onSave={handleSaveArtifact}
        onClose={() => {
          setArtifactEditorVisible(false)
          setEditingArtifact(null)
        }}
        saving={artifactSaving}
      />

      {/* Flow Settings Panel Modal */}
      <FlowSettingsPanel
        visible={settingsVisible}
        flowName={flowName}
        flowDescription={flowData?.description || ""}
        flowProjectId={flowProjectId}
        flowStatus={flowData?.status || "draft"}
        flowId={flowData?.flowId ?? null}
        projects={projects}
        nodeCount={nodes.length}
        edgeCount={edges.length}
        onSave={handleSaveSettings}
        onClose={() => setSettingsVisible(false)}
        saving={settingsSaving}
        onExecute={handleExecuteClick}
        onToggleActive={handleToggleActive}
        isExecuting={isExecuting}
        isTogglingActive={isTogglingActive}
      />
    </div>
  )
}

// ============================================================================
// HELPER: Create a default node with gates based on type
// ============================================================================

function createDefaultNode(type: NodeType, position: { x: number; y: number }): FlowRFNode {
  const meta = NODE_TYPE_META[type]
  const nodeId = generateNodeId()

  const inputs = Array.from({ length: meta.defaultInputs }, (_, i) => createDefaultGate("input", i))
  const outputs = Array.from({ length: meta.defaultOutputs }, (_, i) =>
    createDefaultGate("output", i),
  )

  return {
    id: nodeId,
    type: "flowNode",
    position,
    data: {
      nodeType: type,
      label: meta.label,
      description: meta.description,
      instructions: "",
      role: type === "action" ? "human" : "",
      color: meta.defaultColor,
      direction: meta.defaultDirection,
      inputs,
      outputs,
    },
  }
}

// ============================================================================
// OUTER COMPONENT (wraps with ReactFlowProvider)
// ============================================================================

export function FlowEditorWindowContent(props: FlowEditorWindowContentProps) {
  return (
    <ReactFlowProvider>
      <FlowEditorInner {...props} />
    </ReactFlowProvider>
  )
}

// ============================================================================
// SHARED STYLES (theme-adaptive — built from useFlowEditorTheme tokens)
// ============================================================================

function useEditorStyles(): Record<string, React.CSSProperties> {
  const t = useFlowEditorTheme()
  return {
    container: {
      display: "flex",
      flexDirection: "column",
      height: "100%",
      width: "100%",
      background: t.containerBg,
      fontFamily: t.fontSans,
      overflow: "hidden",
    },
    // `.phead` — the 60px window header strip
    toolbar: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      minHeight: 60,
      padding: "12px 20px",
      background: t.toolbarBg,
      borderBottom: `1px solid ${t.toolbarBorder}`,
      flexShrink: 0,
    },
    tile: {
      width: 28,
      height: 28,
      borderRadius: 6,
      background: t.tile,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    titleInput: {
      background: "transparent",
      border: "1px solid transparent",
      borderRadius: 8,
      padding: "2px 8px",
      marginLeft: -8,
      color: t.text,
      fontFamily: t.fontSerif,
      fontSize: 22,
      lineHeight: "26px",
      letterSpacing: 0.44,
      fontWeight: 400,
      outline: "none",
      minWidth: 120,
      flex: 1,
      maxWidth: 420,
      transition: "border-color 0.2s, background 0.2s",
    },
    saveNote: {
      display: "flex",
      alignItems: "center",
      gap: 5,
      fontFamily: t.fontMono,
      fontSize: 10,
      lineHeight: "12px",
      letterSpacing: 0.5,
      textTransform: "uppercase",
      color: t.text3,
      flexShrink: 0,
    },
    emptyState: {
      flex: 1,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      textAlign: "center",
    },
  }
}
