#!/usr/bin/env node
/**
 * Teros smoke — un comando, cero reescritura (TER-533).
 *
 *   node scripts/playwright-smoke/smoke.js            # health (~30s)
 *   node scripts/playwright-smoke/smoke.js --full     # health + navegación funcional
 *   node scripts/playwright-smoke/smoke.js --headless # sin ventana
 *   node scripts/playwright-smoke/smoke.js --user=user2
 *   TARGET_URL=http://localhost:8081 node scripts/playwright-smoke/smoke.js
 *
 * Health (siempre): servers up → login → dashboard renderiza → 0 errores de
 * consola → screenshots. --full añade: conteo de agentes/workspaces vía
 * window.teros + abre el primer canal de la sidebar.
 *
 * Exit 0 = todo verde · 1 = algún check falló · 2 = stack no disponible.
 * Requiere usuarios sembrados: node scripts/playwright-smoke/seed.mjs
 */
const lib = require('./lib');

const args = process.argv.slice(2);
const FULL = args.includes('--full');
const HEADLESS = args.includes('--headless');
const userArg = (args.find((a) => a.startsWith('--user=')) || '').split('=')[1] || 'user1';
const creds = lib.CONFIG.users[userArg] || lib.CONFIG.users.user1;

const results = { pass: [], fail: [] };
const ok = (m) => { results.pass.push(m); console.log('  ✅', m); };
const bad = (m) => { results.fail.push(m); console.log('  ❌', m); };

(async () => {
  console.log(`Teros smoke — ${FULL ? 'full' : 'health'} · ${creds.email} · ${lib.CONFIG.targetUrl}`);

  try {
    await lib.waitServersUp();
    console.log('servers up ✓');
  } catch (e) {
    console.error('❌', e.message);
    process.exit(2);
  }

  const { browser, page } = await lib.launch({ headless: HEADLESS });
  try {
    // Login screen (visual)
    await page.goto(lib.CONFIG.targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    await lib.snapshot(page, '1-login');

    // Health: login flow
    await lib.login(page, creds, { label: 'smoke' });
    await lib.snapshot(page, '2-dashboard');

    if (!page.url().includes('/login')) ok(`login OK → ${page.url()}`);
    else bad(`sigue en /login tras el flujo: ${page.url()}`);

    // Dashboard cargó = el cliente responde (robusto, idioma-agnóstico — la UI
    // muestra "AGENTS"/"AGENTES" según locale; no dependemos del texto).
    const state = await lib.getClientState(page);
    if (state.ok) ok(`app cargada — window.teros responde (agentes=${state.agents}, workspaces=${state.workspaces})`);
    else bad(`app NO cargada: ${state.reason}`);

    // Sidebar renderizado (cualquier sección conocida, ES o EN).
    const sidebar = await lib.getSidebarText(page).catch(() => '');
    if (/AGENT|PROJECT|PROYECTO|CONVERSATION|APPS/i.test(sidebar)) ok('sidebar renderiza (secciones visibles)');
    else bad('sidebar no renderiza ninguna sección conocida');

    const errs = lib.getErrors(page);
    if (errs.console.length === 0 && errs.page.length === 0) ok('0 errores JS de consola/página');
    else bad(`errores JS: console=${errs.console.length}, page=${errs.page.length}`);
    // Network 4xx/5xx se reportan pero no fallan el health (404 de avatar ≠ build roto).
    if (errs.network.length) console.log(`  ⚠️  ${errs.network.length} respuestas 4xx/5xx (ver detalle abajo)`);

    // --full: navegación funcional en la UI.
    if (FULL) {
      if (state.ok && state.workspaces > 0) ok('al menos 1 workspace'); else bad('0 workspaces');
      const hasConversations = await page
        .evaluate(() =>
          Array.from(document.querySelectorAll('*')).some(
            (el) => /^conversations$/i.test(el.textContent?.trim() || '') && el.children.length === 0,
          ),
        )
        .catch(() => false);
      if (hasConversations) ok('sección Conversations presente');
      else console.log('  (sin sección Conversations — workspace vacío, no es fallo)');
      await lib.snapshot(page, '3-full');
    }
  } catch (e) {
    bad(`EXCEPCIÓN: ${e.message}`);
    await lib.snapshot(page, 'error').catch(() => {});
  } finally {
    const errs = lib.getErrors(page);
    console.log('\n=== RESULTADO ===');
    console.log(`PASS ${results.pass.length} · FAIL ${results.fail.length} · screenshots en ${lib.CONFIG.shotDir}/`);
    if (errs.console.length) {
      console.log('console errors:');
      errs.console.slice(0, 10).forEach((e) => console.log('  ', e.slice(0, 200)));
    }
    if (errs.page.length) {
      console.log('page errors:');
      errs.page.slice(0, 10).forEach((e) => console.log('  ', e.slice(0, 200)));
    }
    if (errs.network.length) {
      console.log(`network 4xx/5xx (${errs.network.length}):`);
      [...new Set(errs.network)].slice(0, 15).forEach((e) => console.log('  ', e.slice(0, 200)));
    }
    await browser.close();
    process.exit(results.fail.length ? 1 : 0);
  }
})();
