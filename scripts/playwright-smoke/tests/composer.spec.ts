/**
 * Chat composer (InputComposer.web.tsx) — the FIRST UI-interaction spec of the suite.
 * What only a real browser can validate: typing in the native textarea, Enter-to-send,
 * drafts that survive a reload (keyed by channelId), and the native file chooser.
 *
 * Carril: data setup via window.teros (create/rename/open channel); the composer itself
 * is driven through the real UI. Selectors are stable testIDs added to the composer
 * (composer-input / composer-attach / composer-send) — RN-Web buttons are icon-only
 * <button class="is_Button"> with no text/aria, so testID is the robust anchor.
 */
import { join } from "node:path"
import { expect, test } from "../fixtures"
import { evalTeros, getPrimaryIds } from "../helpers/teros"

const FIXTURE = join(__dirname, "../fixtures/sample.txt")
const FIXTURE2 = join(__dirname, "../fixtures/sample2.txt")

/** Creates a channel, names it, opens it via the sidebar (→ /chat/<id>), waits for the composer. */
async function openChat(
  // biome-ignore lint/suspicious/noExplicitAny: Playwright Page
  page: any,
  agentId: string,
  workspaceId: string,
  label: string,
): Promise<string> {
  const channelId = await evalTeros(
    page,
    async ({ aid, wid, label }) => {
      const r = await window.teros.channel.create({ agentId: aid, workspaceId: wid })
      await window.teros.channel.rename(r.channelId, label)
      return r.channelId
    },
    { aid: agentId, wid: workspaceId, label },
  )
  await page.waitForTimeout(2000) // let the sidebar receive the realtime channel
  await page.getByText(label, { exact: false }).first().click({ timeout: 10_000 })
  await page.waitForURL(`**/chat/${channelId}`, { timeout: 10_000 })
  await page.getByTestId("composer-input").waitFor({ state: "visible", timeout: 10_000 })
  return channelId
}

