#!/usr/bin/env node
/**
 * Post-build step for `expo export --static` output (dist/).
 *
 *  1. TITLE FIX: expo-router's static renderer emits an empty react-helmet
 *     placeholder — `<title data-rh="true"></title>` — as the FIRST <head>
 *     element of every generated page. Browsers use the first <title>, so
 *     every tab renders unnamed unless it is stripped. The real
 *     `<title>Teros</title>` is rendered by `app/+html.tsx` at build time;
 *     this script removes the empty placeholders from EVERY page (root +
 *     all pre-rendered routes) and inserts a safety-net title on any page
 *     that ends up without one.
 *
 *  2. lang="es": expo-router's default Html shell is lang="en"; +html.tsx
 *     already sets "es" but this covers any page rendered without it.
 *
 *  3. PWA assets: copies manifest.json, sw.js and icons to dist/.
 *
 * NOTE: since aa026711d (+html.tsx) all meta tags (SEO/OG/PWA/fonts/SW
 * registration) are rendered into every page at build time. This script no
 * longer injects them — the old injection produced duplicate tags on the
 * root page (two descriptions, two manifest links, two SW registrations).
 */

const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');
const publicDir = path.join(__dirname, '..', 'public');

// ── 1. Walk every generated HTML page (root + all pre-rendered routes) ──────
function walkHtml(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkHtml(p, out);
    else if (entry.name.endsWith('.html')) out.push(p);
  }
  return out;
}

const pages = walkHtml(distDir);
console.log(`📝 Arreglando <title> en ${pages.length} páginas de dist/...`);

let strippedTitles = 0;
let insertedTitles = 0;
for (const page of pages) {
  let html = fs.readFileSync(page, 'utf8');
  const before = html;

  // Remove EVERY empty <title ...></title> placeholder (with or without
  // attributes). The real title from +html.tsx survives this pass.
  html = html.replace(/<title[^>]*><\/title>\s*/g, '');

  // Safety net: a page with no title left gets one right after <head>.
  if (!/<title>[^<]*<\/title>/.test(html)) {
    html = html.replace(/<head[^>]*>/, (m) => `${m}<title>Teros</title>`);
    insertedTitles++;
  }

  // lang="es" for any page still on expo-router's "en" default.
  html = html.replace(/<html lang="en">/, '<html lang="es">');

  if (html !== before) {
    fs.writeFileSync(page, html);
    strippedTitles++;
  }
}
console.log(`  ✓ ${pages.length} páginas procesadas (${strippedTitles} modificadas, ${insertedTitles} titles de seguridad insertados)`);

// ── 2. Copy PWA assets ──────────────────────────────────────────────────────
console.log('📦 Copiando assets PWA...');

fs.copyFileSync(path.join(publicDir, 'manifest.json'), path.join(distDir, 'manifest.json'));
console.log('  ✓ manifest.json');

fs.copyFileSync(path.join(publicDir, 'sw.js'), path.join(distDir, 'sw.js'));
console.log('  ✓ sw.js');

['icon-192.png', 'icon-512.png'].forEach((icon) => {
  const src = path.join(publicDir, icon);
  const dest = path.join(distDir, icon);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`  ✓ ${icon}`);
  }
});

console.log('\n🎉 PWA configurada correctamente.');
console.log('   Nombre: Teros');
console.log('   Los usuarios podrán instalar la app desde el navegador.');
console.log('   Los permisos de micrófono persistirán en la PWA instalada.\n');
