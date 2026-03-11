#!/usr/bin/env node
/**
 * Script to inject PWA meta tags into Expo-generated index.html
 * and copy PWA assets to dist/
 */

const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');
const publicDir = path.join(__dirname, '..', 'public');
const indexPath = path.join(distDir, 'index.html');

console.log('🔧 Configurando PWA para Teros...\n');

// 1. Read and modify index.html
console.log('📝 Inyectando meta tags PWA en index.html...');
let html = fs.readFileSync(indexPath, 'utf8');

// Update title
html = html.replace(/<title>.*?<\/title>/, '<title>Teros</title>');

// Update lang
html = html.replace(/<html lang="en">/, '<html lang="es">');

// PWA meta tags to inject after </title>
const pwaMeta = `
    <!-- PWA Meta Tags -->
    <meta name="application-name" content="Teros" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="apple-mobile-web-app-title" content="Teros" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="theme-color" content="#000000" />
    <meta name="description" content="Teros AI Assistant" />
    
    <!-- PWA Manifest -->
    <link rel="manifest" href="/manifest.json" />
    
    <!-- PWA Icons -->
    <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png" />
    <link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png" />
    <link rel="apple-touch-icon" href="/icon-192.png" />
    <link rel="apple-touch-icon" sizes="192x192" href="/icon-192.png" />
    <link rel="apple-touch-icon" sizes="512x512" href="/icon-512.png" />`;

// Inject PWA meta after <title>
html = html.replace('</title>', '</title>' + pwaMeta);

// Service Worker registration script
const swScript = `
    <!-- Register Service Worker for PWA -->
    <script>
      if ('serviceWorker' in navigator) {
        window.addEventListener('load', function() {
          navigator.serviceWorker.register('/sw.js')
            .then(function(reg) { console.log('Teros SW registered:', reg.scope); })
            .catch(function(err) { console.log('Teros SW failed:', err); });
        });
      }
    </script>
  `;

// Inject SW script before </body>
html = html.replace('</body>', swScript + '</body>');

fs.writeFileSync(indexPath, html);
console.log('  ✓ index.html actualizado\n');

// 2. Copy PWA assets
console.log('📦 Copiando assets PWA...');

// Copy manifest.json
fs.copyFileSync(path.join(publicDir, 'manifest.json'), path.join(distDir, 'manifest.json'));
console.log('  ✓ manifest.json');

// Copy sw.js
fs.copyFileSync(path.join(publicDir, 'sw.js'), path.join(distDir, 'sw.js'));
console.log('  ✓ sw.js');

// Copy icon files from public root
['icon-192.png', 'icon-512.png'].forEach((icon) => {
  const src = path.join(publicDir, icon);
  const dest = path.join(distDir, icon);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`  ✓ ${icon}`);
  }
});

console.log('\n🎉 ¡PWA configurada correctamente!');
console.log('   Nombre: Teros');
console.log('   Los usuarios podrán instalar la app desde el navegador.');
console.log('   Los permisos de micrófono persistirán en la PWA instalada.\n');
