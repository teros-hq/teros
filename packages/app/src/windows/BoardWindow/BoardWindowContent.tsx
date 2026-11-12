/**
 * Board Window Content
 *
 * Kanban board UI with columns and task cards, in the OS prototype language
 * (design-testing, Oct 2026): a `PHead` strip (tile glyph · serif project
 * name · PTabs Misión/Kanban/Lista/Ajustes · "N ABIERTAS" · "+ TAREA" pill),
 * a hint line with the Autoplay pill, and the columns scrolling sideways on
 * the sheet.
 *
 * Supports:
 * - Project selector (dropdown)
 * - Columns with task cards (drag & drop)
 * - Create task inline
 * - Task detail panel
 * - List view of the same tasks
 */

import type { AgentRelationship, BoardAgentInfo } from "../../services/BoardApi"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Modal, Platform, Pressable, ScrollView, View } from "react-native"
import { useTranslation } from "react-i18next"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useToast } from "../../components/Toast"
import {
  type Board,
  destroyBoardStore,
  getBoardStore,
  getTasksByColumn,
  type Project,
  type Task,
  useBoardStore,
} from "../../store/boardStore"
import { useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import { useAuthStore } from "../../store/authStore"
import type { BoardWindowProps } from "./definition"
import { KanbanColumn } from "./KanbanColumn"
import { MissionControl } from "./MissionControl"
import { ProjectSettingsView } from "./ProjectSettingsView"
import { TaskDetailPanel } from "./TaskDetailPanel"
import { AUTOPLAY_PANEL_WIDTH, type AgentRelationshipState, AutoplayPanel } from "./AutoplayPanel"
import { priorityMeta, StatusMark } from "./TaskCard"
import { AppSpinner } from "../../components/ui"
import {
  computeDependencyHighlights,
  getColumnColor,
  timeAgo,
  type DependencyHighlight,
  type AgentMapEntry,
  type MemberType,
} from "./board-utils"
import { colors } from "../../components/mca/primitives/colors"
import { useColors } from "../../components/mca/primitives/useColors"
import { Avatar } from "../../components/Avatar"
import { normalizeTags } from "@teros/shared"
import {
  Badge,
  Btn,
  Check,
  ChipBtn,
  Dot,
  EmptyState,
  Field,
  IconBtn,
  LGroup,
  LRow,
  PHead,
  Ph,
  PTabs,
  T,
} from "../../components/ui/ds"

type BoardViewMode = "kanban" | "mission" | "settings" | "list"
const BOARD_VIEW_MODES: BoardViewMode[] = ["kanban", "mission", "settings", "list"]
/** Width of the TaskDetailPanel overlay (keeps the columns scrollable beside it). */
const TASK_DETAIL_WIDTH = 440

// ============================================================================
// MAIN COMPONENT
// ============================================================================

interface BoardWindowContentProps extends BoardWindowProps {
  windowId: string
}

export function BoardWindowContent({
  windowId,
  workspaceId: initialWorkspaceId,
  projectId: initialProjectId,
  view: initialView,
}: BoardWindowContentProps) {
  const { t } = useTranslation()
  const c = useColors()
  const client = getTerosClient()
  const toast = useToast()
  const { openWindow, updateWindowProps } = useTilingStore()

  const {
    projects,
    board,
    tasks,
    boardFeed,
    currentProjectId,
    isLoadingProjects,
    isLoadingBoard,
    isCreatingTask,
    selectedTaskId,
    setCurrentProject,
    setProjects,
    setBoard,
    setTasks,
    setBoardFeed,
    addTask,
    addTasks,
    updateTaskInStore,
    hydrateTask,
    removeTask,
    setSelectedTask,
    setLoadingProjects,
    setLoadingBoard,
    setCreatingTask,
    addProject,
  } = useBoardStore(windowId)

  // workspaceId: single source of truth — prop takes priority, falls back to
  // active workspace from Zustand store (handles late AsyncStorage hydration).
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const workspaceId = initialWorkspaceId || activeWorkspaceId || ""
  const userAvatarUrl = useAuthStore((s) => s.user?.avatarUrl)
  const userName = useAuthStore((s) => s.user?.name)
  const userId = useAuthStore((s) => s.user?.userId)

  // WebSocket connection state — data loading must wait until connected.
  // Initialized as false (not client.isConnected()) so that on remount
  // (rotation / split view) the false→true transition always fires and
  // triggers the data-loading effects even when the socket is already up.
  const [connected, setConnected] = useState(false)

  // Track WebSocket connection state so data loading waits until connected.
  // This mirrors the pattern used by ConversationsWindow.
  useEffect(() => {
    const handleConnected = () => setConnected(true)
    const handleDisconnected = () => setConnected(false)
    client.on("connected", handleConnected)
    client.on("disconnected", handleDisconnected)
    // Sync current state in case the client connected before this effect ran
    setConnected(client.isConnected())
    return () => {
      client.off("connected", handleConnected)
      client.off("disconnected", handleDisconnected)
    }
  }, [client])

  // Local UI state
  const [showProjectPicker, setShowProjectPicker] = useState(false)
  // Autoplay side panel + the board's more-actions menu (prototype: ⋮ →
  // Project settings · Open Autoplay · Copy project ID · Delete project).
  const [showAutoplay, setShowAutoplay] = useState(false)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [moreAnchor, setMoreAnchor] = useState<{ x: number; y: number; h: number } | null>(null)
  const [armDelete, setArmDelete] = useState(false)
  const moreBtnRef = useRef<View>(null)
  const [projectPickerAnchor, setProjectPickerAnchor] = useState<{
    x: number
    y: number
    width: number
    height: number
  } | null>(null)
  const projectSelectorRef = useRef<View>(null)
  const [showCreateProject, setShowCreateProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState("")
  const [newTaskTitle, setNewTaskTitle] = useState("")
  const [addingToColumn, setAddingToColumn] = useState<string | null>(null)
  const [showTaskDetail, setShowTaskDetail] = useState(false)
  const boardRootRef = useRef<HTMLElement | null>(null)

  // Track the last initialProjectId we loaded projects for, so we skip redundant
  // API calls when updateWindowProps writes currentProjectId back into props.
  const lastLoadedProjectIdRef = useRef<string | null | undefined>(null)

  // Project-switch race guard: monotonically increasing sequence number, stamped
  // on every loadProjects() call. When a call resolves it compares its own seq
  // against the current one; if a newer call was started in the meantime, the
  // (now stale) result is discarded instead of applied — otherwise the last
  // response to arrive wins and the board ping-pongs back to the old project.
  const loadSeqRef = useRef(0)

  // Descriptor of the newest in-flight loadProjects() call (null once settled).
  // Lets the props-sync effect tell "the user just navigated to a project we are
  // still loading" apart from "local state is authoritative".
  const inFlightLoadRef = useRef<{ seq: number; targetProjectId: string | null } | null>(null)

  // Track whether the initial loadProjects() has completed. Until it has, the
  // board store's currentProjectId is null (fresh store after remount), and we
  // must NOT overwrite the projectId in window props with undefined — that would
  // erase the projectId saved before the tab switch, causing the board to show
  // the project picker instead of restoring the project the user was viewing.
  const hasInitialLoadCompletedRef = useRef(false)

  // Click-outside detection for the task detail panel (web only).
  // Closes the panel when clicking outside of it AND outside of task cards.
  // Clicks on task cards are handled by their own onPress (selects that task).
  useEffect(() => {
    if (!showTaskDetail || Platform.OS !== "web") return

    const root = boardRootRef.current
    if (!root) return

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      // If the click is inside the detail panel (or the autoplay panel), do nothing
      if (
        target.closest(
          '[data-testid="task-detail-panel"], [data-task-detail-panel], [data-testid="autoplay-panel"]',
        )
      )
        return
      // If the click is on a task card, do nothing — the card's onPress handles it
      if (target.closest("[data-task-card]")) return
      // Otherwise, close the panel
      setShowTaskDetail(false)
      setSelectedTask(null)
    }

    root.addEventListener("mousedown", handleClickOutside)
    return () => root.removeEventListener("mousedown", handleClickOutside)
  }, [showTaskDetail])

  // Agent name/avatar cache
  const [agentMap, setAgentMap] = useState<Record<string, AgentMapEntry>>({})
  const [globalAgentMap, setGlobalAgentMap] = useState<Record<string, AgentMapEntry>>({})
  // Tag filters state
  const [activeTagFilters, setActiveTagFilters] = useState<Set<string>>(new Set())
  const [showTagFilterDropdown, setShowTagFilterDropdown] = useState(false)
  const [tagSearchQuery, setTagSearchQuery] = useState("")
  const tagSearchInputRef = useRef<any>(null)

  // Search state
  const [searchQuery, setSearchQuery] = useState("")

  // View mode: 'kanban' (default) or 'status' (project status dashboard)
  const [viewMode, setViewMode] = useState<BoardViewMode>(
    (initialView as BoardViewMode) || "mission",
  )

  // Sync viewMode when the initialView prop changes (e.g. navigating to a different
  // view URL while the board window is already open — the launcher focuses the
  // existing window, so we need to pick up the new view from props).
  useEffect(() => {
    if (initialView && BOARD_VIEW_MODES.includes(initialView as BoardViewMode)) {
      setViewMode(initialView as BoardViewMode)
    }
  }, [initialView])

  // Dependency highlight: taskId being hovered triggers highlight on its dependents
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null)

  // Autoplay v2: agent relationships (slots, playEnabled, activeSlots)
  const [agentRelationships, setAgentRelationships] = useState<AgentRelationshipState[]>([])
  // Autoplay v2: all board-capable agents in the workspace (for "+ Add runner" dropdown)
  const [availableAgents, setAvailableAgents] = useState<BoardAgentInfo[]>([])

  // Computed: unique tags from all tasks
  const allTags = useMemo(() => {
    const tagSet = new Set<string>()
    for (const task of tasks) {
      for (const tag of normalizeTags(task.tags)) {
        tagSet.add(tag)
      }
    }
    return Array.from(tagSet).sort()
  }, [tasks])

  // Computed: tags filtered by the search query inside the dropdown
  const visibleTagsInDropdown = useMemo(() => {
    if (!tagSearchQuery.trim()) return allTags
    const q = tagSearchQuery.trim().toLowerCase()
    return allTags.filter((tag) => tag.toLowerCase().includes(q))
  }, [allTags, tagSearchQuery])

  // Computed: filtered tasks based on active tag filters AND search query
  const filteredTasks = useMemo(() => {
    let result = tasks

    // Apply tag filters
    if (activeTagFilters.size > 0) {
      result = result.filter((task) => {
        const tagArr = normalizeTags(task.tags)
        if (tagArr.length === 0) return false
        // Show task if it has at least one of the active tags
        return tagArr.some((tag) => activeTagFilters.has(tag))
      })
    }

    // Apply search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      result = result.filter((task) => {
        // Search in title
        if (task.title.toLowerCase().includes(query)) return true
        // Search in description
        if (task.description && task.description.toLowerCase().includes(query)) return true
        // Search in instructions
        if (task.instructions && task.instructions.toLowerCase().includes(query)) return true
        // Search in tags
        if (normalizeTags(task.tags).some((tag) => tag.toLowerCase().includes(query))) return true
        return false
      })
    }

    return result
  }, [tasks, activeTagFilters, searchQuery])

  // Computed: total tasks by column (unfiltered)
  const totalTasksByColumn = useMemo(() => {
    if (!board) return new Map<string, number>()
    const map = new Map<string, number>()
    for (const column of board.columns) {
      const count = tasks.filter((t) => t.columnId === column.columnId).length
      map.set(column.columnId, count)
    }
    return map
  }, [tasks, board])

  const tasksByColumn = useMemo(() => {
    if (!board) return new Map<string, Task[]>()
    return getTasksByColumn(filteredTasks, board.columns)
  }, [filteredTasks, board])

  const selectedTask = useMemo(
    () => tasks.find((t) => t.taskId === selectedTaskId) || null,
    [tasks, selectedTaskId],
  )

  // Computed: dependency highlights for the currently hovered task
  const dependencyHighlights = useMemo(
    () =>
      hoveredTaskId
        ? computeDependencyHighlights(hoveredTaskId, tasks)
        : new Map<string, DependencyHighlight>(),
    [hoveredTaskId, tasks],
  )

  const toggleTagFilter = useCallback((tag: string) => {
    setActiveTagFilters((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(tag)) {
        newSet.delete(tag)
      } else {
        newSet.add(tag)
      }
      return newSet
    })
  }, [])

  // Auto-focus tag search input when dropdown opens; reset search when it closes
  useEffect(() => {
    if (showTagFilterDropdown) {
      setTagSearchQuery("")
      // Small delay to ensure the input is rendered before focusing
      setTimeout(() => {
        tagSearchInputRef.current?.focus()
      }, 50)
    }
  }, [showTagFilterDropdown])

  const currentProject = useMemo(
    () => projects.find((p) => p.projectId === currentProjectId) || null,
    [projects, currentProjectId],
  )

  // "N ABIERTAS" — tasks outside the Done column; and where "+ TAREA" adds.
  const playingRunners = useMemo(
    () => agentRelationships.filter((r) => r.playEnabled).length,
    [agentRelationships],
  )
  const openCount = useMemo(() => {
    const doneId = board?.columns.find((col) => col.slug === "done")?.columnId
    return doneId ? tasks.filter((task) => task.columnId !== doneId).length : tasks.length
  }, [board, tasks])
  const firstAddColumnId = useMemo(() => {
    const cols = board?.columns ?? []
    return (cols.find((col) => col.slug === "todo") ?? cols[0])?.columnId ?? null
  }, [board])

  // ========================================================================
  // DATA LOADING
  // ========================================================================

  // Load workspace agents filtered by MCA access (board-runner / board-manager).
  const loadFilteredAgents = useCallback(
    async (wsId: string) => {
      try {
        const { agents } = await client.agent.listAgents(wsId)

        // Fetch app access for all agents in parallel
        const appsResults = await Promise.all(
          agents.map((a) =>
            // Pass wsId so superagents (workspaceId=null) can resolve their
            // workspace-scoped board apps. Without it, the backend throws
            // "No workspaceId available" and the catch swallows it silently.
            client.getAgentApps(a.agentId, wsId).catch(() => [] as Array<{ mcaId: string }>),
          ),
        )

        const workerMap: Record<string, AgentMapEntry> = {}
        const supervisorMap: Record<string, AgentMapEntry> = {}

        agents.forEach((agent, i) => {
          const apps = appsResults[i]
          const mcaIds = apps.map((app: any) => app.mcaId)
          if (mcaIds.includes("mca.teros.board-runner")) {
            workerMap[agent.agentId] = {
              name: agent.name,
              avatarUrl: agent.avatarUrl,
              type: "agent" as const,
            }
          }
          if (mcaIds.includes("mca.teros.board-manager")) {
            supervisorMap[agent.agentId] = {
              name: agent.name,
              avatarUrl: agent.avatarUrl,
              type: "agent" as const,
            }
          }
        })

        // Merge all human workspace members into workerMap so they appear in Team view
        // and can be assigned tasks. type: 'human' enables the teal-border avatar distinction.
        // MUW: Previously only the current user was added. Now we fetch all active human members.
        try {
          const { humans } = await client.workspace.listHumans(wsId)
          for (const human of humans) {
            // Only include active members (pending members have no userId and are excluded server-side)
            if (human.status === "active") {
              workerMap[human.userId] = {
                name: human.displayName,
                avatarUrl: human.avatarUrl,
                type: "human" as const,
                role: human.role,
              }
            }
          }
        } catch (err) {
          // Fallback: if workspace.list-humans fails, add current user as before
          if (userId) {
            workerMap[userId] = {
              name: userName || "You",
              avatarUrl: userAvatarUrl,
              type: "human" as const,
            }
          }
        }
        setAgentMap(workerMap)
        setGlobalAgentMap(supervisorMap)

        // Load board-capable agents (workspace + superagents) for the "+ Add runner" dropdown
        try {
          const { agents: boardAgents } = await client.board.listBoardAgents(wsId)
          setAvailableAgents(boardAgents)
        } catch (err) {
          console.error("Error loading board agents:", err)
        }
      } catch (err) {
        console.error("Error loading agents:", err)
      }
    },
    [client],
  )

  // Load projects (and select the initial one) + agents when workspaceId is available
  // AND the WebSocket is connected. Without the connected guard, a board window whose
  // projectId comes from restored storage (e.g. on page reload) would call
  // sendFrameworkRequest before the WebSocket handshake completes, causing a
  // "Not connected to server" error.
  useEffect(() => {
    if (!workspaceId || !connected) return
    // Skip if we've already loaded projects for this exact initialProjectId.
    // This prevents redundant API calls when updateWindowProps writes
    // currentProjectId back into the window props (URL sync / tab title).
    if (
      lastLoadedProjectIdRef.current !== null &&
      lastLoadedProjectIdRef.current === initialProjectId
    )
      return
    lastLoadedProjectIdRef.current = initialProjectId
    loadProjects(initialProjectId ?? null)
    loadFilteredAgents(workspaceId)
  }, [workspaceId, connected, initialProjectId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load board when the selected project changes (also gated on connection).
  useEffect(() => {
    if (!currentProjectId) {
      setBoard(null)
      setTasks([])
      return
    }
    if (!connected) return
    loadBoard(currentProjectId)
  }, [currentProjectId, connected])

  // Destroy this window's board store on unmount to free memory
  useEffect(() => {
    return () => {
      destroyBoardStore(windowId)
    }
  }, [windowId])

  // Sync workspaceId + projectId + projectName into window props so:
  // 1. The tilingStore persists the exact project/view across reloads (single writer)
  // 2. The tab title shows the project name instead of "Board"
  //
  // IMPORTANT: Before the initial loadProjects() completes, currentProjectId is
  // null (fresh store after remount on mobile tab switch). We must NOT overwrite
  // projectId with undefined in that window — it would erase the projectId the
  // user had before switching tabs, and the board would show the project picker
  // instead of restoring the project. Until the initial load finishes, preserve
  // initialProjectId in the window props.
  useEffect(() => {
    if (!workspaceId && !currentProjectId) return

    const currentProps = useTilingStore.getState().windows[windowId]?.props ?? {}

    // Project-switch race guard: the window props point at a project we are still
    // loading (initialProjectId ≠ currentProjectId while a load for
    // initialProjectId is in flight). In this render pass the local state is
    // stale, so writing projectId/projectName/view back would revert the
    // navigation the user just made and re-trigger a load for the OLD project —
    // exactly the mission↔kanban redirect loop. Keep only workspaceId in sync;
    // the project fields are written once the load settles.
    const normalizedInitialProjectId = initialProjectId ?? null
    const inFlightLoad = inFlightLoadRef.current
    const isProjectTransition =
      normalizedInitialProjectId !== (currentProjectId ?? null) &&
      inFlightLoad !== null &&
      inFlightLoad.targetProjectId === normalizedInitialProjectId

    if (isProjectTransition) {
      if ((currentProps.workspaceId ?? undefined) !== (workspaceId || undefined)) {
        updateWindowProps(windowId, { workspaceId: workspaceId || undefined })
      }
      return
    }

    const effectiveProjectId = hasInitialLoadCompletedRef.current
      ? currentProjectId || undefined
      : currentProjectId || initialProjectId || undefined

    // Skip if the effective props haven't changed — writing the same values
    // re-triggers the props-sync effect (and the tab title re-render) for no
    // reason; keeping writes minimal avoids feedback with loadProjects.
    if (
      (currentProps.workspaceId ?? undefined) === (workspaceId || undefined) &&
      (currentProps.projectId ?? undefined) === (effectiveProjectId ?? undefined) &&
      (currentProps.projectName ?? undefined) === (currentProject?.name ?? undefined) &&
      currentProps.view === viewMode
    ) {
      return
    }

    updateWindowProps(windowId, {
      workspaceId: workspaceId || undefined,
      projectId: effectiveProjectId,
      projectName: currentProject?.name || undefined,
      view: viewMode,
    })
  }, [windowId, workspaceId, currentProjectId, currentProject?.name, viewMode, initialProjectId])

  // ========================================================================
  // REAL-TIME BOARD SUBSCRIPTION
  // ========================================================================

  useEffect(() => {
    if (!board) return

    const boardId = board.boardId

    // Subscribe to board events
    client.board.subscribeBoard(boardId).catch((err) => {
      console.warn("[BoardWindowContent] subscribeBoard error:", err)
    })

    const onTaskCreated = (msg: any) => {
      const eventBoardId = msg.boardId || msg.task?.boardId
      if (eventBoardId && eventBoardId !== boardId) return
      if (msg.task) addTask(msg.task)
    }
    const onBatchCreated = (msg: any) => {
      const eventBoardId = msg.boardId || msg.tasks?.[0]?.boardId
      if (eventBoardId && eventBoardId !== boardId) return
      if (msg.tasks) addTasks(msg.tasks)
    }
    const onTaskUpdated = (msg: any) => {
      const eventBoardId = msg.boardId || msg.task?.boardId
      if (eventBoardId && eventBoardId !== boardId) return
      if (msg.task) updateTaskInStore(msg.task)
    }
    const onTaskDeleted = (msg: any) => {
      if (msg.boardId && msg.boardId !== boardId) return
      if (msg.taskId) removeTask(msg.taskId)
    }
    const onAgentConfigUpdated = (msg: any) => {
      if (msg.boardId && msg.boardId !== boardId) return
      if (!msg.agentId) return
      setAgentRelationships((prev) => {
        const exists = prev.some((r) => r.agentId === msg.agentId)
        if (exists) {
          return prev.map((r) =>
            r.agentId === msg.agentId
              ? {
                  ...r,
                  slots: msg.slots ?? r.slots,
                  playEnabled: msg.playEnabled ?? r.playEnabled,
                  activeSlots: msg.activeSlots ?? r.activeSlots,
                }
              : r,
          )
        }
        // New agent relationship received — add it
        return [
          ...prev,
          {
            agentId: msg.agentId,
            agentName: msg.agentId,
            slots: msg.slots ?? 0,
            playEnabled: msg.playEnabled ?? false,
            activeSlots: msg.activeSlots ?? 0,
          },
        ]
      })
    }

    client.on("board_task_created", onTaskCreated)
    client.on("board_tasks_batch_created", onBatchCreated)
    client.on("board_task_updated", onTaskUpdated)
    client.on("board_task_deleted", onTaskDeleted)
    client.on("board_agent_config_updated", onAgentConfigUpdated)

    return () => {
      client.board.unsubscribeBoard(boardId).catch((err) => {
        console.warn("[BoardWindowContent] unsubscribeBoard error:", err)
      })
      client.off("board_task_created", onTaskCreated)
      client.off("board_tasks_batch_created", onBatchCreated)
      client.off("board_task_updated", onTaskUpdated)
      client.off("board_task_deleted", onTaskDeleted)
      client.off("board_agent_config_updated", onAgentConfigUpdated)
    }
  }, [board?.boardId])

  // ========================================================================
  // DATA FETCHING
  // ========================================================================

  const loadProjects = async (targetProjectId: string | null = null) => {
    // Stamp this call with a fresh sequence number. Any response belonging to an
    // older sequence is a zombie (the user already navigated elsewhere) and is
    // discarded below instead of being applied.
    const seq = ++loadSeqRef.current
    inFlightLoadRef.current = { seq, targetProjectId: targetProjectId ?? null }
    setLoadingProjects(true)
    try {
      const result = await client.board.listProjects(workspaceId)

      // Zombie response: a newer loadProjects() superseded this one while it was
      // in flight (e.g. switching A→B→C quickly). Applying it would resurrect an
      // obsolete project selection and ping-pong the board, so bail out before
      // touching the store or the window props.
      if (seq !== loadSeqRef.current) return

      setProjects((result.projects || []) as any)
      // Auto-select the target project if one was provided (from URL/props).
      // This handles both initial load AND switching projects when the user
      // clicks a different project in the sidebar (replaceWindow updates the
      // initialProjectId prop, which re-triggers the loading effect above).
      if (targetProjectId && result.projects?.length > 0) {
        const restoredProject = result.projects.find((p: any) => p.projectId === targetProjectId)
        if (restoredProject) {
          // Read the LIVE store state, never the closure: during a project switch
          // the closed-over currentProjectId still holds the previous project, so
          // comparing against it would set the selection redundantly.
          const liveCurrentProjectId = getBoardStore(windowId).getState().currentProjectId
          if (liveCurrentProjectId !== restoredProject.projectId) {
            setCurrentProject(restoredProject.projectId)
          }
        } else {
          // The projectId from the persisted layout no longer exists (deleted,
          // different workspace, etc.). Clear the stale prop so the component
          // falls through to the project picker instead of silently keeping
          // a dead projectId in window props.
          updateWindowProps(windowId, { projectId: undefined, projectName: undefined })
        }
      } else if (targetProjectId && !result.projects?.length) {
        // No projects at all — clear the stale projectId prop.
        updateWindowProps(windowId, { projectId: undefined, projectName: undefined })
      }
    } catch (err: any) {
      // Ignore errors from superseded loads: they no longer describe what the
      // user is looking at, and the newer load owns the loading flag.
      if (seq !== loadSeqRef.current) return
      toast.error(`Error: ${err.message}`)
    } finally {
      // Only the newest load owns the shared loading flag and the settled marker.
      if (seq === loadSeqRef.current) {
        setLoadingProjects(false)
        inFlightLoadRef.current = null
        // Mark the initial load as complete so updateWindowProps can safely
        // use currentProjectId (which may now be set from the restored project).
        // Before this point, currentProjectId was null and we preserved
        // initialProjectId in window props to avoid erasing it on remount.
        hasInitialLoadCompletedRef.current = true
      }
    }
  }

  const loadBoard = async (projectId: string) => {
    setLoadingBoard(true)
    try {
      const result = (await client.board.getBoard(projectId)) as any
      setBoard(result.board as any)
      setTasks((result.tasks || []) as any)

      // Fetch activity feed from board_events collection (indexed, O(1) query)
      // instead of iterating all tasks' activity arrays (O(n) scan)
      try {
        const feedResult = await client.board.getBoardFeed(result.board.boardId, { limit: 50 })
        setBoardFeed(feedResult.events || [])
      } catch (feedErr) {
        // Non-fatal: feed will fall back to task.activity iteration
        console.warn("[BoardWindow] Failed to load board feed:", feedErr)
        setBoardFeed(null)
      }

      // Populate agentRelationships from board.get response (autoplay v2)
      if (Array.isArray(result.agentRelationships)) {
        const rels: AgentRelationshipState[] = result.agentRelationships.map((rel: any) => {
          const agentInfo = globalAgentMap[rel.agentId] || agentMap[rel.agentId]
          return {
            agentId: rel.agentId,
            // prefer local map name (already resolved), fall back to what backend sent
            agentName: agentInfo?.name || rel.agentName || rel.agentId,
            // prefer local map avatar, fall back to avatarUrl from backend (covers superagents
            // and agents that don't appear in any task and thus aren't in the local map)
            avatarUrl: agentInfo?.avatarUrl ?? rel.avatarUrl,
            slots: rel.slots ?? 0,
            playEnabled: rel.playEnabled ?? false,
            activeSlots: rel.activeSlots ?? 0,
          }
        })
        setAgentRelationships(rels)
      }
    } catch (err: any) {
      toast.error(`Error: ${err.message}`)
    } finally {
      setLoadingBoard(false)
    }
  }

  // ========================================================================
  // ACTIONS
  // ========================================================================

  /**
   * Opens the task detail panel and hydrates the task's heavy fields.
   *
   * Board list payloads (board.get) strip instructions / progressNotes /
   * activity / input / output (TASK_LIST_PROJECTION — the large-board
   * timeout fix), so the light list doc alone can't paint the detail panel.
   * This fetches the full doc via board.get-task and merges the missing
   * fields into the store (hydrateTask only fills gaps — live updates from
   * board broadcasts, which carry full docs, are never clobbered).
   * Non-fatal: on failure the panel still opens with the light doc.
   */
  const openTaskDetail = useCallback(
    async (taskId: string) => {
      setSelectedTask(taskId)
      setShowTaskDetail(true)
      try {
        const result = await client.board.getTask(taskId)
        if (result?.task) hydrateTask(result.task as any)
      } catch (err) {
        console.warn("[BoardWindowContent] task detail hydration failed:", err)
      }
    },
    [client, hydrateTask, setSelectedTask],
  )

  const handleDeleteProject = useCallback(async () => {
    if (!currentProjectId) return
    try {
      await client.board.deleteProject(currentProjectId)
      setProjects(projects.filter((p) => p.projectId !== currentProjectId))
      setCurrentProject(null)
      setShowMoreMenu(false)
      setArmDelete(false)
      toast.success(t("board.projectDeleted", { defaultValue: "Project deleted" }))
    } catch (err: any) {
      toast.error(`Error: ${err.message}`)
    }
  }, [client, currentProjectId, projects, setProjects, setCurrentProject, toast, t])

  const handleCreateProject = async () => {
    if (!newProjectName.trim() || !workspaceId) return
    try {
      const result = await client.board.createProject(workspaceId, newProjectName.trim())
      addProject(result.project as any)
      setCurrentProject(result.project.projectId)
      setNewProjectName("")
      setShowCreateProject(false)
      toast.success(t("board.projectCreated"))
    } catch (err: any) {
      toast.error(`Error: ${err.message}`)
    }
  }

  const handleCreateTask = async (columnId: string) => {
    if (!newTaskTitle.trim() || !currentProjectId) return
    setCreatingTask(true)
    try {
      const result = await client.board.createTask(currentProjectId, {
        title: newTaskTitle.trim(),
        // The backend requires instructions; the quick-add only has a title.
        instructions: newTaskTitle.trim(),
        columnId,
      })
      addTask(result.task as any)
      setNewTaskTitle("")
      setAddingToColumn(null)
    } catch (err: any) {
      toast.error(`Error: ${err.message}`)
    } finally {
      setCreatingTask(false)
    }
  }

  const handleMoveTask = async (taskId: string, targetColumnId: string, dropIndex?: number) => {
    try {
      // Optimistic local reorder: move task in local state immediately
      if (dropIndex !== undefined) {
        const task = tasks.find((t) => t.taskId === taskId)
        if (task) {
          const sourceCol = task.columnId
          const sameColumn = sourceCol === targetColumnId

          // Get tasks in the target column (sorted), excluding the moved task
          const targetTasks = tasks
            .filter((t) => t.columnId === targetColumnId && t.taskId !== taskId)
            .sort((a, b) => a.position - b.position)

          // Calculate insert index for the filtered list
          let insertAt = dropIndex
          if (sameColumn && task.position < dropIndex) {
            insertAt = dropIndex - 1
          }
          insertAt = Math.max(0, Math.min(insertAt, targetTasks.length))

          // Insert the task at the right position
          targetTasks.splice(insertAt, 0, task)

          // Rebuild positions for target column
          const updatedTargetTasks = targetTasks.map((t, i) => ({
            ...t,
            columnId: targetColumnId,
            position: i,
          }))

          // If cross-column, also reindex source column
          let updatedSourceTasks: Task[] = []
          if (!sameColumn) {
            updatedSourceTasks = tasks
              .filter((t) => t.columnId === sourceCol && t.taskId !== taskId)
              .sort((a, b) => a.position - b.position)
              .map((t, i) => ({ ...t, position: i }))
          }

          // Merge everything
          const affectedIds = new Set(
            [...updatedTargetTasks, ...updatedSourceTasks].map((t) => t.taskId),
          )
          const newTasks = tasks
            .filter((t) => !affectedIds.has(t.taskId))
            .concat(updatedTargetTasks, updatedSourceTasks)

          setTasks(newTasks)
        }
      }

      const result = await client.board.moveTask(taskId, targetColumnId, dropIndex)
      updateTaskInStore(result.task as any)
    } catch (err: any) {
      toast.error(`Error: ${err.message}`)
    }
  }

  const handleDeleteTask = async (taskId: string) => {
    try {
      await client.board.deleteTask(taskId)
      removeTask(taskId)
      if (selectedTaskId === taskId) {
        setSelectedTask(null)
        setShowTaskDetail(false)
      }
      toast.success(t("board.taskDeleted"))
    } catch (err: any) {
      toast.error(`Error: ${err.message}`)
    }
  }

  const handleOpenConversation = (channelId: string) => {
    // Preview routing (preview-tabs.md): a plain click reuses the desktop's
    // preview tab; only ctrl/cmd-click opens a separate tab.
    openWindow("chat", { channelId }, false, windowId)
  }

  const handleAssignTask = async (taskId: string, agentId: string | null) => {
    try {
      const result = await client.board.assignTask(taskId, agentId)
      updateTaskInStore(result.task as any)
    } catch (err: any) {
      toast.error(`Error: ${err.message}`)
    }
  }

  const handleStartTask = async (taskId: string, agentId?: string) => {
    try {
      const result = await client.board.startTask(taskId, agentId)
      updateTaskInStore(result.task as any)
      toast.success(t("board.taskStarted"))
    } catch (err: any) {
      toast.error(`Error: ${err.message}`)
    }
  }

  const handleStopTask = async (taskId: string) => {
    try {
      const result = await client.board.stopTask(taskId)
      updateTaskInStore(result.task as any)
      toast.success(t("board.stopRequested"))
    } catch (err: any) {
      toast.error(`Error: ${err.message}`)
    }
  }

  // Complete task: move to Done column
  const handleCompleteTask = async (taskId: string, outputData?: unknown) => {
    if (!board) return
    const doneCol = board.columns.find((c) => c.slug === "done")
    if (!doneCol) {
      toast.error("Done column not found")
      return
    }
    try {
      const result = await client.board.moveTask(taskId, doneCol.columnId, undefined, outputData)
      updateTaskInStore(result.task as any)
      toast.success("Task completed")
    } catch (err: any) {
      toast.error(`Error: ${err.message}`)
    }
  }

  // Save output data without completing the task (separates fill output from complete task)
  const handleSaveOutput = async (
    taskId: string,
    outputData: unknown,
    mode: "replace" | "append",
  ) => {
    try {
      const result = await client.board.saveTaskOutput(taskId, outputData, mode)
      updateTaskInStore(result.task as any)
    } catch (err: any) {
      toast.error(`Error saving output: ${err.message}`)
      throw err // re-throw so the panel can set error status
    }
  }

  // Archive task (soft-delete). If reason is provided, add a progress note first.
  const handleArchiveTask = async (taskId: string, reason?: string) => {
    try {
      if (reason && reason.trim()) {
        await client.board.addProgressNote(taskId, `Cancelada: ${reason.trim()}`)
      }
      const result = await client.board.archiveTask(taskId, true)
      updateTaskInStore(result.task as any)
      if (selectedTaskId === taskId) {
        setSelectedTask(null)
        setShowTaskDetail(false)
      }
      toast.success("Task archived")
    } catch (err: any) {
      toast.error(`Error: ${err.message}`)
    }
  }

  const handleSetSlots = async (agentId: string, slots: number) => {
    if (!currentProjectId) return
    // Optimistic update
    setAgentRelationships((prev) => prev.map((r) => (r.agentId === agentId ? { ...r, slots } : r)))
    try {
      await client.board.setAgentSlots(currentProjectId, agentId, slots)
    } catch (err: any) {
      toast.error(`Error: ${err.message}`)
      // Revert on error by reloading
      loadBoard(currentProjectId)
    }
  }

  const handleSetPlay = async (agentId: string, enabled: boolean) => {
    if (!currentProjectId) return
    // Optimistic update
    setAgentRelationships((prev) =>
      prev.map((r) => (r.agentId === agentId ? { ...r, playEnabled: enabled } : r)),
    )
    try {
      await client.board.setAgentPlay(currentProjectId, agentId, enabled)
    } catch (err: any) {
      toast.error(`Error: ${err.message}`)
      // Revert on error by reloading
      loadBoard(currentProjectId)
    }
  }

  const handleRemoveRunner = async (agentId: string) => {
    if (!currentProjectId) return
    // Optimistic: remove from panel immediately
    setAgentRelationships((prev) => prev.filter((r) => r.agentId !== agentId))
    try {
      await client.board.removeAgent(currentProjectId, agentId)
    } catch (err: any) {
      toast.error(`Error: ${err.message}`)
      // Revert on error
      loadBoard(currentProjectId)
    }
  }

  const handleAddRunner = async (agentId: string) => {
    if (!currentProjectId) return
    // Find agent info from availableAgents for optimistic update
    const agentInfo = availableAgents.find((a) => a.agentId === agentId)
    if (!agentInfo) return
    // Optimistic: add to panel with slots:0, playEnabled:false
    setAgentRelationships((prev) => [
      ...prev,
      {
        agentId,
        agentName: agentInfo.name,
        avatarUrl: agentInfo.avatarUrl,
        slots: 0,
        playEnabled: false,
        activeSlots: 0,
      },
    ])
    try {
      // setAgentSlots with slots:0 creates the relationship in backend
      await client.board.setAgentSlots(currentProjectId, agentId, 0)
    } catch (err: any) {
      toast.error(`Error: ${err.message}`)
      // Revert on error
      setAgentRelationships((prev) => prev.filter((r) => r.agentId !== agentId))
    }
  }

  // ========================================================================
  // RENDER: CONTENT BELOW HEADER (computed)
  // ========================================================================

  const renderBoardContent = () => {
    // No workspace selected
    if (!workspaceId) {
      return (
        <View style={{ flex: 1, justifyContent: "center" }}>
          <EmptyState
            icon="kanban"
            title={t("board.selectWorkspace")}
            text={t("board.selectWorkspaceHint")}
          />
        </View>
      )
    }

    // Loading projects
    if (isLoadingProjects && projects.length === 0) {
      return (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10 }}>
          <AppSpinner size="lg" variant="board" />
          <T step="sm" tone="text2">
            {t("board.loadingProjects")}
          </T>
        </View>
      )
    }

    // No projects
    if (projects.length === 0 && !isLoadingProjects && workspaceId) {
      return (
        <View style={{ flex: 1, justifyContent: "center" }}>
          <EmptyState
            icon="folder"
            title={t("board.noProjects")}
            text={t("board.noProjectsHint")}
            action={
              !showCreateProject ? (
                <Btn
                  variant="primary"
                  icon="plus"
                  onPress={() => setShowCreateProject(true)}
                  testID="board-create-project"
                >
                  {t("board.createProject")}
                </Btn>
              ) : (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Field
                    value={newProjectName}
                    onChangeText={setNewProjectName}
                    placeholder={t("board.projectNamePlaceholder")}
                    autoFocus
                    onSubmitEditing={handleCreateProject}
                    containerStyle={{ width: 240 }}
                    testID="board-new-project-input"
                  />
                  <Btn variant="primary" onPress={handleCreateProject}>
                    {t("board.createTask")}
                  </Btn>
                  <IconBtn
                    icon="x"
                    plain
                    onPress={() => {
                      setShowCreateProject(false)
                      setNewProjectName("")
                    }}
                  />
                </View>
              )
            }
          />
        </View>
      )
    }

    // Loading board
    if (isLoadingBoard) {
      return (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <AppSpinner size="lg" variant="board" />
        </View>
      )
    }

    // Board loaded
    if (board) {
      // ── Mission view ────────────────────────────────────────────────────
      if (viewMode === "mission") {
        return (
          <MissionControl
            project={currentProject}
            board={board}
            tasks={tasks}
            boardFeed={boardFeed}
            agentRelationships={agentRelationships}
            agentMap={agentMap}
            globalAgentMap={globalAgentMap}
            onOpenConversation={handleOpenConversation}
            onOpenTask={(taskId) => {
              void openTaskDetail(taskId)
            }}
            userAvatarUrl={userAvatarUrl}
          />
        )
      }

      // ── Settings view ───────────────────────────────────────────────────
      if (viewMode === "settings") {
        return <ProjectSettingsView project={currentProject} board={board} />
      }

      const blockedCol = board.columns.find((col) => col.slug === "blocked")
      const blockedTasks = blockedCol
        ? tasks.filter((task) => task.columnId === blockedCol.columnId)
        : []
      const hasFilters = activeTagFilters.size > 0 || !!searchQuery

      // Filters strip (tags + search) shared by kanban and list
      const filtersRow = (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {allTags.length > 0 && (
            <ChipBtn
              icon="funnel"
              on={activeTagFilters.size > 0 || showTagFilterDropdown}
              count={activeTagFilters.size > 0 ? activeTagFilters.size : undefined}
              onPress={() => setShowTagFilterDropdown(!showTagFilterDropdown)}
              testID="board-tag-filter"
            >
              {t("board.tags")}
            </ChipBtn>
          )}
          <Field
            icon="magnifying-glass"
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder={t("board.searchPlaceholder")}
            containerStyle={{ width: 190, height: 28, borderRadius: 100, paddingHorizontal: 12 }}
            style={{ height: 26, fontSize: 12 }}
            testID="board-search-input"
            right={
              searchQuery ? (
                <IconBtn
                  icon="x"
                  sm
                  plain
                  onPress={() => setSearchQuery("")}
                  style={{ marginRight: -8 }}
                />
              ) : undefined
            }
          />
          {hasFilters && (
            <IconBtn
              icon="x"
              sm
              plain
              danger
              title={t("common.clear", { defaultValue: "Clear" })}
              onPress={() => {
                setActiveTagFilters(new Set())
                setSearchQuery("")
              }}
            />
          )}
        </View>
      )

      const blockedNote =
        blockedTasks.length > 0 ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingHorizontal: 24,
              paddingBottom: 10,
            }}
          >
            <Ph name="warning" size={13} color={c.tint.r.tx} />
            <T step="12" color={c.tint.r.tx}>
              {t("board.blockedTaskCount", { count: blockedTasks.length })}
            </T>
          </View>
        ) : null

      // ── List view ───────────────────────────────────────────────────────
      if (viewMode === "list") {
        const columnIndex = new Map(board.columns.map((col, i) => [col.columnId, i]))
        const rows = [...filteredTasks].sort((a, b) => {
          const ca = columnIndex.get(a.columnId) ?? 0
          const cb = columnIndex.get(b.columnId) ?? 0
          return ca - cb || a.position - b.position
        })
        return (
          <View style={{ flex: 1 }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                paddingHorizontal: 24,
                paddingTop: 12,
                paddingBottom: 10,
                flexWrap: "wrap",
              }}
            >
              <T step="12" tone="text3" style={{ flex: 1, minWidth: 200 }}>
                {t("board.listHint", {
                  defaultValue:
                    "Every task in the project, ordered by column. Click a row to open its detail.",
                })}
              </T>
              {filtersRow}
            </View>
            {blockedNote}
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 32 }}
              showsVerticalScrollIndicator={false}
            >
              <LGroup>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 14,
                    paddingVertical: 10,
                    paddingHorizontal: 16,
                  }}
                >
                  <View style={{ width: 18 }} />
                  <T step="codenote" tone="text3" style={{ flex: 1 }}>
                    {t("board.listColTask", { defaultValue: "Task" })}
                  </T>
                  <T step="codenote" tone="text3" style={{ width: 120 }}>
                    {t("board.status")}
                  </T>
                  <T step="codenote" tone="text3" style={{ width: 140 }}>
                    {t("board.listColAssignee", { defaultValue: "Assignee" })}
                  </T>
                  <T step="codenote" tone="text3" style={{ width: 90 }}>
                    {t("board.priority")}
                  </T>
                  <T step="codenote" tone="text3" style={{ width: 64, textAlign: "right" }}>
                    {t("board.statusCreated")}
                  </T>
                </View>
                {rows.length === 0 ? (
                  <View style={{ padding: 24, alignItems: "center" }}>
                    <T step="sm" tone="text3">
                      {t("board.statusNoTasks")}
                    </T>
                  </View>
                ) : (
                  rows.map((task) => {
                    const col = board.columns.find((x) => x.columnId === task.columnId)
                    const slug = col?.slug ?? ""
                    const assignee = task.assignedAgentId
                      ? agentMap[task.assignedAgentId]
                      : undefined
                    const assigneeName = task.assignedAgentId
                      ? assignee?.name || task.assignedAgentId.slice(0, 12)
                      : ""
                    const prio = priorityMeta(task.priority, t)
                    const selected = task.taskId === selectedTaskId
                    return (
                      <LRow
                        key={task.taskId}
                        hov
                        onPress={() => {
                          void openTaskDetail(task.taskId)
                        }}
                        style={selected ? { backgroundColor: c.navActive } : undefined}
                        testID={`board-list-row-${task.taskId}`}
                        {...(Platform.OS === "web" ? ({ "data-task-card": true } as any) : {})}
                      >
                        <View style={{ width: 18, alignItems: "center" }}>
                          <StatusMark slug={slug} running={task.running} />
                        </View>
                        <T
                          step="sm"
                          ellipsis
                          style={[
                            { flex: 1 },
                            slug === "done"
                              ? { textDecorationLine: "line-through", color: c.text3 }
                              : null,
                          ]}
                        >
                          {task.title}
                        </T>
                        <View
                          style={{ width: 120, flexDirection: "row", alignItems: "center", gap: 7 }}
                        >
                          <Dot color={getColumnColor(slug)} size={7} />
                          <T step="12" tone="text2" ellipsis style={{ flexShrink: 1 }}>
                            {col?.name ?? ""}
                          </T>
                        </View>
                        <View
                          style={{ width: 140, flexDirection: "row", alignItems: "center", gap: 7 }}
                        >
                          {task.assignedAgentId ? (
                            <>
                              <Avatar
                                name={assigneeName}
                                imageUrl={assignee?.avatarUrl}
                                size={20}
                                isAgent={assignee?.type !== "human"}
                              />
                              <T step="12" tone="text2" ellipsis style={{ flexShrink: 1 }}>
                                {assigneeName}
                              </T>
                            </>
                          ) : (
                            <T step="12" tone="text3">
                              —
                            </T>
                          )}
                        </View>
                        <View style={{ width: 90 }}>
                          <Badge tone={prio.tone} sm>
                            {prio.label}
                          </Badge>
                        </View>
                        <T step="codenote" tone="text3" style={{ width: 64, textAlign: "right" }}>
                          {timeAgo(task.createdAt)}
                        </T>
                      </LRow>
                    )
                  })
                )}
                <Pressable
                  onPress={() => {
                    setViewMode("kanban")
                    setAddingToColumn(firstAddColumnId)
                  }}
                  accessibilityRole="button"
                  style={[
                    {
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 8,
                      paddingVertical: 12,
                      paddingHorizontal: 16,
                    },
                    Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
                  ]}
                >
                  <Ph name="plus" size={14} color={c.text2} />
                  <T step="sm" tone="text2">
                    {t("board.addTask", { defaultValue: "Add task" })}
                  </T>
                </Pressable>
              </LGroup>
            </ScrollView>
          </View>
        )
      }

      // ── Kanban view (default) ──────────────────────────────────────────
      return (
        <View style={{ flex: 1 }}>
          {/* Hint line + Autoplay / filters */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              paddingHorizontal: 24,
              paddingTop: 12,
              paddingBottom: 10,
              flexWrap: "wrap",
            }}
          >
            <T step="12" tone="text3" style={{ flex: 1, minWidth: 200 }}>
              {t("board.kanbanHint", {
                defaultValue:
                  "Drag cards between columns. Agents move to Review; you move to Done.",
              })}
            </T>
            {filtersRow}
            {/* "Autoplay · n playing" — opens the Autoplay panel (prototype chip). */}
            <ChipBtn
              on={showAutoplay}
              onPress={() => setShowAutoplay((v) => !v)}
              testID="board-autoplay"
            >
              <Dot color={playingRunners > 0 ? colors.green : c.text3} size={7} />
              <T step="12" color={showAutoplay ? c.accent : c.text2}>
                {t("board.autoplay")}
              </T>
              <T step="codenote" tone="text3">
                {t("board.autoplayPlaying", {
                  count: playingRunners,
                  defaultValue: "{{count}} playing",
                })}
              </T>
            </ChipBtn>
          </View>

          {/* Blocked tasks notification — based on column position */}
          {blockedNote}

          {/* Board columns */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ flex: 1 }}
            contentContainerStyle={{
              paddingLeft: 24,
              paddingRight: 24,
              paddingTop: 6,
              paddingBottom: 32,
              alignItems: "stretch",
            }}
            {...(Platform.OS === "web" ? ({ className: "chat-scroll" } as any) : {})}
          >
            <View
              style={{ flexDirection: "row", gap: 12, alignItems: "flex-start", minHeight: "100%" }}
            >
              {board.columns.map((column) => (
                <KanbanColumn
                  key={column.columnId}
                  column={column}
                  tasks={tasksByColumn.get(column.columnId) || []}
                  allTasks={tasks}
                  totalTasksCount={totalTasksByColumn.get(column.columnId) || 0}
                  allColumns={board.columns}
                  selectedTaskId={selectedTaskId}
                  addingToColumn={addingToColumn}
                  newTaskTitle={newTaskTitle}
                  isCreatingTask={isCreatingTask}
                  onSelectTask={(taskId) => {
                    void openTaskDetail(taskId)
                  }}
                  onAddTask={() => setAddingToColumn(column.columnId)}
                  onCancelAdd={() => {
                    setAddingToColumn(null)
                    setNewTaskTitle("")
                  }}
                  onChangeNewTitle={setNewTaskTitle}
                  onSubmitNewTask={() => handleCreateTask(column.columnId)}
                  onMoveTask={handleMoveTask}
                  onDeleteTask={handleDeleteTask}
                  onOpenConversation={handleOpenConversation}
                  agentMap={agentMap}
                  dependencyHighlights={dependencyHighlights}
                  onTaskHoverIn={(taskId) => setHoveredTaskId(taskId)}
                  onTaskHoverOut={() => setHoveredTaskId(null)}
                />
              ))}
            </View>
          </ScrollView>
        </View>
      )
    }

    // No project selected — show interactive project picker
    if (!currentProjectId) {
      return (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingHorizontal: 24,
            paddingVertical: 24,
            alignItems: "center",
          }}
        >
          <EmptyState
            icon="folder"
            title={t("board.selectProject")}
            text={projects.length === 0 ? t("board.noProjectsHint") : undefined}
            style={{ paddingBottom: 16 }}
          />
          {projects.length > 0 ? (
            <LGroup style={{ width: "100%", maxWidth: 420 }}>
              {projects.map((p) => (
                <LRow
                  key={p.projectId}
                  hov
                  onPress={() => setCurrentProject(p.projectId)}
                  testID={`board-project-${p.projectId}`}
                >
                  <Ph name="kanban" size={16} color={c.accent} />
                  <T step="sm" ellipsis style={{ flex: 1 }}>
                    {p.name}
                  </T>
                  <Ph name="caret-right" size={13} color={c.text3} />
                </LRow>
              ))}
            </LGroup>
          ) : null}
          {!showCreateProject && (
            <Btn
              variant="primary"
              icon="plus"
              onPress={() => setShowCreateProject(true)}
              style={{ marginTop: 20 }}
              testID="board-create-project"
            >
              {t("board.createProject")}
            </Btn>
          )}
        </ScrollView>
      )
    }

    return null
  }

  const closeDropdowns = useCallback(() => {
    setShowProjectPicker(false)
  }, [])

  // ========================================================================
  // RENDER: MAIN LAYOUT
  // ========================================================================

  const viewTabs = [
    { key: "mission" as const, label: t("board.missionView"), icon: "rocket-launch" },
    { key: "kanban" as const, label: t("board.kanbanView"), icon: "kanban" },
    {
      key: "list" as const,
      label: t("board.listView", { defaultValue: "List" }),
      icon: "list-checks",
    },
    { key: "settings" as const, label: t("board.settingsView"), icon: "gear-six" },
  ]

  return (
    <Pressable
      onPress={closeDropdowns}
      style={{ flex: 1 }}
      {...(Platform.OS === "web"
        ? ({
            ref: (v: View | null) => {
              boardRootRef.current = v as unknown as HTMLElement | null
            },
          } as any)
        : {})}
    >
      <View style={{ flex: 1, backgroundColor: c.bgSheet }}>
        {/* ================================================================ */}
        {/* HEADER STRIP (`.phead`) */}
        {/* ================================================================ */}
        <PHead
          icon="kanban"
          title={
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                flexShrink: 1,
                minWidth: 0,
              }}
            >
              <IconBtn
                icon="caret-left"
                sm
                plain
                title={t("board.selectProject")}
                onPress={() => {
                  setCurrentProject(null)
                  setSelectedTask(null)
                }}
                testID="board-back"
              />
              <T step="xl" ellipsis style={{ flexShrink: 1 }}>
                {currentProject?.name ?? t("windows.board")}
              </T>
            </View>
          }
          right={
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              {board ? (
                <T step="codenote" tone="text3">
                  {t("board.openCount", { count: openCount, defaultValue: "{{count}} open" })}
                </T>
              ) : null}
              {board ? (
                <Btn
                  variant="primary"
                  size="sm"
                  icon="plus"
                  caps
                  onPress={() => {
                    setViewMode("kanban")
                    setAddingToColumn(firstAddColumnId)
                  }}
                  testID="board-new-task"
                >
                  {t("board.newTaskCaps", { defaultValue: "Task" })}
                </Btn>
              ) : null}
              {board ? (
                <View ref={moreBtnRef} collapsable={false}>
                  <IconBtn
                    icon="dots-three-vertical"
                    plain
                    sm
                    title={t("board.moreActions", { defaultValue: "More actions" })}
                    onPress={() => {
                      setArmDelete(false)
                      if (moreBtnRef.current) {
                        moreBtnRef.current.measure((_fx, _fy, _w, h, px, py) => {
                          setMoreAnchor({ x: px, y: py, h })
                          setShowMoreMenu(true)
                        })
                      } else setShowMoreMenu(true)
                    }}
                    testID="board-more"
                  />
                </View>
              ) : null}
            </View>
          }
          style={{ paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: c.border }}
        >
          {board ? (
            <PTabs<BoardViewMode> items={viewTabs} value={viewMode} onChange={setViewMode} />
          ) : null}
        </PHead>

        {/* Project picker dropdown — Modal with measured coordinates for robust positioning */}
        <Modal
          visible={showProjectPicker}
          transparent
          animationType="none"
          onRequestClose={() => setShowProjectPicker(false)}
        >
          {/* Backdrop — tap outside to close */}
          <Pressable style={{ flex: 1 }} onPress={() => setShowProjectPicker(false)}>
            {/* Dropdown panel anchored below the selector button */}
            <View
              style={[
                {
                  position: "absolute",
                  top: projectPickerAnchor
                    ? projectPickerAnchor.y + projectPickerAnchor.height + 6
                    : 100,
                  left: projectPickerAnchor ? projectPickerAnchor.x : 100,
                  backgroundColor: c.bgStep,
                  borderRadius: 12,
                  padding: 6,
                  minWidth: 240,
                  maxHeight: 360,
                },
                Platform.OS === "web" ? ({ boxShadow: c.elevRaised } as any) : { elevation: 20 },
              ]}
            >
              <ScrollView style={{ maxHeight: 320 }}>
                {projects.length === 0 ? (
                  <T step="12" tone="text3" style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
                    {t("board.noProjectsInWorkspace")}
                  </T>
                ) : (
                  projects.map((p) => (
                    <Pressable
                      key={p.projectId}
                      onPress={() => {
                        setCurrentProject(p.projectId)
                        setShowProjectPicker(false)
                      }}
                      style={[
                        {
                          paddingHorizontal: 12,
                          paddingVertical: 8,
                          borderRadius: 8,
                          backgroundColor:
                            p.projectId === currentProjectId ? c.navActive : "transparent",
                        },
                        Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
                      ]}
                    >
                      <T step="sm" color={p.projectId === currentProjectId ? c.accent : c.text}>
                        {p.name}
                      </T>
                    </Pressable>
                  ))
                )}
              </ScrollView>
            </View>
          </Pressable>
        </Modal>

        {/* Create project inline */}
        {showCreateProject && (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingHorizontal: 24,
              paddingVertical: 10,
              borderBottomWidth: 1,
              borderBottomColor: c.border,
            }}
          >
            <Field
              value={newProjectName}
              onChangeText={setNewProjectName}
              placeholder={t("board.projectNamePlaceholder")}
              autoFocus
              onSubmitEditing={handleCreateProject}
              icon="folder-plus"
              containerStyle={{ flex: 1, maxWidth: 420 }}
              testID="board-new-project-input"
            />
            <Btn variant="primary" onPress={handleCreateProject} testID="board-new-project-submit">
              {t("board.createProject")}
            </Btn>
            <Btn
              variant="ghost"
              onPress={() => {
                setShowCreateProject(false)
                setNewProjectName("")
              }}
            >
              {t("common.cancel", { defaultValue: "Cancel" })}
            </Btn>
          </View>
        )}

        {/* ================================================================ */}
        {/* BOARD CONTENT — shrinks when detail panel is open so columns  */}
        {/* remain fully scrollable instead of hiding behind the overlay   */}
        {/* ================================================================ */}
        <View
          style={{
            flex: 1,
            paddingRight: showTaskDetail
              ? TASK_DETAIL_WIDTH
              : showAutoplay && board
                ? AUTOPLAY_PANEL_WIDTH
                : 0,
          }}
        >
          {renderBoardContent()}

          {/* Side panels live HERE, under the header strip, so they never
              cover the title, the view tabs or the actions. */}
          {/* Autoplay panel — yields to the task detail panel. */}
          {showAutoplay && board && !showTaskDetail ? (
            <AutoplayPanel
              relationships={agentRelationships}
              availableAgents={availableAgents}
              onSetSlots={handleSetSlots}
              onSetPlay={handleSetPlay}
              onAddRunner={handleAddRunner}
              onRemoveRunner={handleRemoveRunner}
              onClose={() => setShowAutoplay(false)}
            />
          ) : null}

          {showTaskDetail && selectedTask && (
            <TaskDetailPanel
              task={selectedTask}
              columns={board?.columns || []}
              onClose={() => {
                setShowTaskDetail(false)
                setSelectedTask(null)
              }}
              onMoveTask={handleMoveTask}
              onOpenConversation={handleOpenConversation}
              onAssignTask={handleAssignTask}
              onStartTask={handleStartTask}
              onStopTask={handleStopTask}
              onCompleteTask={handleCompleteTask}
              onSaveOutput={handleSaveOutput}
              onArchiveTask={handleArchiveTask}
              agentMap={agentMap}
            />
          )}
        </View>

        {/* ================================================================ */}
        {/* TASK DETAIL PANEL */}
        {/* ================================================================ */}

        {/* More-actions menu (anchored Modal, like the other dropdowns) */}
        <Modal
          visible={showMoreMenu}
          transparent
          animationType="none"
          onRequestClose={() => setShowMoreMenu(false)}
        >
          <Pressable style={{ flex: 1 }} onPress={() => setShowMoreMenu(false)}>
            <View
              style={[
                {
                  position: "absolute",
                  top: moreAnchor ? moreAnchor.y + moreAnchor.h + 6 : 60,
                  right: 20,
                  backgroundColor: c.bgStep,
                  borderRadius: 12,
                  padding: 6,
                  minWidth: 220,
                },
                Platform.OS === "web" ? ({ boxShadow: c.elevRaised } as any) : { elevation: 20 },
              ]}
            >
              {(
                [
                  {
                    key: "settings",
                    icon: "gear-six",
                    label: t("board.projectSettings", { defaultValue: "Project settings" }),
                    onPress: () => setViewMode("settings"),
                  },
                  {
                    key: "autoplay",
                    icon: "play-circle",
                    label: t("board.openAutoplay", { defaultValue: "Open Autoplay" }),
                    onPress: () => setShowAutoplay(true),
                  },
                  {
                    key: "copy",
                    icon: "copy",
                    label: t("board.copyProjectId", { defaultValue: "Copy project ID" }),
                    onPress: () => {
                      if (!currentProjectId) return
                      try {
                        if (Platform.OS === "web") navigator.clipboard?.writeText(currentProjectId)
                        toast.success(
                          t("board.projectIdCopied", { defaultValue: "Project ID copied" }),
                        )
                      } catch {
                        // Clipboard may be unavailable (permissions, non-secure context).
                      }
                    },
                  },
                  {
                    key: "delete",
                    icon: "trash",
                    danger: true,
                    keepOpen: !armDelete,
                    label: armDelete
                      ? t("board.confirmDeleteProject", { defaultValue: "Confirm: delete project" })
                      : t("board.deleteProject", { defaultValue: "Delete project" }),
                    onPress: () => {
                      if (!armDelete) {
                        setArmDelete(true)
                        return
                      }
                      void handleDeleteProject()
                    },
                  },
                ] as Array<{
                  key: string
                  icon: string
                  label: string
                  danger?: boolean
                  keepOpen?: boolean
                  onPress: () => void
                }>
              ).map((item) => (
                <Pressable
                  key={item.key}
                  testID={`board-more-${item.key}`}
                  onPress={() => {
                    item.onPress()
                    if (!item.keepOpen) setShowMoreMenu(false)
                  }}
                  style={({ pressed, hovered }: any) => [
                    {
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 10,
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      borderRadius: 8,
                      backgroundColor: pressed || hovered ? c.wash2 : "transparent",
                    },
                    Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
                  ]}
                >
                  <Ph name={item.icon} size={15} color={item.danger ? c.tint.r.tx : c.text2} />
                  <T step="sm" color={item.danger ? c.tint.r.tx : c.text}>
                    {item.label}
                  </T>
                </Pressable>
              ))}
            </View>
          </Pressable>
        </Modal>
      </View>

      {/* Tag filter dropdown - rendered at root level for proper z-index */}
      {showTagFilterDropdown && allTags.length > 0 && (
        <>
          {/* Backdrop to close dropdown */}
          <Pressable
            onPress={() => setShowTagFilterDropdown(false)}
            style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 9998 }}
          />

          {/* Dropdown menu */}
          <View
            style={[
              {
                position: "absolute",
                top: 112,
                right:
                  (showTaskDetail
                    ? TASK_DETAIL_WIDTH
                    : showAutoplay && board
                      ? AUTOPLAY_PANEL_WIDTH
                      : 0) + 24,
                zIndex: 9999,
                backgroundColor: c.bgStep,
                borderRadius: 12,
                minWidth: 240,
                maxHeight: 360,
                overflow: "hidden",
              },
              Platform.OS === "web" ? ({ boxShadow: c.elevRaised } as any) : { elevation: 20 },
            ]}
          >
            {/* Search input */}
            <View style={{ padding: 8, borderBottomWidth: 1, borderBottomColor: c.border }}>
              <Field
                inputRef={tagSearchInputRef}
                icon="magnifying-glass"
                value={tagSearchQuery}
                onChangeText={setTagSearchQuery}
                placeholder={t("board.searchTags")}
                autoCapitalize="none"
                autoCorrect={false}
                right={
                  tagSearchQuery.length > 0 ? (
                    <IconBtn
                      icon="x"
                      sm
                      plain
                      onPress={() => setTagSearchQuery("")}
                      style={{ marginRight: -8 }}
                    />
                  ) : undefined
                }
              />
            </View>

            <ScrollView style={{ maxHeight: 280 }}>
              <View style={{ padding: 6, gap: 2 }}>
                {visibleTagsInDropdown.length === 0 ? (
                  <View
                    style={{ paddingHorizontal: 12, paddingVertical: 14, alignItems: "center" }}
                  >
                    <T step="sm" tone="text3">
                      {t("board.noMatchingTags")}
                    </T>
                  </View>
                ) : (
                  visibleTagsInDropdown.map((tag) => {
                    const isActive = activeTagFilters.has(tag)
                    return (
                      <Pressable
                        key={tag}
                        onPress={() => toggleTagFilter(tag)}
                        style={[
                          {
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 10,
                            paddingHorizontal: 10,
                            paddingVertical: 8,
                            borderRadius: 8,
                            backgroundColor: isActive ? c.navActive : "transparent",
                          },
                          Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
                        ]}
                      >
                        <Check on={isActive} />
                        <T step="sm" color={isActive ? c.accent : c.text} style={{ flex: 1 }}>
                          {tag}
                        </T>
                      </Pressable>
                    )
                  })
                )}
              </View>
            </ScrollView>
          </View>
        </>
      )}
    </Pressable>
  )
}
