import type { Space } from "@teros/shared"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Keyboard, Platform, View } from "react-native"
import { useColors, useMcaTheme } from "../../components/mca/primitives/useColors"
import { SharedSpaceNotice } from "../../components/sharing/SharedSpaceNotice"
import { markSharedNoticeSeen, sharedNoticeSeen } from "../../components/sharing/sharedSpace"
import {
  controlAnswererOf,
  WheelRequestCard,
} from "../../components/mca/renderers/terminal/WheelRequestCard"
import { useToast } from "../../components/Toast"
import { isMac, toggleFloat } from "../../components/workspace/floating/useFloatShortcut"
import { AppSpinner } from "../../components/ui"
import { Btn, EmptyState, T } from "../../components/ui/ds"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useAuthStore } from "../../store/authStore"
import { useNavbarStore } from "../../store/navbarStore"
import { useWindowChrome } from "../../store/windowChromeStore"
import { type LayoutNode, selectLayout, useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import { type CloseReason, closeReason } from "./closeTerminal"
import {
  type CreateFailure,
  createFailureOf,
  createFailureReason,
  emptyViewOf,
} from "./createFailure"
import type { TerminalWindowProps } from "./definition"
import { ExtraKeysBar } from "./ExtraKeysBar"
import { SessionsList } from "./SessionsList"
import { TerminalCreateFailed } from "./TerminalCreateFailed"
import { TerminalPicker } from "./TerminalPicker"
import { PILL_HEIGHT, PILL_INSET, TerminalCornerPill } from "./TerminalCornerPill"
import { TerminalSpaceCard } from "./TerminalSpaceCard"
import { openerOf, someoneElseTyping } from "./sessionText"
import {
  type PaneLiveState,
  TerminalView,
  type TerminalViewHandle,
  type WindowShortcut,
} from "./TerminalView"
import {
  agentReason,
  newTerminalEntries,
  sharedOfferOpen,
  shortcutLabel,
  terminalCloseGuard,
  terminalClosed,
  terminalMenu,
  terminalTabIcon,
  terminalTabMarks,
  watchConfirmText,
} from "./terminalChrome"
import { defaultTitle } from "./terminalLayout"
import {
  newTerminalId,
  sessionLabel,
  showTerminalSession,
  type TerminalSession,
  useTerminalSessions,
} from "./terminalSessions"
import {
  inheritedSpace,
  nextWindowProps,
  offersPersonalAfter,
  opensOnPicker,
  sessionGroups,
  sessionsElsewhere,
  sharedOfferOf,
  toolbarOf,
} from "./terminalWindowModel"
import { useBashApp } from "./useBashApp"
import { useEndSession } from "./useEndSession"

interface Props extends TerminalWindowProps {
  windowId: string
}

const CREATE_TIMEOUT_MS = 120_000
const AGENT_UNDO_MS = 5000
const NARROW_PX = 420

type Confirm = { kind: "watch" } | { kind: "end"; reason: CloseReason }

function readOptionIsMeta(): boolean {
  try {
    return Platform.OS === "web" && localStorage.getItem("teros.terminal.optionIsMeta") === "1"
  } catch {
    return false
  }
}

function isTouch(): boolean {
  if (Platform.OS !== "web") return true
  try {
    return window.matchMedia?.("(pointer: coarse)").matches === true
  } catch {
    return false
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && /timeout/i.test(err.message)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function containerIdOf(node: LayoutNode | null, windowId: string): string | null {
  if (!node) return null
  if (node.type === "container") return node.windowIds.includes(windowId) ? node.id : null
  return containerIdOf(node.first, windowId) ?? containerIdOf(node.second, windowId)
}

export function TerminalWindowContent({
  windowId,
  workspaceId: propWorkspaceId,
  terminalId,
  title: propTitle,
  initialCwd,
  appId: propAppId,
  preset,
  pendingCreate,
  space,
}: Props) {
  const { t } = useTranslation()
  const c = useColors()
  const theme = useMcaTheme()
  const toast = useToast()
  const client = getTerosClient()

  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const me = useAuthStore((s) => s.user?.userId)
  const workspaceId = propWorkspaceId ?? activeWorkspaceId ?? ""
  const workspace = useNavbarStore((s) => s.workspaces.find((w) => w.workspaceId === workspaceId))
  const role = workspace?.role
  const readOnlyRole = role === "read"
  const [noticeSeen, setNoticeSeen] = useState(true)
  useEffect(() => {
    setNoticeSeen(!me || !workspaceId || sharedNoticeSeen("terminal", workspaceId, me))
  }, [me, workspaceId])

  const {
    appId: resolvedAppId,
    mcaId: resolvedMcaId,
    scope: bashScope,
    installedBy: bashOwner,
    loading: appLoading,
    reload: reloadApps,
  } = useBashApp(propAppId ? undefined : workspaceId)
  const appId = propAppId ?? resolvedAppId
  const { sessions, loaded } = useTerminalSessions(readOnlyRole ? null : workspaceId)
  const session = useMemo(
    () => sessions.find((s) => s.terminalId === terminalId),
    [sessions, terminalId],
  )
  const waitingForTypist = session ? someoneElseTyping(session, me) : false
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!waitingForTypist) return
    const timer = setInterval(() => setTick((n) => n + 1), 5000)
    return () => clearInterval(timer)
  }, [waitingForTypist])
  const windows = useTilingStore((s) => s.windows)
  const floats = useTilingStore((s) => s.floats)
  const desktops = useTilingStore((s) => s.desktops)
  const activeDesktopIndex = useTilingStore((s) => s.activeDesktopIndex)
  const updateWindowProps = useTilingStore((s) => s.updateWindowProps)
  const closeWindow = useTilingStore((s) => s.closeWindow)

  const [listOpen, setListOpen] = useState(false)
  const [spaceOpen, setSpaceOpen] = useState(false)
  const [narrow, setNarrow] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [creating, setCreating] = useState(false)
  const [failure, setFailure] = useState<CreateFailure | null>(null)
  const sharedOffer = useMemo(
    () =>
      sharedOfferOf(
        propAppId || appLoading ? null : { scope: bashScope, installedBy: bashOwner },
        me,
      ),
    [propAppId, appLoading, bashScope, bashOwner, me],
  )
  const [installing, setInstalling] = useState(false)
  const [live, setLive] = useState<PaneLiveState | null>(null)
  const [mods, setMods] = useState({ ctrl: false, alt: false })
  const [optionIsMeta, setOptionIsMeta] = useState(readOptionIsMeta)
  const [keyboardHeight, setKeyboardHeight] = useState(0)
  const pane = useRef<TerminalViewHandle>(null)
  const createStarted = useRef<string | null>(null)
  const touch = useMemo(isTouch, [])

  const picking = opensOnPicker({ terminalId, preset, initialCwd, space })
  useEffect(() => {
    if (picking || readOnlyRole) return
    const next = nextWindowProps({ terminalId }, workspaceId, space ?? "personal")
    if (next) updateWindowProps(windowId, next)
  }, [picking, terminalId, workspaceId, windowId, updateWindowProps, readOnlyRole, space])

  useEffect(() => {
    if (!pendingCreate || !terminalId || !appId || !client || readOnlyRole) return
    if (createStarted.current === terminalId) return
    createStarted.current = terminalId
    setCreating(true)
    const kind = preset === "claude" ? "claude" : "shell"
    const payload = {
      terminalId,
      appId,
      mcaId: resolvedMcaId,
      cols: 120,
      rows: 36,
      preset: kind,
      title: defaultTitle(kind, sessions),
      cwd: initialCwd,
      subscribe: false,
      space: space ?? "personal",
    }
    const create = () =>
      client.transport.request("terminal.create", payload, { timeout: CREATE_TIMEOUT_MS })
    create()
      .catch((err: unknown) => (isTimeout(err) ? create() : Promise.reject(err)))
      .catch((err: unknown) => {
        const failed = createFailureOf(terminalId, err)
        setFailure(failed)
        toast.error(
          t("terminal.createFailed", { defaultValue: "Could not open a terminal" }),
          createFailureReason(failed, t),
        )
      })
      .finally(() => {
        setCreating(false)
        updateWindowProps(windowId, { pendingCreate: undefined })
      })
  }, [
    pendingCreate,
    terminalId,
    appId,
    client,
    readOnlyRole,
    preset,
    resolvedMcaId,
    sessions,
    initialCwd,
    space,
    toast,
    t,
    updateWindowProps,
    windowId,
  ])

  const label = session ? sessionLabel(session) : undefined
  useEffect(() => {
    if (label && label !== propTitle) updateWindowProps(windowId, { title: label })
  }, [label, propTitle, updateWindowProps, windowId])

  const endSession = useEndSession(workspaceId)
  const closeContext = (target: TerminalSession) => ({
    me,
    shownElsewhere: Object.values(useTilingStore.getState().windows).some(
      (w) =>
        w.id !== windowId && w.type === "terminal" && w.props?.terminalId === target.terminalId,
    ),
    end: () => endSession(target),
    note: (text: string) => toast.show(text, { type: "info" }),
  })

  useEffect(() => {
    if (!touch) return
    if (Platform.OS === "web") {
      const vv = window.visualViewport
      if (!vv) return
      const onResize = () => setKeyboardHeight(Math.max(0, window.innerHeight - vv.height))
      vv.addEventListener("resize", onResize)
      return () => vv.removeEventListener("resize", onResize)
    }
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      (e) => setKeyboardHeight(e.endCoordinates.height),
    )
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => setKeyboardHeight(0),
    )
    return () => {
      show.remove()
      hide.remove()
    }
  }, [touch])

  const send = useCallback(
    (action: string, payload: Record<string, unknown>, failed: string) =>
      client
        ?.send("terminal", action, payload)
        .catch((err: unknown) => toast.error(failed, messageOf(err))),
    [client, toast],
  )

  const switchAgent = useRef<(enabled: boolean, quiet?: boolean) => void>(() => {})
  const setAgentControl = useCallback(
    (enabled: boolean, quiet = false) => {
      if (!terminalId) return
      void send(
        "agentControl",
        { terminalId, enabled },
        t("terminal.window.agentToggleFailed", { defaultValue: "Could not change Agent control" }),
      )
      if (!enabled) pane.current?.focus()
      if (quiet) return
      const name = label ?? t("terminal.window.thisTerminal", { defaultValue: "this terminal" })
      toast.show(
        enabled
          ? t("terminal.window.agentNowOn", {
              defaultValue: "Agents can see and type in {{name}}",
              name,
            })
          : t("terminal.window.agentNowOff", {
              defaultValue: "Agents can no longer see {{name}}",
              name,
            }),
        {
          type: "info",
          duration: AGENT_UNDO_MS,
          action: {
            label: t("terminal.window.undo", { defaultValue: "Undo" }),
            onPress: () => switchAgent.current(!enabled, true),
          },
        },
      )
    },
    [terminalId, send, t, toast, label],
  )
  switchAgent.current = setAgentControl

  const setWatchable = useCallback(
    (enabled: boolean) => {
      if (!terminalId) return
      void send(
        "watchable",
        { terminalId, enabled },
        t("terminal.window.watchFailed", {
          defaultValue: "Could not change who can watch this terminal",
        }),
      )
    },
    [terminalId, send, t],
  )

  const openNew = useCallback(
    (inSpace: Space) => {
      setListOpen(false)
      const props = nextWindowProps({}, workspaceId, inSpace)
      if (props) useTilingStore.getState().openWindow("terminal", props, { inNewTab: true })
    },
    [workspaceId],
  )

  const sideSpace: Space = inheritedSpace(session)
  const openToSide = useCallback(() => {
    const tiling = useTilingStore.getState()
    const container = containerIdOf(selectLayout(tiling), windowId)
    const props = nextWindowProps({}, workspaceId, sideSpace)
    if (!props) return
    if (container) tiling.splitContainer(container, "horizontal")
    tiling.openWindow("terminal", props, { inNewTab: true })
  }, [windowId, workspaceId, sideSpace])

  const restartSpace: Space = session ? inheritedSpace(session) : (space ?? "personal")
  const restartHere = useCallback(() => {
    updateWindowProps(windowId, {
      terminalId: newTerminalId(),
      pendingCreate: true,
      title: undefined,
      space: restartSpace,
    })
  }, [updateWindowProps, windowId, restartSpace])

  const openPersonalHere = useCallback(() => {
    updateWindowProps(windowId, {
      terminalId: newTerminalId(),
      pendingCreate: true,
      title: undefined,
      space: "personal",
    })
  }, [updateWindowProps, windowId])

  const dismissNotice = useCallback(() => {
    if (me && workspaceId) markSharedNoticeSeen("terminal", workspaceId, me)
    setNoticeSeen(true)
  }, [me, workspaceId])

  const requestEnd = useCallback(() => {
    if (!session) return
    const reason = closeReason(session, me)
    if (reason) setConfirm({ kind: "end", reason })
    else endSession(session)
  }, [session, me, endSession])

  const requestLetWatch = useCallback(() => {
    if (!session) return
    if (session.watchable) setWatchable(false)
    else setConfirm({ kind: "watch" })
  }, [session, setWatchable])

  const onShortcut = useCallback(
    (action: WindowShortcut) => {
      if (action === "take-wheel") setAgentControl(false)
      if (action === "go-session") setListOpen(true)
      if (action === "float") toggleFloat(windowId)
    },
    [setAgentControl, windowId],
  )

  const installBash = useCallback(async () => {
    if (!client || !workspaceId) return
    setInstalling(true)
    try {
      await client.installWorkspaceApp(workspaceId, "mca.teros.bash")
      reloadApps()
    } catch (err) {
      toast.error(
        t("terminal.installFailed", { defaultValue: "Could not install Bash" }),
        messageOf(err),
      )
    } finally {
      setInstalling(false)
    }
  }, [client, workspaceId, toast, t, reloadApps])

  const toggleOptionMeta = useCallback(() => {
    setOptionIsMeta((v) => {
      try {
        localStorage.setItem("teros.terminal.optionIsMeta", v ? "0" : "1")
      } catch {
        return !v
      }
      return !v
    })
  }, [])

  const state = session ? toolbarOf(session, me, role ?? "write") : null
  const statusLine = [
    live?.status === "live"
      ? t("terminal.live", { defaultValue: "Live" })
      : live?.status === "offline"
        ? t("terminal.reconnecting", { defaultValue: "Reconnecting…" })
        : null,
    typeof live?.echoP50 === "number" ? `${live.echoP50} ms` : null,
  ]
    .filter(Boolean)
    .join(" · ")
  const finishRename = (title: string | null) => {
    setRenaming(false)
    pane.current?.focus()
    if (!session || !terminalId || title === null || title === session.title) return
    void send(
      "update",
      { terminalId, title },
      t("terminal.window.renameFailed", { defaultValue: "Could not rename the session" }),
    )
  }
  const mac = isMac()
  const actions = {
    goToSession: () => setListOpen(true),
    rename: () => setRenaming(true),
    openNew,
    openToSide,
    end: requestEnd,
    toggleOptionMeta: Platform.OS === "web" && !touch ? toggleOptionMeta : undefined,
  }
  useWindowChrome(
    windowId,
    readOnlyRole || !appId
      ? null
      : session && state
        ? {
            icon: terminalTabIcon(session, state, t),
            marks: terminalTabMarks(session, state, me, t),
            ring: state.consent,
            menu: {
              entries: terminalMenu(session, state, t, actions, {
                me,
                mac,
                sideSpace,
                sharedOffer,
                optionIsMeta,
                statusLine,
              }),
            },
            titleEdit: renaming
              ? { initial: session.title || sessionLabel(session), onDone: finishRename }
              : null,
            closeGuard: () => terminalCloseGuard(session, t, closeContext(session)),
            onClose: () => terminalClosed(session, t, closeContext(session)),
          }
        : { menu: { entries: newTerminalEntries(t, actions, mac, sharedOffer) } },
  )

  if (readOnlyRole) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bgSheet, justifyContent: "center" }}>
        <EmptyState
          icon="lock"
          title={t("terminal.readRoleTitle", { defaultValue: "Terminals need write access" })}
          text={t("terminal.readRoleText", {
            defaultValue:
              "A terminal is a shell in this workspace's machine, and its screen can show secrets. Ask an admin for write access.",
          })}
        />
      </View>
    )
  }

  if (!appLoading && !appId) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bgSheet, justifyContent: "center" }}>
        <EmptyState
          icon="terminal-window"
          title={t("terminal.noBashApp")}
          text={t("terminal.installBashHint")}
          action={
            <Btn
              variant="primary"
              icon="download-simple"
              loading={installing}
              onPress={installBash}
              testID="terminal-install-bash"
            >
              {t("terminal.installBash", { defaultValue: "Install Bash and open a terminal" })}
            </Btn>
          }
        />
      </View>
    )
  }

  const opening = !terminalId || pendingCreate || creating || appLoading || !loaded
  const emptyView = emptyViewOf({ terminalId, opening, failure })
  const openIds = new Set(
    Object.values(windows)
      .filter((w) => w.type === "terminal" && w.props?.terminalId)
      .map((w) => w.props.terminalId as string),
  )
  const groups = sessionGroups(
    sessions,
    me,
    openIds,
    sessionsElsewhere(windows, floats, desktops, activeDesktopIndex, t),
  )

  const paneLabels = {
    asleep: t("terminal.window.asleepWatch", {
      defaultValue: "Asleep: only its person can wake it",
    }),
    watchOnly: t("terminal.window.watchOnly", {
      defaultValue: "This is someone's personal terminal — view only",
    }),
    starting: t("terminal.pane.starting", { defaultValue: "Starting…" }),
    reconnecting: t("terminal.reconnecting", { defaultValue: "Reconnecting…" }),
    retry: t("terminal.pane.retry", { defaultValue: "Retry" }),
    ended: t("terminal.ended", { defaultValue: "Session ended" }),
    restart: t("terminal.window.newSession", { defaultValue: "New session" }),
    close: t("common.close", { defaultValue: "Close" }),
    denied: t("terminal.pane.denied", { defaultValue: "You don't have access to this session" }),
    failed: t("terminal.pane.failed", {
      defaultValue: "This session couldn't wake up. Try again in a moment.",
    }),
    jump: t("terminal.pane.jump", { defaultValue: "Jump to the bottom" }),
    readOnly: t("terminal.window.viewOnly", {
      defaultValue: "{{name}} is typing — view only",
    }),
    takeWheel: t("terminal.window.switchAgentOff", { defaultValue: "Switch Agent off to type" }),
  }

  const closeList = () => {
    setListOpen(false)
    pane.current?.focus()
  }
  const sessionsPopover = () =>
    listOpen ? (
      <SessionsList
        groups={groups}
        currentId={terminalId ?? null}
        me={me}
        role={role}
        sharedOffer={sharedOffer}
        onPick={(id) => {
          setListOpen(false)
          if (id !== terminalId) showTerminalSession(workspaceId, id)
        }}
        onNew={openNew}
        onEnd={endSession}
        touch={touch}
        onClose={closeList}
      />
    ) : null

  if (picking) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bgSheet }} testID="terminal-window">
        <TerminalPicker
          windowId={windowId}
          workspaceId={workspaceId}
          groups={groups}
          me={me}
          role={role}
          sharedOffer={sharedOffer}
          touch={touch}
          onEnd={endSession}
        />
      </View>
    )
  }

  if (!session || !state || !terminalId) {
    return (
      <View
        style={{ flex: 1, backgroundColor: c.bgSheet, justifyContent: "center" }}
        testID="terminal-window"
      >
        {emptyView === "create-failed" && failure ? (
          <TerminalCreateFailed
            failure={failure}
            onRetry={restartHere}
            onSessions={() => setListOpen(true)}
            onPersonal={offersPersonalAfter(failure, space) ? openPersonalHere : undefined}
            offer={sharedOffer}
          />
        ) : emptyView === "opening" ? (
          <View style={{ alignItems: "center", gap: 10 }} testID="terminal-opening">
            <AppSpinner size="md" />
            <T step="codenote" tone="text3">
              {t("terminal.window.opening", { defaultValue: "Opening a terminal…" })}
            </T>
          </View>
        ) : (
          <EmptyState
            icon="terminal-window"
            title={t("terminal.window.goneTitle", { defaultValue: "This session is not here" })}
            text={t("terminal.window.goneText", {
              defaultValue:
                "It ended, or its person stopped letting the workspace watch it. Start a new one in this window or pick another session.",
            })}
            action={
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Btn variant="primary" icon="plus" onPress={restartHere} testID="terminal-gone-new">
                  {t("terminal.window.newSession", { defaultValue: "New session" })}
                </Btn>
                <Btn icon="list" onPress={() => setListOpen(true)} testID="terminal-gone-sessions">
                  {t("terminal.window.sessions", { defaultValue: "Sessions" })}
                </Btn>
              </View>
            }
          />
        )}
        {sessionsPopover()}
      </View>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bgSheet }} testID="terminal-window">
      {confirm ? (
        <ConfirmBar
          confirm={confirm}
          sharedOpen={sharedOfferOpen(sharedOffer)}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const asked = confirm
            setConfirm(null)
            if (asked.kind === "watch") setWatchable(true)
            else endSession(session)
          }}
        />
      ) : null}
      {state.space === "shared" && !noticeSeen ? (
        <SharedSpaceNotice
          kind="terminal"
          workspaceName={workspace?.name}
          onDismiss={dismissNotice}
        />
      ) : null}
      {session.wheelRequest ? (
        <View style={{ paddingHorizontal: 10, paddingVertical: 6, backgroundColor: c.bgSheet }}>
          <WheelRequestCard
            testID="terminal-control-request"
            terminalId={terminalId}
            sessionName={sessionLabel(session)}
            request={session.wheelRequest}
            canAnswer={!readOnlyRole && !state.watching}
            answerer={controlAnswererOf(session, me)}
            opener={openerOf(session, me)}
          />
        </View>
      ) : null}
      <View
        style={{ flex: 1, backgroundColor: c.bgInner }}
        onLayout={(e) => setNarrow(e.nativeEvent.layout.width < NARROW_PX)}
      >
        <TerminalView
          ref={pane}
          terminalId={terminalId}
          theme={theme}
          optionIsMeta={optionIsMeta}
          background={c.bgSheet}
          onLive={(_id, patch) =>
            setLive((prev) => ({
              ...(prev ?? { status: "connecting", typing: null, watchers: [] }),
              ...patch,
            }))
          }
          onModifierReset={() => setMods({ ctrl: false, alt: false })}
          onShortcut={onShortcut}
          focusOnAttach="auto"
          labels={paneLabels}
          onAction={(_id, action) => (action === "restart" ? restartHere() : closeWindow(windowId))}
        />
        <TerminalCornerPill
          state={state}
          narrow={narrow}
          active={spaceOpen}
          reason={agentReason(session, state, t, { me })}
          offShortcut={shortcutLabel("K", mac)}
          onReason={(why) => toast.show(why, { type: "info" })}
          onToggleAgent={(enabled) => {
            setAgentControl(enabled)
            pane.current?.focus()
          }}
          onSpace={() => setSpaceOpen(true)}
        />
        {spaceOpen ? (
          <TerminalSpaceCard
            session={session}
            state={state}
            me={me}
            top={PILL_INSET.top + PILL_HEIGHT + 6}
            sharedOffer={sharedOffer}
            onLetWatch={requestLetWatch}
            onNewShared={() => openNew("shared")}
            onClose={() => {
              setSpaceOpen(false)
              pane.current?.focus()
            }}
          />
        ) : null}
      </View>
      {touch ? (
        <ExtraKeysBar
          ctrl={mods.ctrl}
          alt={mods.alt}
          bottomInset={keyboardHeight}
          onKey={(seq) => {
            pane.current?.input(seq)
            setMods({ ctrl: false, alt: false })
          }}
          onModifier={(m) => {
            const next = !mods[m]
            setMods((prev) => ({ ...prev, [m]: next }))
            pane.current?.setModifier(m, next)
          }}
        />
      ) : null}
      {sessionsPopover()}
    </View>
  )
}

