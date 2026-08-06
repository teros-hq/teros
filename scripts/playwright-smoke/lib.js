/**
 * Reusable Playwright smoke harness for Teros (TER-533).
 *
 * The Teros login flow (Sign in with email → ToS welcome → onboarding skip →
 * navbar hydration) and the RN-Web gotchas (Image = background-image not <img>,
 * buttons = TouchableOpacity not <button>, sidebar "+" clicked by coordinate)
 * live HERE, once. Every smoke (smoke.js, run.js, ad-hoc) imports these instead
 * of re-deriving them.
 *
 * CommonJS so run.js (also CommonJS) can `require('./lib')` it.
 */
const { chromium } = require('playwright');
const fs = require('fs');

const CONFIG = {
  targetUrl: process.env.TARGET_URL || 'http://localhost:8081',
  backendUrl: process.env.BACKEND_URL || 'http://localhost:10001',
  shotDir: process.env.SMOKE_SHOT_DIR || '/tmp/teros-smoke',
  users: {
    user1: { email: 'playwright1@test.com', password: 'test1234' },
    user2: { email: 'playwright2@test.com', password: 'test1234' },
  },
};

// ── Error capture ───────────────────────────────────────────────────────────
// Console errors + uncaught page errors are the #1 signal of a broken build.
// Attached at page creation; read with getErrors(page).
const _errors = new WeakMap();

function attachErrorCapture(page) {
  const bucket = { console: [], page: [], network: [] };
  _errors.set(page, bucket);
  page.on('console', (m) => {
    // Skip the generic "Failed to load resource" line — the real URL is captured
    // via the 'response' listener below with status + URL.
    if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) {
      bucket.console.push(m.text());
    }
  });
  page.on('pageerror', (e) => bucket.page.push(e.message));
  page.on('response', (r) => {
    if (r.status() >= 400) bucket.network.push(`${r.status()} ${r.url()}`);
  });
  return page;
}

function getErrors(page) {
  return _errors.get(page) || { console: [], page: [], network: [] };
}

/** Reads the live client state (source of truth for "the app loaded", language-agnostic). */
async function getClientState(page) {
  return page
    .evaluate(async () => {
      const t = window.teros;
      if (!t) return { ok: false, reason: 'window.teros no expuesto' };
      const agents = (await t.agent.listAgents().catch(() => ({}))).agents || [];
      const wss = (await t.listWorkspaces().catch(() => [])) || [];
      return { ok: true, agents: agents.length, workspaces: wss.length };
    })
    .catch((e) => ({ ok: false, reason: e.message }));
}

// ── Lifecycle ─────────────────────────────────────────────────────────────
async function launch({ headless = false, slowMo = 40, contexts = 1 } = {}) {
  const browser = await chromium.launch({ headless, slowMo });
  const pages = [];
  for (let i = 0; i < contexts; i++) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    pages.push(attachErrorCapture(await ctx.newPage()));
  }
  return { browser, pages, page: pages[0] };
}

/** Polls backend /health and the Expo bundle until both answer, or throws a clear message. */
async function waitServersUp({ timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const ping = async (url) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return r.ok || r.status < 500;
    } catch {
      return false;
    }
  };
  while (Date.now() < deadline) {
    const [be, fe] = await Promise.all([ping(`${CONFIG.backendUrl}/health`), ping(CONFIG.targetUrl)]);
    if (be && fe) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `Stack no disponible. Esperaba backend en ${CONFIG.backendUrl}/health y frontend en ${CONFIG.targetUrl}.\n` +
      `Levántalo: (backend) cd packages/backend && yarn dev ; (expo) cd packages/app && yarn web`,
  );
}

