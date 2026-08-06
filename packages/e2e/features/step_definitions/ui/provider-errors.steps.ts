import { Given, Then, When } from "@cucumber/cucumber"
import { expect } from "chai"
import type { WebSocketRoute } from "playwright"
import type { UIWorld } from "../../support/world.ui"

/**
 * Provider-error UI steps (TER-697/TER-699).
 *
 * The failing turn is induced by intercepting the app's WebSocket
 * (Playwright routeWebSocket): every real frame is passed through, and when a
 * scenario asks for a failure we inject the exact classified `error` message the
 * backend's handleAgentError broadcasts — same shape the seam test asserts. The
 * REAL app then renders the REAL ProviderErrorWidget, so this exercises the
 * browser layer (testIDs `provider-error-card-{transient|persistent}`,
 * `provider-error-retry`, `provider-error-change-model`).
 *
 * The literal upstream text used for the "never shown raw" assertion.
 */
const UPSTREAM_LITERAL = "429 rate limit exceeded, please try again later"

interface ErrorState {
  wsRoute?: WebSocketRoute
  channelId?: string
  agentId?: string
}

function state(world: UIWorld): ErrorState {
  const w = world as unknown as { _providerError?: ErrorState }
  if (!w._providerError) w._providerError = {}
  return w._providerError
}

Given("I am signed in with an open chat", async function (this: UIWorld) {
  const st = state(this)

  // Register the WS interceptor BEFORE the app connects. Pass every frame
  // through untouched, but snoop the traffic to learn the active channel/agent
  // so the injected error targets the chat the user is looking at.
  await this.page!.routeWebSocket(/\/ws/, (ws) => {
    st.wsRoute = ws
    const server = ws.connectToServer()
    ws.onMessage((m) => server.send(m))
    server.onMessage((m) => {
      try {
        const parsed = JSON.parse(typeof m === "string" ? m : m.toString())
        const chId = parsed?.channelId ?? parsed?.message?.channelId
        if (typeof chId === "string" && chId.startsWith("ch_")) st.channelId = chId
        const agId = parsed?.message?.agentId ?? parsed?.agentId
        if (typeof agId === "string") st.agentId = agId
      } catch {
        // non-JSON frame — ignore
      }
      ws.send(m)
    })
  })

  // Sign in (mirrors features/ui/login.feature).
  await this.page!.goto(this.getFrontendUrl())
  await this.page!.waitForSelector("text=TEROS", { timeout: 15000 })
  await this.page!.click("text=Sign in with email")
  await this.page!.fill('input[autocomplete="email"]', "user@teros.ai")
  await this.page!.fill('input[autocomplete="current-password"]', "userpass")
  await this.page!.click("text=Sign in")
  await this.page!.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 })

  // Open (or create) a chat so a channelId exists to target. The app's default
  // workspace view surfaces the composer; sending a message anchors a channel.
  await this.page!.waitForSelector("textarea, input[placeholder]", { timeout: 15000 })
  await this.page!.fill("textarea, input[placeholder]", "Hello")
  await this.page!.keyboard.press("Enter")
  // Give the WS a moment to round-trip the channel id.
  await this.page!.waitForTimeout(2000)
  expect(st.channelId, "no channelId captured from the WS traffic").to.be.a("string")
})

When(
  "the agent turn fails with a {string} {string} upstream error",
  async function (this: UIWorld, errorClass: string, errorSubReason: string) {
    const st = state(this)
    expect(st.wsRoute, "WS route not intercepted").to.exist
    expect(st.channelId, "no channel to target").to.be.a("string")

    const isRate = errorClass === "rate_limited" || errorClass === "overloaded"
    const context: Record<string, unknown> = {
      errorClass,
      errorSubReason,
      upstreamMessage: UPSTREAM_LITERAL,
      source: "Fireworks",
      recoverable: true,
      i18nKey: "errors.normalized.rateLimit",
    }
    if (isRate) {
      context.isRateLimit = true
      context.retryAfterSecs = 30
      context.retryAfterMs = 30000
      context.resetAt = Date.now() + 30000
    }

    // Inject the exact `error` message handleAgentError broadcasts.
    st.wsRoute!.send(
      JSON.stringify({
        type: "message",
        channelId: st.channelId,
        message: {
          messageId: `msg_e2e_${Date.now()}`,
          channelId: st.channelId,
          role: "assistant",
          sender: "agent",
          agentId: st.agentId ?? "agent_e2e",
          content: {
            type: "error",
            errorType: "llm",
            userMessage: "The service is very busy. Please try again in a few seconds.",
            technicalMessage: `Fireworks error: ${UPSTREAM_LITERAL}`,
            context,
          },
          timestamp: new Date().toISOString(),
        },
      }),
    )
  },
)

Then("I see a {string} provider-error card", async function (this: UIWorld, variant: string) {
  await this.page!.waitForSelector(`[data-testid="provider-error-card-${variant}"]`, {
    timeout: 10000,
  })
})

Then("the card offers {string}", async function (this: UIWorld, action: string) {
  const testId = action === "Retry" ? "provider-error-retry" : "provider-error-change-model"
  await this.page!.waitForSelector(`[data-testid="${testId}"]`, { timeout: 5000 })
})

Then("the card does not offer {string}", async function (this: UIWorld, action: string) {
  const testId = action === "Retry" ? "provider-error-retry" : "provider-error-change-model"
  const count = await this.page!.locator(`[data-testid="${testId}"]`).count()
  expect(count, `${action} button should be absent`).to.equal(0)
})

Then("the raw upstream text is not visible in the card", async function (this: UIWorld) {
  const bodyText = await this.page!.locator('[data-testid^="provider-error-card-"]')
    .first()
    .innerText()
  expect(bodyText).to.not.contain(UPSTREAM_LITERAL)
})
