/**
 * FlowExecutionWindowContent — Real-time execution monitor
 *
 * Layout: [React Flow Canvas with status-colored nodes] [StepDetailsPanel]
 *
 * Features:
 * - Loads flow graph + execution status on mount
 * - Polls get-execution every 5s while execution is running
 * - Nodes colored by step status (pending, running, completed, failed, blocked)
 * - Click node to see details in sidebar (input/output data, task ID, error)
 * - Toolbar with execution status badge, step summary, and auto-refresh toggle
 * - Stops polling when execution reaches a terminal state (completed/failed)
 */

import React, { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, ScrollView, View } from "react-native"
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  type Node,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"

import { useMcaTools } from "../../hooks/useMcaTools"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useWorkspaceStore } from "../../store/workspaceStore"
import { FullscreenLoader } from "../../components/ui"
import { useColors, useMcaTheme } from "../../components/mca/primitives/useColors"
import { colors as semantic } from "../../components/mca/primitives/colors"
import {
  Badge,
  Btn,
  ChipBtn,
  Dot,
  EmptyState,
  IconBtn,
  LGroup,
  LRow,
  Page,
  PHead,
  Ph,
  SectionLabel,
  T,
} from "../../components/ui/ds"

import { ExecutionNodeComponent } from "./ExecutionNodeComponent"
import { StepDetailsPanel } from "./StepDetailsPanel"
import {
  EXECUTION_STATUS_META,
  EXECUTION_STATUS_PH,
  EXECUTION_STATUS_TONE,
  EXEC_NODE_TYPE_META,
  STEP_STATUS_PH,
  STEP_STATUS_TONE,
  flowToExecutionNodes,
  formatDuration,
  POLL_INTERVAL_MS,
  MAX_POLL_ATTEMPTS,
  type ExecutionRFNode,
  type ExecutionRFEdge,
  type ExecutionNodeData,
  type ExecutionStep,
  type ExecutionStatus,
  type Flow,
  type StatusTone,
} from "./types"
import type { FlowExecutionWindowProps } from "./definition"
import { extractFlowError, type ParsedFlowError } from "./parseFlowError"

// ============================================================================
// TYPES
// ============================================================================

interface FlowExecutionWindowContentProps extends FlowExecutionWindowProps {
  windowId: string
}

interface ExecutionData {
  executionId: string
  flowId: string
  status: ExecutionStatus
  triggeredBy: string
  currentNodes: string[]
  startedAt: string
  completedAt?: string
  error?: string
}

interface ExecutionResult {
  execution: ExecutionData
  steps: Array<{
    stepId: string
    nodeId: string
    status: ExecutionStep["status"]
    taskId?: string
    inputData?: Record<string, unknown>
    outputData?: Record<string, unknown>
    startedAt?: string
    completedAt?: string
    error?: string
  }>
  summary: {
    totalSteps: number
    completed: number
    running: number
    pending: number
    failed: number
    blocked: number
    allCompleted: boolean
  }
}

/** Solid status colour for dots (the tint borders are too pale on the sheet). */
function toneSolid(tone: StatusTone, neutral: string): string {
  switch (tone) {
    case "g":
      return semantic.green
    case "a":
      return semantic.amber
    case "r":
      return semantic.red
    case "i":
      return semantic.purple300
    case "m":
      return semantic.mint300
    default:
      return neutral
  }
}

// ============================================================================
// INNER COMPONENT (has access to React Flow context)
// ============================================================================