test.describe("composer @composer", () => {
  test("escribir y enviar con Enter → el mensaje aparece en el chat @llm", async ({
    terosPage,
  }) => {
    test.setTimeout(60_000)
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    const channelId = await openChat(
      terosPage,
      agentId as string,
      privateWorkspaceId as string,
      `PWsend${Date.now()}`,
    )

    // Texto FIJO (sin Date.now()): el canal es fresco, así que la unicidad para
    // la UI ya está; y el replay @llm hashea el texto del mensaje → debe ser
    // determinista para hacer match con la cassette. TER-563.
    const msg = "PW PING"
    const input = terosPage.getByTestId("composer-input")
    await input.fill(msg)
    // send button surfaces once there's content (rightButton = send when hasInputContent)
    await expect(terosPage.getByTestId("composer-send")).toBeVisible()
    await input.press("Enter")

    // the user's message bubble renders in the chat, and the composer clears
    await expect(terosPage.getByText(msg, { exact: false })).toBeVisible({ timeout: 10_000 })
    await expect(input).toHaveValue("")

    // it really went through the WS (not just an optimistic bubble)
    const sent = await evalTeros(
      terosPage,
      ({ cid, msg }) =>
        window.teros.channel
          .getMessages(cid)
          .then((r) =>
            (r.messages || []).some((m) => m.role === "user" && m.content?.text === msg),
          ),
      { cid: channelId, msg },
    )
    expect(sent, "el mensaje del usuario está persistido en el canal").toBe(true)

    await evalTeros(terosPage, (cid) => window.teros.channel.close(cid).then(() => null), channelId)
  })

  test("el borrador persiste al recargar (indexado por channelId)", async ({ terosPage }) => {
    test.setTimeout(60_000)
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    const label = `PWdraft${Date.now()}`
    const channelId = await openChat(
      terosPage,
      agentId as string,
      privateWorkspaceId as string,
      label,
    )

    const draft = `borrador ${Date.now()}`
    await terosPage.getByTestId("composer-input").fill(draft)
    await terosPage.waitForTimeout(900) // debounced save (500ms)

    await terosPage.reload({ waitUntil: "networkidle" })
    await terosPage.waitForTimeout(2500)
    // the tiling state restores the chat window; if not, re-open it via the sidebar
    if (!terosPage.url().includes(`/chat/${channelId}`)) {
      await terosPage
        .getByText(label, { exact: false })
        .first()
        .click({ timeout: 10_000 })
        .catch(() => null)
    }
    const input = terosPage.getByTestId("composer-input")
    await input.waitFor({ state: "visible", timeout: 15_000 })
    await expect(input, "el borrador se restauró tras recargar").toHaveValue(draft, {
      timeout: 10_000,
    })

    // clean up the draft so it doesn't leak into later runs
    await input.fill("")
    await terosPage.waitForTimeout(700)
    await evalTeros(terosPage, (cid) => window.teros.channel.close(cid).then(() => null), channelId)
  })

  test("el borrador NO se arrastra entre canales", async ({ terosPage }) => {
    test.setTimeout(60_000)
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    const aid = agentId as string
    const wid = privateWorkspaceId as string

    const chA = await openChat(terosPage, aid, wid, `PWxA${Date.now()}`)
    await terosPage.getByTestId("composer-input").fill(`solo en A ${Date.now()}`)
    await terosPage.waitForTimeout(900)

    const chB = await openChat(terosPage, aid, wid, `PWxB${Date.now()}`)
    await expect(
      terosPage.getByTestId("composer-input"),
      "el canal B arranca con el composer vacío",
    ).toHaveValue("")

    // cleanup both
    await terosPage.getByTestId("composer-input").fill("")
    await evalTeros(
      terosPage,
      async ({ a, b }) => {
        await window.teros.channel.close(a).catch(() => null)
        await window.teros.channel.close(b).catch(() => null)
      },
      { a: chA, b: chB },
    )
  })

  test("adjuntar un archivo con el file chooser nativo", async ({ terosPage }) => {
    test.setTimeout(60_000)
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    const channelId = await openChat(
      terosPage,
      agentId as string,
      privateWorkspaceId as string,
      `PWfile${Date.now()}`,
    )

    const [chooser] = await Promise.all([
      terosPage.waitForEvent("filechooser"),
      terosPage.getByTestId("composer-attach").click(),
    ])
    await chooser.setFiles(FIXTURE)

    // the attachment chip renders the filename, and send surfaces (hasFileAttachment)
    await expect(terosPage.getByText("sample.txt", { exact: false })).toBeVisible({
      timeout: 10_000,
    })
    await expect(terosPage.getByTestId("composer-send")).toBeVisible()

    await evalTeros(terosPage, (cid) => window.teros.channel.close(cid).then(() => null), channelId)
  })

  // ── Corner cases (donde viven los bugs) ──────────────────────────────────────

  test("texto en blanco no envía ni ofrece Send", async ({ terosPage }) => {
    test.setTimeout(60_000)
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    const channelId = await openChat(
      terosPage,
      agentId as string,
      privateWorkspaceId as string,
      `PWblank${Date.now()}`,
    )
    const input = terosPage.getByTestId("composer-input")
    await input.fill("   ") // solo espacios → hasText=false (trim)

    // el botón primario sigue siendo mic, no send (hasInputContent = trim-based)
    await expect(terosPage.getByTestId("composer-send")).toHaveCount(0)
    await input.press("Enter")

    // no se envió nada al canal
    await terosPage.waitForTimeout(1500)
    const userMsgs = await evalTeros(
      terosPage,
      (cid) =>
        window.teros.channel
          .getMessages(cid)
          .then((r) => (r.messages || []).filter((m) => m.role === "user").length),
      channelId,
    )
    expect(userMsgs, "un texto en blanco no debe enviarse").toBe(0)

    await evalTeros(terosPage, (cid) => window.teros.channel.close(cid).then(() => null), channelId)
  })

  test("Shift+Enter inserta salto de línea y NO envía", async ({ terosPage }) => {
    test.setTimeout(60_000)
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    const channelId = await openChat(
      terosPage,
      agentId as string,
      privateWorkspaceId as string,
      `PWshift${Date.now()}`,
    )
    const input = terosPage.getByTestId("composer-input")
    await input.fill("linea uno")
    await input.press("Shift+Enter")
    await input.type("linea dos")

    // el composer conserva el texto multilínea (no se vació) y NO envió
    await expect(input).toHaveValue("linea uno\nlinea dos")
    await terosPage.waitForTimeout(1200)
    const userMsgs = await evalTeros(
      terosPage,
      (cid) =>
        window.teros.channel
          .getMessages(cid)
          .then((r) => (r.messages || []).filter((m) => m.role === "user").length),
      channelId,
    )
    expect(userMsgs, "Shift+Enter no debe enviar el mensaje").toBe(0)

    // limpiar el borrador que dejó el texto
    await input.fill("")
    await terosPage.waitForTimeout(700)
    await evalTeros(terosPage, (cid) => window.teros.channel.close(cid).then(() => null), channelId)
  })

  test("el borrador se limpia al enviar (no reaparece al recargar) @llm", async ({ terosPage }) => {
    test.setTimeout(60_000)
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    const label = `PWsent${Date.now()}`
    const channelId = await openChat(
      terosPage,
      agentId as string,
      privateWorkspaceId as string,
      label,
    )
    const input = terosPage.getByTestId("composer-input")
    await input.fill("enviar y olvidar") // texto fijo para el replay @llm (TER-563)
    await terosPage.waitForTimeout(900) // el borrador se persiste (debounce)
    await input.press("Enter")
    await expect(input).toHaveValue("", { timeout: 10_000 }) // enviado → composer vacío

    await terosPage.reload({ waitUntil: "networkidle" })
    await terosPage.waitForTimeout(2500)
    if (!terosPage.url().includes(`/chat/${channelId}`)) {
      await terosPage
        .getByText(label, { exact: false })
        .first()
        .click({ timeout: 10_000 })
        .catch(() => null)
    }
    const input2 = terosPage.getByTestId("composer-input")
    await input2.waitFor({ state: "visible", timeout: 15_000 })
    // el borrador NO debe reaparecer: al enviar se borró del storage
    await expect(input2, "el borrador enviado no reaparece tras recargar").toHaveValue("")

    await evalTeros(terosPage, (cid) => window.teros.channel.close(cid).then(() => null), channelId)
  })

  test("con un turno en curso aparece Stop y permite cortar @llm", async ({ terosPage }) => {
    test.setTimeout(60_000)
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    const channelId = await openChat(
      terosPage,
      agentId as string,
      privateWorkspaceId as string,
      `PWstop${Date.now()}`,
    )
    const input = terosPage.getByTestId("composer-input")
    await input.fill("Cuenta del 1 al 40 despacio, un número por línea.")
    await input.press("Enter")

    // mientras el agente genera, el StopButton (aria-label, lib/i18n src/locales) está visible
    const stop = terosPage.getByLabel(/stop agent response|detener respuesta del agente/i)
    await expect(stop, "aparece Stop durante la generación").toBeVisible({ timeout: 15_000 })

    // cortar (soft stop) → el turno termina y Stop desaparece
    await stop.click()
    await expect(stop, "tras cortar, Stop desaparece").toBeHidden({ timeout: 20_000 })

    await evalTeros(terosPage, (cid) => window.teros.channel.close(cid).then(() => null), channelId)
  })

  test("enviar un mensaje con un archivo adjunto @llm", async ({ terosPage }) => {
    test.setTimeout(60_000)
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    const channelId = await openChat(
      terosPage,
      agentId as string,
      privateWorkspaceId as string,
      `PWfilesend${Date.now()}`,
    )
    const [chooser] = await Promise.all([
      terosPage.waitForEvent("filechooser"),
      terosPage.getByTestId("composer-attach").click(),
    ])
    await chooser.setFiles(FIXTURE)
    await expect(terosPage.getByTestId("composer-send")).toBeVisible({ timeout: 10_000 })

    // enviar con el adjunto → upload + onSend; el composer se vacía (send vuelve a mic)
    await terosPage.getByTestId("composer-send").click()
    await expect(
      terosPage.getByTestId("composer-send"),
      "el composer se vacía tras enviar",
    ).toHaveCount(0, { timeout: 20_000 })

    // el mensaje del usuario quedó persistido en el canal
    const userMsgs = await evalTeros(
      terosPage,
      (cid) =>
        window.teros.channel
          .getMessages(cid)
          .then((r) => (r.messages || []).filter((m) => m.role === "user").length),
      channelId,
    )
    expect(userMsgs, "se envió un mensaje con el archivo adjunto").toBeGreaterThan(0)

    await evalTeros(terosPage, (cid) => window.teros.channel.close(cid).then(() => null), channelId)
  })

  test("quitar un adjunto con la X lo elimina del composer", async ({ terosPage }) => {
    test.setTimeout(60_000)
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    const channelId = await openChat(
      terosPage,
      agentId as string,
      privateWorkspaceId as string,
      `PWrm${Date.now()}`,
    )
    const [chooser] = await Promise.all([
      terosPage.waitForEvent("filechooser"),
      terosPage.getByTestId("composer-attach").click(),
    ])
    await chooser.setFiles(FIXTURE)
    await expect(terosPage.getByTestId("composer-attach-chip")).toHaveCount(1)
    await expect(terosPage.getByTestId("composer-send")).toBeVisible()

    // quitar el adjunto → el chip desaparece y el send vuelve a mic (sin contenido)
    await terosPage.getByTestId("composer-attach-remove").first().click()
    await expect(terosPage.getByTestId("composer-attach-chip")).toHaveCount(0)
    await expect(terosPage.getByTestId("composer-send")).toHaveCount(0)

    await evalTeros(terosPage, (cid) => window.teros.channel.close(cid).then(() => null), channelId)
  })

  test("adjuntar varios archivos muestra un chip por archivo", async ({ terosPage }) => {
    test.setTimeout(60_000)
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    const channelId = await openChat(
      terosPage,
      agentId as string,
      privateWorkspaceId as string,
      `PWmulti${Date.now()}`,
    )
    const [chooser] = await Promise.all([
      terosPage.waitForEvent("filechooser"),
      terosPage.getByTestId("composer-attach").click(),
    ])
    await chooser.setFiles([FIXTURE, FIXTURE2])
    await expect(terosPage.getByTestId("composer-attach-chip")).toHaveCount(2)
    await expect(terosPage.getByText("sample.txt", { exact: false })).toBeVisible()
    await expect(terosPage.getByText("sample2.txt", { exact: false })).toBeVisible()

    await evalTeros(terosPage, (cid) => window.teros.channel.close(cid).then(() => null), channelId)
  })

  test("rechaza un archivo ejecutable (validación de tipo)", async ({ terosPage }) => {
    test.setTimeout(60_000)
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    const channelId = await openChat(
      terosPage,
      agentId as string,
      privateWorkspaceId as string,
      `PWbadtype${Date.now()}`,
    )
    const [chooser] = await Promise.all([
      terosPage.waitForEvent("filechooser"),
      terosPage.getByTestId("composer-attach").click(),
    ])
    // MIME en la blacklist de validateFile (application/x-msdownload)
    await chooser.setFiles({
      name: "evil.exe",
      mimeType: "application/x-msdownload",
      buffer: Buffer.from("MZ fake exe"),
    })

    // la validación lo rechaza: NO se añade ningún chip…
    await expect(terosPage.getByTestId("composer-attach-chip")).toHaveCount(0)
    // …y el error se muestra (antes era un rechazo silencioso: el mensaje vivía dentro
    // de `{hasFileAttachment && …}` y no se renderizaba con 0 archivos válidos).
    await expect(terosPage.getByText(/file type not allowed/i)).toBeVisible({ timeout: 10_000 })

    await evalTeros(terosPage, (cid) => window.teros.channel.close(cid).then(() => null), channelId)
  })

  test("grabar un audio con el micrófono (fake mic)", async ({ terosPage }) => {
    test.setTimeout(60_000)
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    const channelId = await openChat(
      terosPage,
      agentId as string,
      privateWorkspaceId as string,
      `PWvoice${Date.now()}`,
    )

    // sin contenido, el botón primario es el mic
    await expect(terosPage.getByTestId("composer-mic")).toBeVisible()
    await terosPage.getByTestId("composer-mic").click()

    // arranca la grabación (getUserMedia con fake device). Degradable: si el entorno
    // no expone un micrófono fake, saltar en vez de fallar.
    const started = await terosPage
      .getByTestId("composer-recording")
      .waitFor({ state: "visible", timeout: 8000 })
      .then(() => true)
      .catch(() => false)
    test.skip(!started, "getUserMedia/fake mic no disponible en el entorno")

    await terosPage.waitForTimeout(1200) // graba un momento
    // descartar (X = primer botón de la barra de grabación) → vuelve a idle (mic reaparece)
    await terosPage.getByTestId("composer-recording").getByRole("button").first().click()
    await expect(terosPage.getByTestId("composer-mic")).toBeVisible({ timeout: 8000 })

    await evalTeros(terosPage, (cid) => window.teros.channel.close(cid).then(() => null), channelId)
  })

  test("el composer se deshabilita al perder la conexión", async ({ terosPage }) => {
    test.setTimeout(60_000)
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    const channelId = await openChat(
      terosPage,
      agentId as string,
      privateWorkspaceId as string,
      `PWconn${Date.now()}`,
    )
    const input = terosPage.getByTestId("composer-input")
    await input.fill("mensaje sin conexión")
    await expect(terosPage.getByTestId("composer-send")).toBeVisible()

    // desconectar el WS (manual, sin auto-reconnect). Guardar la url para reconectar.
    const wsUrl = await terosPage.evaluate(() => {
      const url = window.teros.transport?.url ?? null
      window.teros.disconnect()
      return url
    })

    // el composer se deshabilita sin conexión (guard: no enviar mensajes que se perderían)
    await expect(input, "el input se deshabilita sin conexión").toBeDisabled({ timeout: 10_000 })

    // reconectar para restaurar la sesión, y el composer se rehabilita
    await terosPage.evaluate((url) => {
      if (url) window.teros.connect(url)
    }, wsUrl)
    await expect(input, "tras reconectar, el composer se rehabilita").toBeEnabled({
      timeout: 15_000,
    })

    await evalTeros(terosPage, (cid) => window.teros.channel.close(cid).then(() => null), channelId)
  })
})
