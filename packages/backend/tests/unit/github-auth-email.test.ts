/**
 * GitHubAuth.getUserInfo email resolution (SEC-1, part 3).
 *
 * The verified flag only exists in /user/emails, so it must come from there —
 * a public profile email used to be assumed verified.
 */

import { afterEach, describe, expect, it, mock } from "bun:test"
import { GitHubAuth } from "../../src/auth/github-auth"

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function stubGitHub(
  profileEmail: string | null,
  emails: Array<{ email: string; primary: boolean; verified: boolean }>,
) {
  globalThis.fetch = mock((url: string | URL) => {
    const body = String(url).endsWith("/user/emails")
      ? emails
      : { id: 7, login: "dana", name: "Dana", avatar_url: "https://avatars/7", email: profileEmail }
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
  }) as unknown as typeof fetch
}

const github = () =>
  new GitHubAuth({ collection: () => ({}) } as never, {
    clientId: "id",
    clientSecret: "secret",
    redirectUri: "http://localhost/cb",
  })

describe("GitHubAuth.getUserInfo", () => {
  it("reads the verified flag of the public profile email from /user/emails", async () => {
    stubGitHub("Dana@Example.com", [
      { email: "dana@example.com", primary: false, verified: false },
      { email: "dana@work.com", primary: true, verified: true },
    ])

    const info = await github().getUserInfo("tok")

    expect(info.email).toBe("dana@example.com")
    expect(info.email_verified).toBe(false)
  })

  it("uses the primary verified email when the profile email is private", async () => {
    stubGitHub(null, [
      { email: "old@example.com", primary: false, verified: true },
      { email: "dana@example.com", primary: true, verified: true },
    ])

    const info = await github().getUserInfo("tok")

    expect(info.email).toBe("dana@example.com")
    expect(info.email_verified).toBe(true)
  })

  it("reports an unverified primary email as unverified", async () => {
    stubGitHub(null, [{ email: "dana@example.com", primary: true, verified: false }])

    const info = await github().getUserInfo("tok")

    expect(info.email_verified).toBe(false)
  })

  it("fails when GitHub returns no email at all", async () => {
    stubGitHub(null, [])

    await expect(github().getUserInfo("tok")).rejects.toThrow("did not return any email")
  })
})
