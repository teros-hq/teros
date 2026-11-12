import { expect, type Page, test } from "@playwright/test"
import { terminalHtml } from "../../windows/TerminalWindow/terminalBundle"

test.use({ channel: process.env.PW_CHANNEL || undefined })

const ID = "t-row0"

function frame(payload: string): Buffer {
  const id = Buffer.from(ID)
  return Buffer.concat([Buffer.from([1, id.length]), id, Buffer.from(payload)])
}

async function mount(page: Page, width: number, height: number): Promise<void> {
  await page.routeWebSocket(/\/ws\/terminal/, (ws) => {
    let line = ""
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw))
      if (msg.t === "attach") {
        ws.send(JSON.stringify({ t: "attached", id: ID, session: { persistent: true } }))
        ws.send(JSON.stringify({ t: "size", id: ID, cols: msg.cols, rows: msg.rows }))
        ws.send(frame("bash: asdkam: command not found\r\nroot@box:/workspace# "))
      }
      if (msg.t === "resize")
        ws.send(JSON.stringify({ t: "size", id: ID, cols: msg.cols, rows: msg.rows }))
      if (msg.t !== "in") return
      for (const ch of msg.d as string) {
        if (ch !== "\r") {
          line += ch
          ws.send(frame(ch))
          continue
        }
        const out = line === "clear" ? "\x1b[H\x1b[2J\x1b[3J" : `\r\n${line}\r\n`
        line = ""
        ws.send(frame(`${out}root@box:/workspace# `))
      }
    })
  })
  await page.setContent(
    `<div id="pane" style="position:absolute;top:44px;left:0;width:${width}px;height:${height}px">
       <iframe id="f" style="width:100%;height:100%;border:0"></iframe>
     </div>`,
  )
  await page.evaluate((html) => {
    const f = document.getElementById("f") as HTMLIFrameElement
    window.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data)
      const post = (m: object) => f.contentWindow?.postMessage(JSON.stringify(m), "*")
      if (msg.type === "ready")
        post({ type: "init", wsUrl: "ws://fake.test/ws/terminal", terminalId: "t-row0" })
      if (msg.type === "need_ticket") post({ type: "ticket", ticket: "x" })
    })
    f.srcdoc = html
  }, terminalHtml)
  await pane(page).locator(".xterm-screen").click()
  await expect
    .poll(() =>
      pane(page)
        .locator(".xterm-helper-textarea")
        .evaluate((t) => t.clientHeight),
    )
    .toBeGreaterThan(0)
}

function pane(page: Page) {
  return page.frameLocator("#f")
}

async function geometry(page: Page) {
  return pane(page)
    .locator("#terminal")
    .evaluate((host) => {
      const screen = host.querySelector(".xterm-screen") as HTMLElement
      const input = host.querySelector(".xterm-helper-textarea") as HTMLElement
      const xterm = host.querySelector(".xterm") as HTMLElement
      return {
        hostScroll: host.scrollTop,
        docScroll: document.scrollingElement?.scrollTop ?? 0,
        hostTop: host.getBoundingClientRect().top,
        hostBottom: host.getBoundingClientRect().bottom,
        screenTop: screen.getBoundingClientRect().top,
        inputBottom: input.getBoundingClientRect().bottom,
        transform: xterm.style.transform,
      }
    })
}

async function expectRowZeroVisible(page: Page): Promise<void> {
  const g = await geometry(page)
  expect(g.inputBottom).toBeLessThanOrEqual(g.hostBottom)
  expect(g.transform).toBe("")
  expect(g.hostScroll).toBe(0)
  expect(g.docScroll).toBe(0)
  expect(g.screenTop).toBeGreaterThanOrEqual(g.hostTop)
}

async function typeAndClear(page: Page): Promise<void> {
  await pane(page).locator(".xterm-screen").click()
  await page.keyboard.type("echo row zero\n", { delay: 25 })
  await page.keyboard.type("clear\n", { delay: 25 })
  await page.waitForTimeout(300)
}

for (const [name, width, height] of [
  ["docked", 1080, 800],
  ["floating", 520, 320],
  ["narrow", 360, 560],
] as const) {
  test(`row 0 stays below the header after typing and clear (${name})`, async ({ page }) => {
    await page.setViewportSize({ width: width + 40, height: height + 80 })
    await mount(page, width, height)
    await expectRowZeroVisible(page)
    await typeAndClear(page)
    await expectRowZeroVisible(page)
  })
}

test("row 0 stays visible after the pane is resized", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  await mount(page, 1080, 800)
  await typeAndClear(page)
  await page.evaluate(() => {
    const el = document.getElementById("pane") as HTMLElement
    el.style.width = "640px"
    el.style.height = "420px"
  })
  await page.waitForTimeout(200)
  await page.keyboard.type("echo row zero\n", { delay: 25 })
  await page.keyboard.type("clear\n", { delay: 25 })
  await page.waitForTimeout(300)
  await expectRowZeroVisible(page)
})
