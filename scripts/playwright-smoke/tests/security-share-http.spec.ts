/**
 * Negative authz — share.create over the WS `share` domain (FileShareApi).
 *
 * TER-480 / #172 added the workspace gate to the WS path (file.share →
 * resolveAuthorizedWorkspace). 2026-10-21: the REST /api/share endpoints were
 * REMOVED (WS-first architecture rule) and share management moved to the WS
 * `share` domain (share.create/get/revoke), which keeps the same gate —
 * resolveAuthorizedWorkspace → canAccessWorkspace.
 *
 * A stranger could otherwise publish a file from a FOREIGN workspace by passing
 * someone else's channelId → cross-workspace exfiltration (IDOR). This spec
 * now exercises the only remaining share path (the WS domain the UI uses).
 * Strong shape: owner-OK rules out a not-found denial; user2's denial is
 * unambiguously the authz gate.
 *
 * Mutation check: remove the `canAccessWorkspace` gate in share/index.ts →
 * user2's share resolves → the `stranger.ok === false` assertion goes red.
 */
import { expect, test } from "../fixtures"
import { evalTeros, getPrimaryIds } from "../helpers/teros"

/** share.create via the real client (WS); captures success vs rejection. */
function attemptShare(
  page: import("@playwright/test").Page,
  filePath: string,
  channelId: string,
): Promise<{ ok: boolean; err: string | null }> {
  return evalTeros(
    page,
    async ({ fp, cid }) => {
      try {
        await window.teros.fileShare.share(fp, cid, "html")
        return { ok: true, err: null }
      } catch (e) {
        return { ok: false, err: String((e as { message?: string })?.message ?? e) }
      }
    },
    { fp: filePath, cid: channelId },
  )
}

test.describe("security — share.create (WS) cross-workspace @security", () => {
  test("user2 no puede publicar un archivo del workspace de user1 vía share.create", async ({
    terosPage,
    user2Page,
  }) => {
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    expect(agentId, "agentId de user1").toBeTruthy()
    const channelId = await evalTeros(
      terosPage,
      ({ aid, wid }) =>
        window.teros.channel.create({ agentId: aid, workspaceId: wid }).then((r) => r.channelId),
      { aid: agentId, wid: privateWorkspaceId },
    )
    expect(channelId, "canal de user1").toMatch(/^ch_[0-9a-f]{16}$/)
    const ownerFile = `/sec-share-${Date.now()}.html`
    try {
      // Sanity: el dueño SÍ puede publicar en su propio canal — el path funciona y la
      // denegación de user2 no será un falso "not found".
      const owner = await attemptShare(terosPage, ownerFile, channelId)
      expect(owner.ok, "el owner (user1) SÍ comparte en su propio canal").toBe(true)

      // Mordida: user2 NO es miembro del workspace privado de user1 → denegado.
      const stranger = await attemptShare(user2Page, `/intruso-${Date.now()}.html`, channelId)
      expect(
        stranger.ok,
        `user2 NO debe poder publicar en el workspace de user1 (IDOR share.create). err=${stranger.err}`,
      ).toBe(false)
    } finally {
      await evalTeros(
        terosPage,
        async (fp) => {
          try {
            const s = await window.teros.fileShare.getShare(fp)
            if (s?.shareId) await window.teros.fileShare.unshare(s.shareId)
          } catch {
            /* best-effort */
          }
        },
        ownerFile,
      )
      await evalTeros(terosPage, (id) => window.teros.channel.close(id).catch(() => null), channelId)
    }
  })
})