function FlowExecutionInner({
  appId: propAppId,
  executionId: propExecutionId,
  flowId: propFlowId,
  flowName: propFlowName,
}: FlowExecutionWindowContentProps) {
  const { t } = useTranslation()
  const c = useColors()
  const isDark = useMcaTheme() === "dark"
  const client = getTerosClient()
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)

  // App ID resolution
  const [resolvedAppId, setResolvedAppId] = useState(propAppId ?? "")
  const { executeTool } = useMcaTools(resolvedAppId)

  // State
  const [flow, setFlow] = useState<Flow | null>(null)
  const [executionData, setExecutionData] = useState<ExecutionResult | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<ParsedFlowError | null>(null)
  const [appNotInstalled, setAppNotInstalled] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)

  // React Flow state
  const [nodes, setNodes] = useState<ExecutionRFNode[]>([])
  const [edges, setEdges] = useState<ExecutionRFEdge[]>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  // Refs
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollCountRef = useRef(0)
  const isMountedRef = useRef(true)

  // ========================================================================
  // APP ID RESOLUTION + INITIAL LOAD
  // ========================================================================

  useEffect(() => {
    let cancelled = false
    isMountedRef.current = true

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
          console.error("[FlowExecution] Failed to resolve appId:", err)
          setAppNotInstalled(true)
          setIsLoading(false)
          return
        }
      }

      // Step 2: Need an executionId to monitor
      if (!propExecutionId) {
        setError({
          code: "NO_EXECUTION_ID",
          message: "No execution ID provided. Open this window from a flow execution.",
          suggestion: null,
          raw: "",
        })
        setIsLoading(false)
        return
      }

      // Step 3: Load flow data (if we have a flowId)
      if (propFlowId && resolvedAppId) {
        try {
          const flowResult = await executeTool<{ flow: Flow }>("get-flow", { flowId: propFlowId })
          if (cancelled) return
          if (flowResult.success && flowResult.result?.flow) {
            setFlow(flowResult.result.flow)
          }
        } catch (err) {
          console.error("[FlowExecution] Failed to load flow:", err)
        }
      }

      // Step 4: Load execution status
      await refreshExecution(propExecutionId, resolvedAppId)

      if (!cancelled) setIsLoading(false)
    }

    resolveAndLoad()

    return () => {
      cancelled = true
      isMountedRef.current = false
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propExecutionId, propFlowId, resolvedAppId, activeWorkspaceId, client])

  // ========================================================================
  // REFRESH EXECUTION STATUS
  // ========================================================================

  const refreshExecution = useCallback(
    async (execId: string, appId: string) => {
      if (!appId || !execId) return
      setIsRefreshing(true)
      try {
        const result = await executeTool<ExecutionResult>("get-execution", { executionId: execId })
        if (!isMountedRef.current) return
        if (result.success && result.result) {
          setExecutionData(result.result)
          // If we have flow data, update the graph
          if (flow) {
            // Convert steps to ExecutionStep format for the converter
            const steps: ExecutionStep[] = result.result.steps.map((s) => ({
              stepId: s.stepId,
              executionId: execId,
              flowId: flow.flowId,
              workspaceId: flow.workspaceId,
              nodeId: s.nodeId,
              taskId: s.taskId,
              status: s.status,
              inputData: s.inputData,
              outputData: s.outputData,
              startedAt: s.startedAt ? new Date(s.startedAt) : undefined,
              completedAt: s.completedAt ? new Date(s.completedAt) : undefined,
              error: s.error,
              createdAt: new Date(),
              updatedAt: new Date(),
            }))
            const { nodes: rfNodes, edges: rfEdges } = flowToExecutionNodes(flow, steps)
            setNodes(rfNodes)
            setEdges(rfEdges)
          }
        }
      } catch (err) {
        console.error("[FlowExecution] Failed to refresh execution:", err)
        const msg = err instanceof Error ? err.message : String(err)
        const parsed = extractFlowError(msg) ?? {
          code: "REFRESH_FAILED",
          message: msg,
          suggestion: null,
          raw: msg,
        }
        if (isMountedRef.current) setError(parsed)
      } finally {
        if (isMountedRef.current) setIsRefreshing(false)
      }
    },
    [executeTool, flow],
  )

  // ========================================================================
  // POLLING — auto-refresh while execution is running
  // ========================================================================

  useEffect(() => {
    // Clear any existing poll
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    pollCountRef.current = 0

    if (!autoRefresh || !resolvedAppId || !propExecutionId) return

    // Only poll if execution is running or paused
    const execStatus = executionData?.execution?.status
    const isTerminal = execStatus === "completed" || execStatus === "failed"
    if (isTerminal) return

    pollRef.current = setInterval(async () => {
      pollCountRef.current++
      if (pollCountRef.current > MAX_POLL_ATTEMPTS) {
        if (pollRef.current) clearInterval(pollRef.current)
        console.warn("[FlowExecution] Max poll attempts reached, stopping auto-refresh")
        return
      }
      await refreshExecution(propExecutionId, resolvedAppId)
    }, POLL_INTERVAL_MS)

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [
    autoRefresh,
    resolvedAppId,
    propExecutionId,
    executionData?.execution?.status,
    refreshExecution,
  ])

  // ========================================================================
  // WEBSOCKET SUBSCRIPTION — real-time execution events
  // ========================================================================

  useEffect(() => {
    if (!propExecutionId) return

    // Subscribe to flow execution events via WebSocket
    client.board.subscribeExecution(propExecutionId).catch((err) => {
      console.warn("[FlowExecution] subscribeExecution error:", err)
    })

    // When a step or execution event arrives, trigger a refresh.
    // The event payload contains the updated step/execution data, but we
    // do a full refresh to ensure consistency (the get-execution endpoint
    // returns the complete state).
    const onStepUpdated = (_msg: any) => {
      if (!isMountedRef.current) return
      refreshExecution(propExecutionId, resolvedAppId)
    }
    const onExecutionUpdated = (_msg: any) => {
      if (!isMountedRef.current) return
      refreshExecution(propExecutionId, resolvedAppId)
    }

    client.on("flow_step_updated", onStepUpdated)
    client.on("flow_execution_updated", onExecutionUpdated)

    return () => {
      client.board.unsubscribeExecution(propExecutionId).catch((err) => {
        console.warn("[FlowExecution] unsubscribeExecution error:", err)
      })
      client.off("flow_step_updated", onStepUpdated)
      client.off("flow_execution_updated", onExecutionUpdated)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propExecutionId, resolvedAppId, refreshExecution])

  // ========================================================================
  // NODE CLICK HANDLER
  // ========================================================================

  const onNodeClick = useCallback((_: any, node: Node) => {
    setSelectedNodeId(node.id)
  }, [])

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null)
  }, [])

  // ========================================================================
  // DERIVED DATA
  // ========================================================================

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null
  const selectedNodeData = selectedNode ? (selectedNode.data as ExecutionNodeData) : null
  const selectedStep = executionData?.steps.find((s) => s.nodeId === selectedNodeId) ?? null

  const execStatus = executionData?.execution?.status
  const execMeta = execStatus ? EXECUTION_STATUS_META[execStatus] : null
  const summary = executionData?.summary

  const execTone = execStatus ? EXECUTION_STATUS_TONE[execStatus] : "neutral"
  const execGlyph = execStatus ? EXECUTION_STATUS_PH[execStatus] : "circle"
  const flowTitle =
    propFlowName || flow?.name || t("flowExecution.title", { defaultValue: "Execution" })

  const stepRows = nodes.map((n) => {
    const d = n.data as ExecutionNodeData
    const s = executionData?.steps.find((st) => st.nodeId === n.id) ?? null
    return { id: n.id, data: d, step: s }
  })

  // ========================================================================
  // RENDER
  // ========================================================================

  if (appNotInstalled) {
    return (
      <Page>
        <EmptyState
          icon="package"
          title={t("flowExecution.notInstalled.title", {
            defaultValue: "Workflows app not installed",
          })}
          text={t("flowExecution.notInstalled.text", {
            defaultValue: "Install mca.teros.workflows from the catalog to monitor executions",
          })}
        />
      </Page>
    )
  }

  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bgSheet }}>
        <FullscreenLoader
          variant="default"
          label={t("flowExecution.loading", { defaultValue: "Loading execution monitor…" })}
        />
      </View>
    )
  }

  if (error) {
    return (
      <Page>
        <EmptyState
          icon="warning-circle"
          title={error.message}
          text={error.suggestion ?? undefined}
          action={
            <Btn
              variant="sec"
              icon="arrows-clockwise"
              onPress={() => {
                setError(null)
                if (propExecutionId && resolvedAppId) {
                  setIsLoading(true)
                  refreshExecution(propExecutionId, resolvedAppId).finally(() =>
                    setIsLoading(false),
                  )
                }
              }}
            >
              {t("flowExecution.retry", { defaultValue: "Retry" })}
            </Btn>
          }
        />
      </Page>
    )
  }

  const summaryChips: Array<{
    key: string
    tone: StatusTone
    glyph: string
    n: number
    show: boolean
  }> = summary
    ? [
        {
          key: "completed",
          tone: "g",
          glyph: STEP_STATUS_PH.completed,
          n: summary.completed,
          show: true,
        },
        {
          key: "running",
          tone: "i",
          glyph: STEP_STATUS_PH.running,
          n: summary.running,
          show: true,
        },
        {
          key: "pending",
          tone: "neutral",
          glyph: STEP_STATUS_PH.pending,
          n: summary.pending,
          show: true,
        },
        {
          key: "failed",
          tone: "r",
          glyph: STEP_STATUS_PH.failed,
          n: summary.failed,
          show: summary.failed > 0,
        },
        {
          key: "blocked",
          tone: "a",
          glyph: STEP_STATUS_PH.blocked,
          n: summary.blocked,
          show: summary.blocked > 0,
        },
      ]
    : []

  return (
    <View style={{ flex: 1, backgroundColor: c.bgSheet, overflow: "hidden" }}>
      {/* Inline keyframe for the running-node pulse */}
      {Platform.OS === "web" ? (
        <style>{`
          @keyframes execPulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.7; }
          }
        `}</style>
      ) : null}

      {/* Header strip (`.phead`) */}
      <PHead
        icon="play-circle"
        title={flowTitle}
        right={
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {summaryChips
              .filter((s) => s.show)
              .map((s) => (
                <Badge key={s.key} tone={s.tone} icon={s.glyph} mono>
                  {String(s.n)}
                </Badge>
              ))}
            {executionData?.execution?.startedAt ? (
              <T step="codenote" tone="text3" style={{ marginHorizontal: 6 }}>
                {formatDuration(
                  executionData.execution.startedAt,
                  executionData.execution.completedAt,
                )}
              </T>
            ) : null}
            <ChipBtn
              on={autoRefresh}
              icon={autoRefresh ? "arrows-clockwise" : "pause"}
              onPress={() => setAutoRefresh(!autoRefresh)}
            >
              {autoRefresh
                ? t("flowExecution.autoRefresh", { defaultValue: "Auto" })
                : t("flowExecution.manualRefresh", { defaultValue: "Manual" })}
            </ChipBtn>
            <IconBtn
              icon="arrow-clockwise"
              plain
              disabled={isRefreshing}
              title={t("flowExecution.refresh", { defaultValue: "Refresh" })}
              onPress={() => refreshExecution(propExecutionId!, resolvedAppId)}
            />
          </View>
        }
        style={{ borderBottomWidth: 1, borderBottomColor: c.border }}
      >
        {execMeta ? (
          <Badge tone={execTone} icon={execGlyph} dot={!!execMeta.pulse} pill>
            {execMeta.label}
          </Badge>
        ) : null}
      </PHead>

      {/* Execution error banner — shows when execution status is 'failed' */}
      {executionData?.execution?.error ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "flex-start",
            gap: 8,
            paddingVertical: 10,
            paddingHorizontal: 20,
            backgroundColor: c.tint.r.bg,
            borderBottomWidth: 1,
            borderBottomColor: c.tint.r.bd,
          }}
        >
          <Ph name="warning" size={14} color={c.tint.r.tx} />
          <T step="12" color={c.tint.r.tx} style={{ flex: 1 }}>
            {executionData.execution.error}
          </T>
        </View>
      ) : null}

      {/* Main content: canvas + side column */}
      <View style={{ flex: 1, flexDirection: "row", overflow: "hidden" }}>
        {/* React Flow canvas */}
        <View style={{ flex: 1, position: "relative", minWidth: 0 }}>
          {nodes.length > 0 ? (
            <div
              style={
                {
                  position: "absolute",
                  inset: 0,
                  "--xy-background-color": c.bgSheet,
                  "--xy-controls-button-background-color": c.bgStep,
                  "--xy-controls-button-background-color-hover": c.wash2,
                  "--xy-controls-button-color": c.text2,
                  "--xy-controls-button-color-hover": c.text,
                  "--xy-controls-button-border-color": c.border,
                  "--xy-minimap-background-color": c.bgStep,
                  "--xy-minimap-mask-background-color": c.wash2,
                  "--xy-edge-stroke": c.borderStrong,
                  "--xy-edge-stroke-selected": c.accent,
                } as React.CSSProperties
              }
            >
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={{ executionNode: ExecutionNodeComponent }}
                onNodeClick={onNodeClick}
                onPaneClick={onPaneClick}
                fitView
                proOptions={{ hideAttribution: true }}
                defaultEdgeOptions={{ type: "smoothstep" }}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={true}
                colorMode={isDark ? "dark" : "light"}
              >
                <Background variant={BackgroundVariant.Dots} color={c.borderStrong} gap={20} />
                <Controls
                  style={{
                    background: c.bgStep,
                    border: `1px solid ${c.border}`,
                    borderRadius: 10,
                    boxShadow: c.liftSm,
                    overflow: "hidden",
                  }}
                />
                <MiniMap
                  style={{
                    background: c.bgStep,
                    border: `1px solid ${c.border}`,
                    borderRadius: 12,
                  }}
                  nodeColor={(node: Node) => {
                    const data = node.data as ExecutionNodeData
                    return toneSolid(
                      data.stepStatus ? STEP_STATUS_TONE[data.stepStatus] : "neutral",
                      c.borderStrong,
                    )
                  }}
                  maskColor={c.wash2}
                />
              </ReactFlow>
            </div>
          ) : (
            <EmptyState
              icon="graph"
              title={t("flowExecution.noGraph.title", { defaultValue: "No flow graph available" })}
              text={
                flow
                  ? t("flowExecution.noGraph.waiting", {
                      defaultValue: "Waiting for execution steps…",
                    })
                  : t("flowExecution.noGraph.noFlow", {
                      defaultValue: "Flow data could not be loaded. Execution ID: {{id}}",
                      id: propExecutionId,
                    })
              }
              style={{ flex: 1 }}
            />
          )}
        </View>

        {/* Side column: details card + steps list */}
        <ScrollView
          style={{
            width: 300,
            flexGrow: 0,
            flexShrink: 0,
            borderLeftWidth: 1,
            borderLeftColor: c.border,
          }}
          contentContainerStyle={{ padding: 16, gap: 16 }}
        >
          <StepDetailsPanel nodeData={selectedNodeData} step={selectedStep as any} />

          {stepRows.length > 0 ? (
            <View>
              <SectionLabel
                label={t("flowExecution.steps", { defaultValue: "Steps" })}
                count={stepRows.length}
                style={{ marginTop: 0 }}
              />
              <LGroup>
                {stepRows.map(({ id, data, step }) => {
                  const dotColor = toneSolid(
                    data.stepStatus ? STEP_STATUS_TONE[data.stepStatus] : "neutral",
                    c.text3,
                  )
                  const on = id === selectedNodeId
                  return (
                    <LRow
                      key={id}
                      padV={10}
                      padH={12}
                      gap={10}
                      onPress={() => setSelectedNodeId(id)}
                      style={on ? { backgroundColor: c.navActive } : undefined}
                    >
                      <Dot color={dotColor} size={7} />
                      <T step="sm" color={on ? c.accent : c.text} ellipsis style={{ flex: 1 }}>
                        {data.label || EXEC_NODE_TYPE_META[data.nodeType].label}
                      </T>
                      <T step="codenote" tone="text3">
                        {step?.startedAt
                          ? formatDuration(
                              String(step.startedAt),
                              step.completedAt ? String(step.completedAt) : undefined,
                            )
                          : "—"}
                      </T>
                    </LRow>
                  )
                })}
              </LGroup>
            </View>
          ) : null}
        </ScrollView>
      </View>
    </View>
  )
}

// ============================================================================
// OUTER COMPONENT (wraps with ReactFlowProvider)
// ============================================================================

export function FlowExecutionWindowContent(props: FlowExecutionWindowContentProps) {
  return (
    <ReactFlowProvider>
      <FlowExecutionInner {...props} />
    </ReactFlowProvider>
  )
}
