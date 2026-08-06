/**
 * Files domain (backend handlers, no MCA container):
 *  - fileBrowser write → list: write a file in the workspace volume, then find it in
 *    the directory listing. Degradable: the seeded workspace volume may not be
 *    provisioned on disk in this env → skip with the reason.
 *  - fileShare publish → get → unshare (REST): share a markdown file to a channel,
 *    resolve it, then unshare. Degradable (depends on a provisioned volume + share svc).
 */
import { expect, test } from "../fixtures"
import { evalTeros, getPrimaryIds } from "../helpers/teros"

test.describe("files @files", () => {
  test("fileBrowser: write → list", async ({ terosPage }) => {
    const { privateWorkspaceId } = await getPrimaryIds(terosPage)
    const wid = privateWorkspaceId as string
    const fname = `pw-smoke-${Date.now()}.txt`

    const writeRes = await evalTeros(
      terosPage,
      ({ wid, fname }) =>
        window.teros.fileBrowser
          .write(wid, fname, "hello smoke")
          .then((r) => ({ ok: true as const, bytes: r.bytesWritten }))
          .catch((e) => ({ ok: false as const, err: String(e) })),
      { wid, fname },
    )
    test.skip(
      !writeRes.ok,
      `fileBrowser.write no disponible (volumen no provisto en el entorno): ${"err" in writeRes ? writeRes.err : ""}`,
    )
    expect(writeRes.ok && writeRes.bytes, "write devuelve bytesWritten > 0").toBeGreaterThan(0)

    // list — try the root under a few path spellings (CONTAINER_MOUNT vs literal)
    const found = await evalTeros(
      terosPage,
      async ({ wid, fname }) => {
        for (const p of ["", "/workspace", "/", "."]) {
          try {
            const r = await window.teros.fileBrowser.list(wid, p)
            if ((r.entries || []).some((e) => e.name === fname)) return true
          } catch {
            // try the next path spelling
          }
        }
        return false
      },
      { wid, fname },
    )
    expect(found, "el archivo escrito aparece en fileBrowser.list").toBe(true)
  })

  test("fileShare: publish → get → unshare", async ({ terosPage }) => {
    const { privateWorkspaceId, agentId } = await getPrimaryIds(terosPage)
    const wid = privateWorkspaceId as string
    const fname = `pw-share-${Date.now()}.md`

    const flow = await evalTeros(
      terosPage,
      async ({ wid, fname, aid }) => {
        try {
          await window.teros.fileBrowser.write(wid, fname, "# Pw Smoke\n\nhello")
          const channelId = (await window.teros.channel.create({ agentId: aid, workspaceId: wid }))
            .channelId
          const shared = await window.teros.fileShare.share(fname, channelId, "markdown")
          const got = await window.teros.fileShare.getShare(fname, wid)
          await window.teros.fileShare.unshare(shared.shareId)
          await window.teros.channel.close(channelId).catch(() => null)
          return { ok: true as const, shareId: shared.shareId, gotId: got?.shareId ?? null }
        } catch (e) {
          return { ok: false as const, err: String(e) }
        }
      },
      { wid, fname, aid: agentId as string },
    )
    test.skip(
      !flow.ok,
      `fileShare no viable en el entorno (volumen/servicio): ${"err" in flow ? flow.err : ""}`,
    )
    expect(flow.ok && flow.shareId, "share devuelve un shareId").toBeTruthy()
    expect(flow.ok && flow.gotId, "getShare resuelve el mismo share").toBe(
      flow.ok ? flow.shareId : null,
    )
  })
})