function ConfirmBar({
  confirm,
  sharedOpen,
  onCancel,
  onConfirm,
}: {
  confirm: Confirm
  sharedOpen: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation()
  const c = useColors()
  const text =
    confirm.kind === "watch"
      ? watchConfirmText(sharedOpen, t)
      : confirm.reason?.kind === "working"
        ? t("terminal.window.endWorking", {
            defaultValue: "{{agent}} is in the middle of something here. End the session anyway?",
            agent: confirm.reason.agent,
          })
        : confirm.reason?.kind === "program"
          ? t("terminal.window.endProgram", {
              defaultValue: "{{command}} is still running here. End the session anyway?",
              command: confirm.reason.command,
            })
          : t("terminal.window.endDriver", {
              defaultValue: "Someone else is typing here. End the session anyway?",
            })
  return (
    <View
      testID="terminal-confirm"
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: c.bgStep,
        borderBottomWidth: 1,
        borderBottomColor: c.border,
      }}
    >
      <T step="sm" style={{ color: c.text, flex: 1, minWidth: 220 }}>
        {text}
      </T>
      <Btn size="sm" onPress={onCancel} testID="terminal-confirm-cancel">
        {t("common.cancel", { defaultValue: "Cancel" })}
      </Btn>
      <Btn
        size="sm"
        variant={confirm.kind === "watch" ? "primary" : "danger"}
        onPress={onConfirm}
        testID="terminal-confirm-ok"
      >
        {confirm.kind === "watch"
          ? t("terminal.window.watchOk", { defaultValue: "Let them watch" })
          : t("terminal.window.endSession", { defaultValue: "End session" })}
      </Btn>
    </View>
  )
}
