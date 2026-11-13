/**
 * Sign-in methods offered by the backend (spec SIGNM).
 */
import { afterEach, describe, expect, it } from "bun:test"
import {
  _resetSignInMethodsForTests,
  enableSocialSignIn,
  getSignInMethods,
} from "../../src/auth/sign-in-methods"

afterEach(() => _resetSignInMethodsForTests())

describe("sign-in methods", () => {
  it("[SIGNM-AC-1] with no social provider initialised only password is offered", () => {
    expect(getSignInMethods()).toEqual({
      password: true,
      google: false,
      github: false,
      microsoft: false,
    })
  })

  it("[SIGNM-AC-2] a provider is offered once its sign-in was initialised, the others stay off", () => {
    enableSocialSignIn("microsoft")
    expect(getSignInMethods()).toEqual({
      password: true,
      google: false,
      github: false,
      microsoft: true,
    })
    enableSocialSignIn("google")
    enableSocialSignIn("github")
    expect(getSignInMethods()).toEqual({
      password: true,
      google: true,
      github: true,
      microsoft: true,
    })
  })

  it("[SIGNM-AC-3] the answer carries the four flags and nothing else", () => {
    enableSocialSignIn("google")
    expect(Object.keys(getSignInMethods()).sort()).toEqual([
      "github",
      "google",
      "microsoft",
      "password",
    ])
    for (const value of Object.values(getSignInMethods())) expect(typeof value).toBe("boolean")
  })
})
