import { useEffect, useState } from "react"
import { Platform } from "react-native"
import { getTerosClient } from "../../services/terosClientSingleton"

/**
 * Finish a redirect-based card setup (3DS / SCA). Stripe.js sends the browser
 * back to `return_url` with `setup_intent`, `setup_intent_client_secret` and
 * `redirect_status` in the query string. The inline `handleSave` never ran its
 * second half, so we hand the id to the backend, which reads the intent from
 * Stripe and stores the payment method. Runs once per page load; the query
 * params are removed afterwards so a reload does not replay it.
 */
export function useStripeSetupReturn(onDone: (result: "succeeded" | "failed" | "none") => void) {
  const client = getTerosClient()
  const [handled, setHandled] = useState(false)
  useEffect(() => {
    if (handled || Platform.OS !== "web" || typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    const setupIntentId = params.get("setup_intent")
    const status = params.get("redirect_status")
    if (!setupIntentId) return
    setHandled(true)
    const clean = () => {
      for (const k of ["setup_intent", "setup_intent_client_secret", "redirect_status"]) params.delete(k)
      const q = params.toString()
      window.history.replaceState(null, "", `${window.location.pathname}${q ? `?${q}` : ""}${window.location.hash}`)
    }
    if (status !== "succeeded") {
      clean()
      onDone("failed")
      return
    }
    client.billing
      .completeSetupIntent(setupIntentId)
      .then(() => onDone("succeeded"))
      .catch(() => onDone("failed"))
      .finally(clean)
    // client is a stable module singleton — intentionally not a dependency.
  }, [handled, onDone])
}

