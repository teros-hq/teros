/**
 * useDevAutologin — on the sign-in screen, against a LOCAL backend running
 * with TEROS_DEV_AUTOLOGIN=1, sign in as the dev user with no form: probe the
 * backend, send `{type:"auth", method:"dev"}`, and store the normal
 * auth_success like any other login. Anything else (prod, flag off, an error)
 * ends in "off" and the sign-in screen renders as usual.
 */
import { useRouter } from "expo-router"
import { useEffect, useRef, useState } from "react"
import {
  isAutologinSuppressed,
  isLocalBackendUrl,
  probeDevAutologin,
} from "../../lib/dev-autologin"
import { getTerosClient } from "../../services/terosClientSingleton"
import { normalizeAuthUser, useAuthStore } from "../../store/authStore"
import { wsUrl as resolveWsUrl } from "../../config/runtime"

const SIGN_IN_TIMEOUT_MS = 10_000

export type DevAutologinStatus = "probing" | "signing-in" | "off"

type TerosClient = ReturnType<typeof getTerosClient>
type AuthSuccess = Parameters<typeof normalizeAuthUser>[0]

/**
 * Send the dev frame once the socket is up and wait for the normal
 * auth_success. `cancel` detaches every listener (unmount).
 */
function sendDevAuth(client: TerosClient, wsUrl: string | undefined) {
  let cancel = () => {}
  const promise = new Promise<AuthSuccess>((resolve, reject) => {
    const timer = setTimeout(() => fail("Dev auto-login timed out"), SIGN_IN_TIMEOUT_MS)
    const onAuthenticated = (data: unknown) => {
      cancel()
      resolve(data as AuthSuccess)
    }
    const fail = (err: unknown) => {
      cancel()
      reject(new Error(String(err || "Dev auto-login refused")))
    }
    const onConnected = () => {
      client.authenticateDev().catch(fail)
    }
    cancel = () => {
      clearTimeout(timer)
      client.off("authenticated", onAuthenticated)
      client.off("auth_error", fail)
      client.off("connected", onConnected)
    }
    client.on("authenticated", onAuthenticated)
    client.on("auth_error", fail)
    if (client.isConnected()) return onConnected()
    client.on("connected", onConnected)
    if (!client.isConnectedOrConnecting() && wsUrl) client.connect(wsUrl)
  })
  return { promise, cancel: () => cancel() }
}

/** `?noautologin` on the web shows the real sign-in screen against a dev backend. */
function optedOut(): boolean {
  return typeof window !== "undefined" && /[?&]noautologin\b/.test(window.location?.search ?? "")
}

export function useDevAutologin(enabled: boolean): DevAutologinStatus {
  const router = useRouter()
  const client = getTerosClient()
  const { login } = useAuthStore()
  const wsUrl = resolveWsUrl()
  // Decided synchronously: against a non-local backend (prod) the hook is inert
  // from the first render — no probe, no blank frame.
  // After a sign-out the form stays until the page is loaded anew (ALOGIN-REQ-7).
  const local = isLocalBackendUrl(wsUrl) && !optedOut() && !isAutologinSuppressed()
  const [status, setStatus] = useState<DevAutologinStatus>(local ? "probing" : "off")
  // Latest router/login without re-running the effect (it must run once per mount).
  const latest = useRef({ router, login })
  latest.current = { router, login }

  useEffect(() => {
    if (!enabled || !local) return
    let cancelled = false
    let detach = () => {}

    const finish = (data: AuthSuccess) => {
      if (cancelled) return
      const { user, sessionToken } = normalizeAuthUser(data)
      latest.current.login(user, sessionToken)
      client.setSessionToken(sessionToken)
      latest.current.router.replace("/")
    }
    const fallBack = (error: unknown) => {
      console.warn("[dev-autologin] falling back to the sign-in screen:", error)
      if (!cancelled) setStatus("off")
    }
    const run = async () => {
      const on = await probeDevAutologin(wsUrl)
      if (cancelled) return
      if (!on) return setStatus("off")
      setStatus("signing-in")
      const attempt = sendDevAuth(client, wsUrl)
      detach = attempt.cancel
      await attempt.promise.then(finish, fallBack)
    }
    void run()

    return () => {
      cancelled = true
      detach()
    }
  }, [enabled, local, wsUrl, client])

  return enabled && local ? status : "off"
}
