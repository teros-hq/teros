/**
 * Ad-hoc visual check for the Monitoring suite fixes (tables full-width, header
 * controls in flow, thin scrollbars, expandable rows). NOT part of the smoke
 * suite — run manually:
 *
 *   TARGET_URL=http://localhost:8086 BACKEND_URL=http://localhost:10021 \
 *     node scripts/playwright-smoke/shot-monitoring.js
 *
 * Screenshots land in /tmp/teros-mon-smoke/.
 */
const { chromium } = require('playwright');
const { login, attachErrorCapture, getErrors } = require('./lib');
const fs = require('fs');

const SHOT_DIR = '/tmp/teros-mon-smoke';
const SUPER = { email: 'playwright3@test.com', password: 'test1234' };

async function shot(page, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
  console.log(`📸 ${name}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  // en-US so the UI renders the English locators lib.js expects; WIDE viewport
  // to verify the tables stretch to the right edge.
  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1720, height: 1000 } });
  const page = await ctx.newPage();
  attachErrorCapture(page);

  await login(page, SUPER, { label: 'super' });

  // Navbar → Monitoring (hub)
  await page.locator('text=Monitoring').first().click();
  await shot(page, '01-hub');

  // Related view → Model Health (charts: request volume / percentiles / heatmap)
  await page.locator('text=Model Health').first().click();
  await shot(page, '01b-model-health');
  await page.mouse.wheel(0, 700);
  await shot(page, '01c-model-health-charts');

  // Related view → Agent Activity
  await page.locator('text=Agent Activity').first().click();
  await shot(page, '02-activity-overview');

  // Expand the first session row (caret) if present
  const caret = page.locator('text=▶').first();
  if (await caret.count()) {
    await caret.click();
    await shot(page, '03-activity-session-expanded');
  }

  // Tabs
  for (const tab of ['Quota', 'Cache', 'Tokens', 'Tools', 'Health']) {
    await page.locator(`[role="tab"]:has-text("${tab}")`).first().click();
    await shot(page, `04-tab-${tab.toLowerCase()}`);
  }

  const errs = getErrors(page);
  console.log(errs.length ? `⚠️ JS errors:\n${errs.join('\n')}` : '✓ 0 JS errors');
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
