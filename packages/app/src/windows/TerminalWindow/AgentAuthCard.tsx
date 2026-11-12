/**
 * AgentAuthCard — how a coding agent (Claude Code first; Codex and opencode
 * share the plumbing) gets credentials, chosen in the Terminal window, not in
 * the TUI:
 *
 *   Use Teros            — only when one of the user's Teros providers can
 *                          serve the agent; nothing to set up.
 *   Sign in with Claude  — subscription (Pro/Max): opens the sign-in page in a
 *                          browser tab and takes the code here; Teros runs the
 *                          CLI flow privately and keeps the resulting token.
 *                          Start and finish return at once and the card polls
 *                          the sign-in's phase, so a first-time install or a
 *                          slow exchange never hits the request timeout, and
 *                          every failure stays on the card with its reason.
 *   API key              — pasted once, stored encrypted for this user.
 *
 * Credentials are the USER's (never the workspace's): they are injected only
 * into this user's sessions; Teros agents in the workspace get them only when
 * "Share with this workspace's agents" is on.
 */

import type { TFunction } from "i18next"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Linking, Platform, Pressable, TextInput, View } from "react-native"
import { useColors } from "../../components/mca/primitives/useColors"
import { Badge, Btn, IconBtn, Ph, T } from "../../components/ui/ds"
import { getTerosClient } from "../../services/terosClientSingleton"

export type CodingAgent = "claude" | "codex" | "opencode"

export interface AgentAuthStatus {
  agent: CodingAgent
  mode: "teros" | "subscription" | "apiKey" | null
  /** Chip text, e.g. "via Teros", "you@x.com (Max)", "API key ····abcd". */
  label: string | null
  teros: { available: boolean; label?: string }
  shared: boolean
}

/** A sign-in as the server reports it (terminal.agentAuthLogin*). */
interface LoginView {
  loginId: string
  phase: "starting" | "installing" | "ready" | "exchanging" | "done" | "failed"
  url?: string
  error?: { code: string; message: string }
  status?: AgentAuthStatus
}

const LOGIN_POLL_MS = 1000

const AGENT_NAMES: Record<CodingAgent, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "opencode",
}

interface Props {
  agent: CodingAgent
  workspaceId: string
  appId: string
  /** Why the card is up: before a first session, or because a session shows its login screen. */
  reason: "first-session" | "login-screen" | "change"
  /**
   * login-screen: the sign-in that session was started with (its chip text).
   * When it isn't the current one, the session simply predates it: the card
   * offers a new session instead of calling the current sign-in rejected.
   */
  sessionAuth?: string
  onDone: (status: AgentAuthStatus) => void
  onClose: () => void
}

function errorText(err: unknown, t: TFunction): string {
  if ((err as { code?: unknown } | null)?.code === "UNKNOWN_ACTION")
    return t("terminal.auth.backendOutdated", {
      defaultValue:
        "This server's backend is older than the app and can't do this yet. Restart or redeploy the backend, then try again.",
    })
  return err instanceof Error ? err.message : String(err)
}

