/**
 * The provider buttons of the sign-in screens follow what the backend offers
 * (spec SIGNM).
 *
 *   cd packages/app && npx vitest run src/components/auth/SocialSignIn.render.test.tsx
 */
import "../../i18n"
import { fireEvent, render } from "@testing-library/react"
import { TamaguiProvider } from "tamagui"
import { describe, expect, it, vi } from "vitest"
import config from "../../../tamagui.config"
import {
  enabledSocialProviders,
  fetchSignInMethods,
  PASSWORD_ONLY,
  type SignInMethods,
} from "../../lib/sign-in-methods"
import { SocialSignIn } from "./SocialSignIn"

const offer = (over: Partial<SignInMethods>): SignInMethods => ({ ...PASSWORD_ONLY, ...over })

function mount(methods: SignInMethods | null) {
  const onPress = { google: vi.fn(), github: vi.fn(), microsoft: vi.fn() }
  const view = render(
    <TamaguiProvider config={config} defaultTheme="light">
      <SocialSignIn methods={methods} onPress={onPress} testIDPrefix="login" />
    </TamaguiProvider>,
  )
  // Read from this render's own container: a test may mount more than once.
  const ids = ["login-google", "login-github", "login-microsoft"].filter((id) =>
    view.container.querySelector(`[data-testid="${id}"]`),
  )
  return { view, onPress, ids }
}

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
    })) as unknown as typeof fetch
}

describe("SocialSignIn", () => {
  it("[SIGNM-AC-4] draws a button only for the providers offered, in the order Google, GitHub, Microsoft", () => {
    expect(mount(offer({ microsoft: true, google: true })).ids).toEqual([
      "login-google",
      "login-microsoft",
    ])
    expect(mount(offer({ github: true })).ids).toEqual(["login-github"])
    expect(enabledSocialProviders(offer({ microsoft: true, github: true, google: true }))).toEqual([
      "google",
      "github",
      "microsoft",
    ])
  })

  it("[SIGNM-AC-4] a button starts the sign-in of its own provider", () => {
    const { view, onPress } = mount(offer({ github: true, microsoft: true }))
    fireEvent.click(view.getByTestId("login-microsoft"))
    expect(onPress.microsoft).toHaveBeenCalledTimes(1)
    expect(onPress.github).not.toHaveBeenCalled()
    expect(onPress.google).not.toHaveBeenCalled()
  })

  it("[SIGNM-AC-5] one provider is a single wide button that says Continue with <provider>", () => {
    const { view, ids } = mount(offer({ github: true }))
    expect(ids).toEqual(["login-github"])
    expect(view.getByTestId("login-github").textContent).toContain("Continue with GitHub")
  })

  it("[SIGNM-AC-5] two providers share one row with their short names", () => {
    const { view } = mount(offer({ google: true, microsoft: true }))
    const google = view.getByTestId("login-google")
    const microsoft = view.getByTestId("login-microsoft")
    expect(google.textContent).toBe("Google")
    expect(microsoft.textContent).toBe("Microsoft")
    expect(google.parentElement).toBe(microsoft.parentElement)
  })

  it("[SIGNM-AC-5] three providers: Google wide on its own, GitHub and Microsoft in one row", () => {
    const { view } = mount(offer({ google: true, github: true, microsoft: true }))
    const google = view.getByTestId("login-google")
    const github = view.getByTestId("login-github")
    const microsoft = view.getByTestId("login-microsoft")
    expect(google.textContent).toContain("Continue with Google")
    expect(github.textContent).toBe("GitHub")
    expect(github.parentElement).toBe(microsoft.parentElement)
    expect(google.parentElement).not.toBe(github.parentElement)
  })

  it("[SIGNM-AC-6] with no provider offered there are no buttons and no divider", () => {
    const { view, ids } = mount(PASSWORD_ONLY)
    expect(ids).toEqual([])
    expect(view.queryByTestId("login-providers")).toBeNull()
    expect(view.queryByText("or with your email")).toBeNull()
  })

  it("[SIGNM-AC-6] with a provider offered the divider follows the buttons", () => {
    const { view } = mount(offer({ google: true }))
    expect(view.queryByText("or with your email")).not.toBeNull()
  })

  it("[SIGNM-AC-7] until the backend answers nothing is drawn", () => {
    const { view, ids } = mount(null)
    expect(ids).toEqual([])
    expect(view.queryByText("or with your email")).toBeNull()
  })
})

describe("fetchSignInMethods", () => {
  it("[SIGNM-AC-4] asks GET <backend>/api/auth-methods and returns what the backend offers", async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(url)
      return new Response(
        JSON.stringify({ password: true, google: true, github: false, microsoft: true }),
      )
    }) as unknown as typeof fetch
    expect(await fetchSignInMethods("http://localhost:10001/", fetchImpl)).toEqual(
      offer({ google: true, microsoft: true }),
    )
    expect(calls).toEqual(["http://localhost:10001/api/auth-methods"])
  })

  it("[SIGNM-AC-7] any failure means email and password only", async () => {
    const boom = (async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch
    expect(await fetchSignInMethods("http://localhost:10001", boom)).toEqual(PASSWORD_ONLY)
    expect(await fetchSignInMethods("http://localhost:10001", jsonFetch(404, "not found"))).toEqual(
      PASSWORD_ONLY,
    )
    expect(await fetchSignInMethods("http://localhost:10001", jsonFetch(200, "<html>"))).toEqual(
      PASSWORD_ONLY,
    )
    expect(await fetchSignInMethods(undefined, boom)).toEqual(PASSWORD_ONLY)
  })

  it("[SIGNM-AC-7] only an explicit true turns a provider on", async () => {
    const odd = jsonFetch(200, { google: "yes", github: 1, microsoft: true })
    expect(await fetchSignInMethods("http://localhost:10001", odd)).toEqual(
      offer({ microsoft: true }),
    )
  })
})
