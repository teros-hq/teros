/**
 * Ad-hoc repro captures for the 2026-07-07 monitoring data/UX audit.
 * NOT part of the smoke suite — run manually:
 *
 *   TARGET_URL=http://localhost:10022 BACKEND_URL=http://localhost:10021 \
 *     node scripts/playwright-smoke/shot-audit-repros.js
 *
 * Screenshots land in /tmp/teros-mon-audit/.
 */
const { chromium } = require('playwright');
const { login, attachErrorCapture, getErrors } = require('./lib');
const fs = require('fs');

const SHOT_DIR = '/tmp/teros-mon-audit';
const SUPER = { email: 'playwright3@test.com', password: 'test1234' };

async function shot(page, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
  console.log(`📸 ${name}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1720, height: 1000 } });
  const page = await ctx.newPage();
  attachErrorCapture(page);

  await login(page, SUPER, { label: 'super' });

  // P1 — Hub at 1h: KPIs/charts empty while sessions exist
  await page.locator('text=Monitoring').first().click();
  await page.waitForTimeout(800);
  await page.locator('text="1h"').first().click();
  await shot(page, 'p1-hub-1h');

  // P1 — Agent Activity at 1h
  await page.locator('text=Agent Activity').first().click();
  await page.waitForTimeout(800);
  await page.locator('text="1h"').first().click();
  await shot(page, 'p1-activity-1h');

  // P2 — Cache tab at 1h (real data only → "No token activity")
  await page.locator('[role="tab"]:has-text("Cache")').first().click();
  await shot(page, 'p2-cache-1h');

  // P3 — Tokens tab at 1h
  await page.locator('[role="tab"]:has-text("Tokens")').first().click();
  await shot(page, 'p3-tokens-1h');

  // P4 — back to 24h, Overview, click the Fireworks chip → sessions vanish
  await page.locator('[role="tab"]:has-text("Overview")').first().click();
  await page.locator('text="24h"').first().click();
  await page.waitForTimeout(1200);
  await shot(page, 'p4-before-chip');
  await page.locator('text=Fireworks').first().click();
  await shot(page, 'p4-after-fireworks-chip');

  // P5 — 7d & 30d: bar soup
  await page.locator('text=Fireworks').first().click(); // clear chip
  await page.locator('text="7d"').first().click();
  await shot(page, 'p5-activity-7d');
  await page.locator('text="30d"').first().click();
  await shot(page, 'p5-activity-30d');

  // P6 — Session Trace from Hub recent traces (raw ids)
  await page.locator('text=Monitoring Hub').first().click();
  await page.waitForTimeout(400);
  // Hub still on 1h from earlier? switch to 7d to have recent rows
  await page.locator('text="7d"').first().click();
  await page.waitForTimeout(1200);
  await shot(page, 'p6-hub-recent-traces');

  const errs = getErrors(page);
  console.log(errs.length ? `⚠️ JS errors:\n${errs.join('\n')}` : '✓ 0 JS errors');
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