export function AgentAuthCard({
  agent,
  workspaceId,
  appId,
  reason,
  sessionAuth,
  onDone,
  onClose,
}: Props) {
  const { t } = useTranslation()
  const c = useColors()
  const client = getTerosClient()
  const [status, setStatus] = useState<AgentAuthStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [login, setLogin] = useState<LoginView | null>(null)
  const [loginError, setLoginError] = useState<string | null>(null)
  /** The tab opened on click (before any await, so popup blockers allow it). */
  const popup = useRef<Window | null>(null)
  const [opened, setOpened] = useState(false)
  const [code, setCode] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [showKey, setShowKey] = useState(false)
  const liveLogin = useRef<string | null>(null)

  useEffect(() => {
    client
      ?.send("terminal", "agentAuthStatus", { agent, workspaceId })
      .then((s) => setStatus(s as AgentAuthStatus))
      .catch((err: unknown) => setError(errorText(err, t)))
  }, [client, agent, workspaceId, t])

  const closePopup = () => {
    try {
      popup.current?.close()
    } catch {
      /* intentional: the tab may already be gone or cross-origin */
    }
    popup.current = null
  }

  const openUrl = (url: string): boolean => {
    if (Platform.OS !== "web") {
      void Linking.openURL(url)
      return true
    }
    const tab = popup.current
    popup.current = null
    if (tab && !tab.closed) {
      tab.opener = null
      tab.location.href = url
      return true
    }
    return window.open(url, "_blank", "noopener,noreferrer") !== null
  }

  /** A sign-in that ended (failed or done): leave the card in its final state. */
  const settle = (view: LoginView) => {
    setLogin(null)
    setCode("")
    if (view.phase === "failed") {
      closePopup()
      setLoginError(view.error?.message ?? "Sign-in failed")
    } else if (view.status) {
      setStatus(view.status)
      onDone(view.status)
    }
  }

  // Follow the sign-in: poll while the server works, react when it lands.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to the server's view of the sign-in only
  useEffect(() => {
    if (!login || !client) return
    const ended = login.phase === "done" || login.phase === "failed"
    liveLogin.current = ended ? null : login.loginId
    if (ended) return settle(login)
    if (login.phase === "ready") {
      if (login.url && !opened) setOpened(openUrl(login.url))
      return
    }
    const timer = setTimeout(() => {
      client
        .send("terminal", "agentAuthLoginState", { loginId: login.loginId })
        .then((next) => setLogin(next as LoginView))
        .catch((err: unknown) =>
          settle({ ...login, phase: "failed", error: { code: "", message: errorText(err, t) } }),
        )
    }, LOGIN_POLL_MS)
    return () => clearTimeout(timer)
  }, [login, client])

  // Closing the card abandons a sign-in that is still going.
  // biome-ignore lint/correctness/useExhaustiveDependencies: unmount-only cleanup; liveLogin and popup are refs
  useEffect(
    () => () => {
      closePopup()
      if (liveLogin.current)
        client
          ?.send("terminal", "agentAuthLoginCancel", { loginId: liveLogin.current })
          .catch(() => {})
    },
    [client],
  )

  const run = async (what: string, fn: () => Promise<AgentAuthStatus | void>) => {
    setBusy(what)
    setError(null)
    try {
      const next = await fn()
      if (next) {
        setStatus(next)
        onDone(next)
      }
    } catch (err) {
      setError(errorText(err, t))
    } finally {
      setBusy(null)
    }
  }

  const useTeros = () =>
    run(
      "teros",
      async () =>
        (await client!.send("terminal", "agentAuthSet", {
          agent,
          workspaceId,
          mode: "teros",
        })) as AgentAuthStatus,
    )

  const startLogin = async () => {
    setLoginError(null)
    setOpened(false)
    setCode("")
    if (Platform.OS === "web") {
      const tab = window.open("", "_blank")
      try {
        if (tab) {
          tab.document.title = "Claude sign-in"
          tab.document.body.innerHTML =
            '<p style="font: 15px system-ui, sans-serif; padding: 24px">Preparing the Claude sign-in page…</p>'
        }
      } catch {
        /* intentional: some browsers hand back a tab whose document isn't writable yet */
      }
      popup.current = tab
    }
    setBusy("login")
    try {
      const res = (await client!.send("terminal", "agentAuthLoginStart", {
        agent,
        workspaceId,
        appId,
      })) as LoginView
      setLogin(res)
    } catch (err) {
      closePopup()
      setLoginError(errorText(err, t))
    } finally {
      setBusy(null)
    }
  }

  const finishLogin = async () => {
    if (!login || login.phase !== "ready" || !code.trim()) return
    setLoginError(null)
    setBusy("code")
    try {
      const res = (await client!.send("terminal", "agentAuthLoginFinish", {
        loginId: login.loginId,
        code: code.trim(),
      })) as LoginView
      setLogin(res)
    } catch (err) {
      setLoginError(errorText(err, t))
      setLogin(null)
      setCode("")
    } finally {
      setBusy(null)
    }
  }

  const saveKey = () =>
    run("key", async () => {
      const next = (await client!.send("terminal", "agentAuthSet", {
        agent,
        workspaceId,
        mode: "apiKey",
        apiKey: apiKey.trim(),
      })) as AgentAuthStatus
      setApiKey("")
      return next
    })

  const toggleShare = () =>
    run("share", async () => {
      const next = (await client!.send("terminal", "agentAuthShare", {
        agent,
        workspaceId,
        shared: !status?.shared,
      })) as AgentAuthStatus
      setStatus(next)
    })

  const signOut = () =>
    run("signout", async () => {
      const next = (await client!.send("terminal", "agentAuthSignOut", {
        agent,
        workspaceId,
      })) as AgentAuthStatus
      setStatus(next)
    })

  const name = AGENT_NAMES[agent]
  const field = {
    flex: 1,
    height: 36,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.field,
    color: c.text,
    fontFamily: "monospace",
    fontSize: 13,
  } as const

  const option = (
    key: string,
    icon: string,
    title: string,
    text: string,
    body: React.ReactNode,
    badge?: string,
  ) => (
    <View
      key={key}
      style={{
        padding: 14,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.bgCard,
        gap: 8,
      }}
      testID={`agent-auth-option-${key}`}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Ph name={icon} size={16} color={c.accent} />
        <T step="base" style={{ fontWeight: "600" }}>
          {title}
        </T>
        {badge ? (
          <Badge tone="g" sm>
            {badge}
          </Badge>
        ) : null}
      </View>
      <T step="sm" tone="text2">
        {text}
      </T>
      {body}
    </View>
  )

  const progress = (text: string) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Ph name="circle-notch" size={14} color={c.text3} />
      <T step="sm" tone="text2" testID="agent-auth-login-progress">
        {text}
      </T>
    </View>
  )

  const loginIdle = () => (
    <View style={{ gap: 8 }}>
      {loginError ? (
        <T step="sm" tone="danger" testID="agent-auth-login-error">
          {loginError}
        </T>
      ) : null}
      <Btn
        size="sm"
        loading={busy === "login"}
        onPress={startLogin}
        testID="agent-auth-login-start"
      >
        {loginError
          ? t("terminal.auth.loginRetry", { defaultValue: "Start the sign-in again" })
          : t("terminal.auth.loginCta", { defaultValue: "Sign in with Claude" })}
      </Btn>
    </View>
  )

  const loginCode = (view: LoginView) => {
    const url = view.url ?? ""
    const ready = view.phase === "ready"
    return (
      <View style={{ gap: 8 }}>
        {opened ? (
          <Pressable onPress={() => openUrl(url)} testID="agent-auth-open-url">
            <T step="sm" tone="accent">
              {t("terminal.auth.openAgain", { defaultValue: "Open the sign-in page again ↗" })}
            </T>
          </Pressable>
        ) : (
          <Btn
            size="sm"
            variant="primary"
            onPress={() => setOpened(openUrl(url))}
            testID="agent-auth-open-url"
          >
            {t("terminal.auth.openPage", { defaultValue: "Open the Claude sign-in page ↗" })}
          </Btn>
        )}
        <T step="sm" tone="text3">
          {t("terminal.auth.codeHint", {
            defaultValue:
              "Sign in there, then copy the code the page shows and paste it here. It works once, for a few minutes.",
          })}
        </T>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <TextInput
            value={code}
            onChangeText={setCode}
            placeholder={t("terminal.auth.codePlaceholder", {
              defaultValue: "Paste the code from the page",
            })}
            placeholderTextColor={c.text3}
            autoCapitalize="none"
            autoCorrect={false}
            editable={ready}
            style={field}
            testID="agent-auth-code"
            onSubmitEditing={finishLogin}
          />
          <Btn
            size="sm"
            variant="primary"
            loading={busy === "code" || !ready}
            disabled={!code.trim() || !ready}
            onPress={finishLogin}
            testID="agent-auth-code-submit"
          >
            {t("terminal.auth.finish", { defaultValue: "Finish" })}
          </Btn>
        </View>
        {ready
          ? null
          : progress(
              t("terminal.auth.loginExchanging", {
                defaultValue: "Checking the code with Claude…",
              }),
            )}
      </View>
    )
  }

  const loginBody = () => {
    if (!login) return loginIdle()
    if (login.phase === "starting")
      return progress(
        t("terminal.auth.loginStarting", { defaultValue: "Starting Claude Code's sign-in…" }),
      )
    if (login.phase === "installing")
      return progress(
        t("terminal.auth.loginInstalling", {
          defaultValue:
            "Installing Claude Code in this workspace (first time only, about a minute)…",
        }),
      )
    return loginCode(login)
  }

  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        backgroundColor: c.bgSheet,
      }}
      testID="agent-auth-card"
    >
      <View style={{ width: "100%", maxWidth: 560, gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Ph name="sparkle" size={20} color={c.accent} />
          <T step="xl" style={{ flex: 1 }}>
            {reason === "login-screen"
              ? t("terminal.auth.titleLogin", { defaultValue: "{{name}} needs to sign in", name })
              : t("terminal.auth.title", { defaultValue: "How should {{name}} sign in?", name })}
          </T>
          <IconBtn
            icon="x"
            plain
            sm
            title={t("common.close", { defaultValue: "Close" })}
            onPress={onClose}
          />
        </View>
        <T step="sm" tone="text3">
          {t("terminal.auth.privacy", {
            defaultValue:
              "These credentials are yours: Teros keeps them encrypted and injects them only into your own sessions. Nothing is written to the workspace's disk.",
          })}
        </T>

        {status?.mode && status.label ? (
          <View
            style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            testID="agent-auth-current"
          >
            <Badge tone="g" dot>
              {name} · {status.label}
            </Badge>
            <Pressable onPress={signOut} testID="agent-auth-signout">
              <T step="sm" tone="danger">
                {t("terminal.auth.signOut", { defaultValue: "Sign out" })}
              </T>
            </Pressable>
          </View>
        ) : null}

        {reason === "login-screen" && status?.mode && status.label ? (
          <LoginScreenNotice
            name={name}
            label={status.label}
            sessionAuth={sessionAuth}
            onReplace={() => onDone(status)}
          />
        ) : null}

        {status?.teros.available
          ? option(
              "teros",
              "lightning",
              t("terminal.auth.teros", { defaultValue: "Use Teros" }),
              t("terminal.auth.terosText", {
                defaultValue: "Runs through your Teros provider {{label}}. Nothing to set up.",
                label: status.teros.label ?? "",
              }),
              <Btn
                variant="primary"
                size="sm"
                loading={busy === "teros"}
                onPress={useTeros}
                testID="agent-auth-use-teros"
              >
                {t("terminal.auth.terosCta", { defaultValue: "Use Teros" })}
              </Btn>,
              t("terminal.auth.recommended", { defaultValue: "zero setup" }),
            )
          : null}

        {agent === "claude"
          ? option(
              "login",
              "sign-in",
              t("terminal.auth.login", { defaultValue: "Sign in with Claude" }),
              t("terminal.auth.loginText", {
                defaultValue:
                  "Pro or Max subscription. The sign-in page opens in a new tab; paste the code it gives you here.",
              }),
              loginBody(),
            )
          : null}

        {option(
          "key",
          "key",
          t("terminal.auth.key", { defaultValue: "Use an API key" }),
          agent === "claude"
            ? t("terminal.auth.keyTextClaude", {
                defaultValue: "An Anthropic API key (sk-ant-…), billed to your Anthropic account.",
              })
            : t("terminal.auth.keyText", { defaultValue: "An OpenAI API key for {{name}}.", name }),
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TextInput
              value={apiKey}
              onChangeText={setApiKey}
              placeholder={agent === "claude" ? "sk-ant-…" : "sk-…"}
              placeholderTextColor={c.text3}
              secureTextEntry={!showKey}
              autoCapitalize="none"
              autoCorrect={false}
              style={field}
              testID="agent-auth-key"
              onSubmitEditing={saveKey}
            />
            <IconBtn
              icon={showKey ? "eye-slash" : "eye"}
              plain
              sm
              onPress={() => setShowKey((v) => !v)}
            />
            <Btn
              size="sm"
              loading={busy === "key"}
              disabled={apiKey.trim().length < 20}
              onPress={saveKey}
              testID="agent-auth-key-save"
            >
              {t("terminal.auth.save", { defaultValue: "Save" })}
            </Btn>
          </View>,
        )}

        <Pressable
          onPress={toggleShare}
          style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}
          testID="agent-auth-share"
          disabled={!status?.mode}
        >
          <Ph
            name={status?.shared ? "check-square" : "square"}
            size={16}
            color={status?.mode ? c.text2 : c.text3}
          />
          <T step="sm" tone={status?.mode ? "text2" : "text3"}>
            {t("terminal.auth.share", {
              defaultValue:
                "Share with this workspace's agents (off: only your own sessions use it)",
            })}
          </T>
        </Pressable>

        {error ? (
          <T step="sm" tone="danger" testID="agent-auth-error">
            {error}
          </T>
        ) : null}
      </View>
    </View>
  )
}