// ── Login (the whole reason this file exists) ────────────────────────────────
async function login(page, creds = CONFIG.users.user1, { label = '' } = {}) {
  const tag = label ? `[${label}] ` : '';
  console.log(`${tag}login as ${creds.email}`);
  await page.goto(CONFIG.targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);

  if (page.url().includes('/login') && !page.url().includes('/login/email')) {
    await page.locator('text=Sign in with email').first().click();
    await page.waitForURL('**/login/email', { timeout: 5000 });
  }
  await page.waitForTimeout(400);

  await page.locator('input[type=email]').fill(creds.email);
  await page.locator('input[type=password]').fill(creds.password);
  await page.locator('button:has-text("Sign in")').first().click();
  await page.waitForTimeout(2500);

  // ToS welcome — checkbox is a row; click to the left of the text label.
  if (page.url().includes('/login/welcome')) {
    const tosRow = page.locator('text=/I understand that Teros is in early alpha/').first();
    const box = await tosRow.boundingBox();
    if (box) await page.mouse.click(box.x - 18, box.y + box.height / 2);
    await page.waitForTimeout(500);
    await page.locator('button:has-text("Get started")').first().click({ force: true });
    await page.waitForTimeout(2500);
  }

  // Onboarding wizard — re-hit root to skip.
  if (page.url().includes('/login/onboarding')) {
    await page.goto(CONFIG.targetUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
  }

  await page.waitForFunction(() => !window.location.pathname.startsWith('/login'), null, {
    timeout: 20000,
  });
  await page.waitForTimeout(3000); // navbar hydration
  console.log(`${tag}logged in @ ${page.url()}`);
}

// ── Sidebar navigation ───────────────────────────────────────────────────────
async function getSidebarText(page) {
  return page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('*'));
    const agentesHeader = all.find(
      (el) => el.textContent?.trim().toLowerCase() === 'agentes' && el.children.length === 0,
    );
    let sidebar = agentesHeader;
    while (sidebar && sidebar.parentElement) {
      const r = sidebar.getBoundingClientRect();
      if (r.width > 200 && r.width < 320 && r.height > 400) break;
      sidebar = sidebar.parentElement;
    }
    return (sidebar || document.body).innerText;
  });
}

async function countInSidebar(page, needle) {
  const text = await getSidebarText(page);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = text.match(new RegExp(escaped, 'g'));
  return matches ? matches.length : 0;
}

async function waitForSidebarText(page, needle, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await countInSidebar(page, needle)) > 0) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

async function waitUntilAbsent(page, needle, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await countInSidebar(page, needle)) === 0) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

async function clickSidebarPlus(page, sectionName) {
  // Section headers are uppercase ("AGENTES", "PROYECTOS", "CONVERSATIONS",
  // "APPS"). The "+" is a TouchableOpacity to the right of the header — click by
  // coordinate at x=228 in the 1280-wide viewport.
  const rect = await page.evaluate((target) => {
    const all = Array.from(document.querySelectorAll('*'));
    const header = all.find(
      (el) => el.textContent?.trim().toLowerCase() === target.toLowerCase() && el.children.length === 0,
    );
    if (!header) return null;
    const r = header.getBoundingClientRect();
    return { y: r.y + r.height / 2 };
  }, sectionName);
  if (!rect) throw new Error(`Sidebar header "${sectionName}" not found`);
  await page.mouse.click(228, rect.y);
}

// ── Screenshots ──────────────────────────────────────────────────────────────
function snapshot(page, nameOrPath) {
  // Accepts a bare name (→ CONFIG.shotDir/<name>.png) or an absolute path (legacy
  // run.js call sites pass full paths). Either way the dir is ensured.
  const file = nameOrPath.startsWith('/') ? nameOrPath : `${CONFIG.shotDir}/${nameOrPath}.png`;
  const dir = file.slice(0, file.lastIndexOf('/'));
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return page.screenshot({ path: file, fullPage: false }).then(() => {
    console.log(`📸 ${file}`);
    return file;
  });
}

module.exports = {
  CONFIG,
  launch,
  waitServersUp,
  login,
  getErrors,
  getClientState,
  attachErrorCapture,
  getSidebarText,
  countInSidebar,
  waitForSidebarText,
  waitUntilAbsent,
  clickSidebarPlus,
  snapshot,
};