/**
 * Why a session of this person shows Claude Code's login screen: the saved
 * sign-in was rejected, or the session simply started before it.
 */
function LoginScreenNotice({
  name,
  label,
  sessionAuth,
  onReplace,
}: {
  name: string
  label: string
  sessionAuth?: string
  onReplace: () => void
}) {
  const { t } = useTranslation()
  if (sessionAuth === undefined || sessionAuth === label) {
    return (
      <T step="sm" tone="danger" testID="agent-auth-rejected">
        {t("terminal.auth.rejected", {
          defaultValue:
            "{{name}} asked to sign in although it got your saved sign-in ({{label}}): it may have expired or been revoked. Sign in again or pick another option.",
          name,
          label,
        })}
      </T>
    )
  }
  return (
    <View style={{ gap: 8 }} testID="agent-auth-stale-session">
      <T step="sm" tone="text2">
        {t("terminal.auth.staleSession", {
          defaultValue:
            "This session started with an earlier sign-in ({{old}}). Your current one is {{label}}: open a new session to use it.",
          old: sessionAuth || t("terminal.auth.none", { defaultValue: "not signed in" }),
          label,
        })}
      </T>
      <Btn size="sm" variant="primary" onPress={onReplace} testID="agent-auth-replace-session">
        {t("terminal.auth.replaceSession", {
          defaultValue: "Open a new session as {{label}}",
          label,
        })}
      </Btn>
    </View>
  )
}
