/**
 * Custom HTML shell for expo-router static rendering (output: 'static').
 *
 * Without this file, expo-router uses its built-in minimal Html component
 * (node_modules/expo-router/build/static/html.js), which renders a bare
 * <head> with only charset + viewport — dropping every meta tag, OG tag,
 * PWA manifest link, theme-color, JSON-LD, service worker registration, and
 * the loading screen / watchdog that live in public/index.html.
 *
 * This component is rendered server-side for every route during SSG. The
 * <head> children are wrapped in <Head> (react-helmet-async, vendored by
 * expo-router) so they are injected into the static HTML at build time.
 *
 * Children (the React app root) are rendered into <body> by expo-router.
 */
import { ScrollViewStyleReset } from "expo-router/html"

export default function RootHTML({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover"
        />

        {/* Runtime config (WEBCFG-REQ-6): the serving container writes /config.js from
            its environment; it must run before the bundle, hence a classic sync script
            here. Metro and native have no such file and fall back to EXPO_PUBLIC_*. */}
        <script src="/config.js" />

        {/* Teros Design System v0.2.6 — brand fonts.
            Saans (UI) and Prody (display) are licensed, self-hosted .otf files.
            Reddit Mono (code) is free (OFL), self-hosted. */}
        <link rel="stylesheet" href="/fonts/reddit-mono/reddit-mono.css" />
        <link rel="stylesheet" href="/fonts/phosphor/regular.css" />
        <link rel="stylesheet" href="/fonts/phosphor/bold.css" />
        <link rel="stylesheet" href="/fonts/phosphor/fill.css" />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              @font-face { font-family: "Saans"; src: url("/fonts/Saans-Regular.otf") format("opentype"); font-weight: 400; font-style: normal; font-display: swap; }
              @font-face { font-family: "Saans"; src: url("/fonts/Saans-Medium.otf") format("opentype"); font-weight: 500; font-style: normal; font-display: swap; }
              @font-face { font-family: "Saans"; src: url("/fonts/Saans-SemiBold.otf") format("opentype"); font-weight: 600; font-style: normal; font-display: swap; }
              @font-face { font-family: "Prody"; src: url("/fonts/Prody-Regular.otf") format("opentype"); font-weight: 400; font-style: normal; font-display: swap; }
              /* Ivory Light (trial build: letters, digits and the apostrophe only; every other
                 glyph is a dot). The face is declared TWICE under the same family: first Prody
                 for the whole range, then Ivory restricted to its real glyphs — later unicode-range
                 faces win, so punctuation and accents fall through to Prody while the family name
                 stays a single "Ivory" (RenderHtml keeps only the first family of a list). */
              @font-face { font-family: "Ivory"; src: url("/fonts/Prody-Regular.otf") format("opentype"); font-weight: 300 400; font-style: normal; font-display: swap; }
              @font-face { font-family: "Ivory"; src: url("/fonts/Prody-Regular.otf") format("opentype"); font-weight: 300 400; font-style: italic; font-display: swap; }
              @font-face { font-family: "Ivory"; src: url("/fonts/Ivory-Light.otf") format("opentype"); font-weight: 300 400; font-style: normal; font-display: swap; unicode-range: U+20, U+2C-39, U+41-5A, U+61-7A, U+2019; }
              @font-face { font-family: "Ivory"; src: url("/fonts/Ivory-LightItalic.otf") format("opentype"); font-weight: 300 400; font-style: italic; font-display: swap; unicode-range: U+20, U+2C-39, U+41-5A, U+61-7A, U+2019; }
              /* Phosphor glyph map: the two stylesheet links above (official 2.1.1 styles). */
              /* Chat message list — overlay scrollbar, macOS style: hidden
                 until the window is hovered, thin, no track. Firefox via
                 scrollbar-width/scrollbar-color on hover. */
              .chat-scroll { scrollbar-width: none; -ms-overflow-style: none; }
              .chat-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
              .chat-scroll::-webkit-scrollbar-track { background: transparent; }
              .chat-scroll::-webkit-scrollbar-thumb {
                background: transparent; border-radius: 100px;
                background-clip: padding-box; border: 2px solid transparent;
              }
              .chat-scroll:hover { scrollbar-width: thin; scrollbar-color: rgba(127,120,143,0.45) transparent; }
              .chat-scroll:hover::-webkit-scrollbar-thumb { background-color: rgba(127,120,143,0.45); }
              .chat-scroll:hover::-webkit-scrollbar-thumb:hover { background-color: rgba(127,120,143,0.7); }
              /* OS prototype (design-testing): the page is the frame, text is
                 Saans 400, selection is the violet wash. */
              html, body { overscroll-behavior: none; }
              body { font-family: 'Saans', system-ui, -apple-system, sans-serif; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
              ::selection { background: rgba(111,39,255,0.18); }
              button, input, textarea, select { font-family: inherit; }
              [data-theme="dark"] { color-scheme: dark; }
              [data-theme="light"] { color-scheme: light; }
              /* thin, quiet scrollbars everywhere */
              * { scrollbar-width: thin; scrollbar-color: rgba(127,120,143,0.35) transparent; }
              *::-webkit-scrollbar { width: 8px; height: 8px; }
              *::-webkit-scrollbar-track { background: transparent; }
              *::-webkit-scrollbar-thumb { background: rgba(127,120,143,0.35); border-radius: 100px; border: 2px solid transparent; background-clip: padding-box; }
              /* page-in: the staggered entrance of the prototype */
              @keyframes teros-view-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
              .teros-view-in { animation: teros-view-in 0.5s cubic-bezier(.16,1,.3,1) both; }
              @media (prefers-reduced-motion: reduce) { .teros-view-in { animation: none; } }
            `,
          }}
        />

        {/* SEO Meta Tags */}
        <meta
          name="description"
          content="Teros - Plataforma de asistentes IA personalizables con capacidades avanzadas. Automatiza tareas, gestiona proyectos y potencia tu productividad con IA."
        />
        <meta
          name="keywords"
          content="IA, asistente virtual, automatización, productividad, agentes IA, Teros, AI assistant, workspace"
        />
        <meta name="author" content="Teros AI" />
        <meta name="robots" content="index, follow" />

        {/* Open Graph Meta Tags */}
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Teros" />
        <meta property="og:title" content="Teros" />
        <meta
          property="og:description"
          content="Plataforma de asistentes IA con capacidades avanzadas. Automatiza tareas, gestiona proyectos y potencia tu productividad."
        />
        <meta property="og:image" content="https://os.teros.ai/icon-512.png" />
        <meta property="og:image:alt" content="Teros AI Platform Logo" />
        <meta property="og:image:width" content="512" />
        <meta property="og:image:height" content="512" />
        <meta property="og:url" content="https://os.teros.ai" />
        <meta property="og:locale" content="es_ES" />
        <meta property="og:locale:alternate" content="en_US" />

        {/* Twitter Card Meta Tags */}
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:site" content="@TerosAI" />
        <meta name="twitter:creator" content="@TerosAI" />
        <meta name="twitter:title" content="Teros" />
        <meta
          name="twitter:description"
          content="Plataforma de asistentes IA con capacidades avanzadas. Automatiza tareas, gestiona proyectos y potencia tu productividad."
        />
        <meta name="twitter:image" content="https://os.teros.ai/icon-512.png" />
        <meta name="twitter:image:alt" content="Teros AI Platform Logo" />

        {/* PWA Meta Tags */}
        <meta name="application-name" content="Teros" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="Teros" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="theme-color" content="#EDEAF4" />

        {/* Theme detection: read saved theme from localStorage before paint to avoid flash */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var t='dark';try{var r=localStorage.getItem('teros-ui-theme');if(r){var p=JSON.parse(r);if(p&&p.state&&p.state.theme==='light'){t='light'}}}catch(e){}var d=document.documentElement;if(t==='light'){d.style.setProperty('--teros-loader-bg','#EDEAF4');d.style.setProperty('--teros-loader-text','#342F3D');d.style.setProperty('--teros-loader-text-secondary','#797386');d.style.setProperty('--teros-loader-btn-text','#F2F0F7');d.style.setProperty('--teros-loader-btn-bg','#342F3D')}else{d.style.setProperty('--teros-loader-bg','#201C27');d.style.setProperty('--teros-loader-text','#FAF9FC');d.style.setProperty('--teros-loader-text-secondary','#968FA7');d.style.setProperty('--teros-loader-btn-text','#201C27');d.style.setProperty('--teros-loader-btn-bg','#FAF9FC')}var m=document.querySelector('meta[name="theme-color"]');if(m){m.setAttribute('content',t==='light'?'#EDEAF4':'#201C27')}})()`,
          }}
        />

        <title>Teros</title>

        {/* Teros Design System v0.2.6 — every font is self-hosted under /fonts
            (Reddit Mono is linked above): nothing loads from the internet. */}
        <link rel="stylesheet" href="/fonts/phosphor/regular.css" />
        <link rel="stylesheet" href="/fonts/phosphor/bold.css" />
        <link rel="stylesheet" href="/fonts/phosphor/fill.css" />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              @font-face { font-family: "Saans"; src: url("/fonts/Saans-Regular.otf") format("opentype"); font-weight: 400; font-style: normal; font-display: swap; }
              @font-face { font-family: "Prody"; src: url("/fonts/Prody-Regular.otf") format("opentype"); font-weight: 400; font-style: normal; font-display: swap; }
              /* Phosphor glyph map: the two stylesheet links above (official 2.1.1 styles). */
            `,
          }}
        />

        {/* Canonical URL */}
        <link rel="canonical" href="https://os.teros.ai" />

        {/* PWA Manifest */}
        <link rel="manifest" href="/manifest.json" />

        {/* Favicon */}
        <link rel="icon" href="/favicon.ico" />
        <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png" />
        <link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png" />

        {/* Apple Touch Icons */}
        <link rel="apple-touch-icon" href="/icon-192.png" />
        <link rel="apple-touch-icon" sizes="192x192" href="/icon-192.png" />
        <link rel="apple-touch-icon" sizes="512x512" href="/icon-512.png" />

        {/* Expo/React Native Web styles */}
        <ScrollViewStyleReset />

        {/* App Shell / Loading Screen */}
        <style
          id="teros-app-shell"
          dangerouslySetInnerHTML={{
            __html: `
      #teros-loading {
        position: fixed;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        background: var(--teros-loader-bg, #000000);
        color: var(--teros-loader-text, #ffffff);
        z-index: 9999;
        transition: opacity 0.4s ease-out;
      }
      #teros-loading.hidden {
        opacity: 0;
        pointer-events: none;
      }
      #teros-loading .shell-logo {
        width: 64px;
        height: 64px;
        margin-bottom: 24px;
      }
      #teros-loading .shell-text {
        margin-top: 16px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        color: var(--teros-loader-text-secondary, #a1a1aa);
        letter-spacing: 0.02em;
      }
      #teros-error {
        display: none;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        padding: 32px;
      }
      #teros-error .shell-logo {
        width: 64px;
        height: 64px;
        margin-bottom: 24px;
        opacity: 0.45;
      }
      #teros-error h1 {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 20px;
        font-weight: 600;
        margin: 0 0 8px;
        color: var(--teros-loader-text, #ffffff);
      }
      #teros-error p {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        color: var(--teros-loader-text-secondary, #a1a1aa);
        margin: 0 0 24px;
        max-width: 320px;
        line-height: 1.5;
      }
      #teros-error .reload-btn {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        font-weight: 500;
        color: var(--teros-loader-btn-text, #000000);
        background: var(--teros-loader-btn-bg, #ffffff);
        border: none;
        border-radius: 8px;
        padding: 10px 20px;
        cursor: pointer;
        transition: opacity 0.2s;
      }
      #teros-error .reload-btn:hover {
        opacity: 0.85;
      }
    `,
          }}
        />

        {/* Structured Data (JSON-LD) */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "SoftwareApplication",
              name: "Teros",
              applicationCategory: "ProductivityApplication",
              operatingSystem: "Web, iOS, Android",
              description:
                "Plataforma de asistentes IA personalizables con capacidades avanzadas para automatizar tareas y gestionar proyectos.",
              url: "https://os.teros.ai",
              image: "https://os.teros.ai/icon-512.png",
              offers: {
                "@type": "Offer",
                price: "0",
                priceCurrency: "USD",
              },
              author: {
                "@type": "Organization",
                name: "Teros AI",
                url: "https://teros.ai",
              },
              aggregateRating: {
                "@type": "AggregateRating",
                ratingValue: "5.0",
                ratingCount: "1",
              },
            }),
          }}
        />
      </head>
      <body>
        <noscript>Necesitas habilitar JavaScript para usar Teros.</noscript>
        <div id="root">
          {/* App Shell: shown while React loads */}
          <div id="teros-loading">
            <svg
              id="teros-shell-spinner"
              width="48"
              height="48"
              viewBox="0 0 48 48"
              xmlns="http://www.w3.org/2000/svg"
            />
            <div className="shell-text">Loading Teros...</div>

            <div id="teros-error">
              <svg
                id="teros-shell-error-logo"
                className="shell-logo"
                width="48"
                height="48"
                viewBox="0 0 48 48"
                xmlns="http://www.w3.org/2000/svg"
              />
              <h1>Something went wrong</h1>
              <p>
                We couldn't load Teros. This may be due to a temporary network issue or a problem
                with your browser.
              </p>
              <button className="reload-btn" onClick={() => window.location.reload()}>
                Reload
              </button>
            </div>
          </div>
        </div>

        {/* Register Service Worker for PWA */}
        <script
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').then(function(r){console.log('Teros SW registered:',r.scope)}).catch(function(e){console.log('Teros SW registration failed:',e)})})}`,
          }}
        />

        {/* Loading Watchdog */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var M=60000,I=500,l=document.getElementById('teros-loading'),e=document.getElementById('teros-error'),t=0,n=null;function m(){var r=document.getElementById('root');if(!r)return false;var c=Array.from(r.children);return c.some(function(el){return el.id!=='teros-loading'})||document.body.classList.contains('app-mounted')}function s(){if(n)clearInterval(n);if(!l||!e)return;var p=document.getElementById('teros-shell-spinner'),x=l.querySelector('.shell-text');if(p)p.style.display='none';if(x)x.style.display='none';e.style.display='flex'}function c(){if(m()){if(n)clearInterval(n);l.classList.add('hidden');return}t+=I;if(t>=M){s()}}n=setInterval(c,I);setTimeout(c,100)})()`,
          }}
        />

        {/* TerosLoading spinner (pure JS, no React) */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var s=48,c='#5E6AD2';function p(s){var p=s*0.15,i=s-p*2;return[{x:s/2,y:p},{x:s-p-i*0.067,y:p+i*0.25},{x:s-p-i*0.067,y:p+i*0.75},{x:s/2,y:s-p},{x:p+i*0.067,y:p+i*0.75},{x:p+i*0.067,y:p+i*0.25}]}function r(e,a){var pts=p(s),b=s*0.08,A=b*1.2;e.innerHTML='';for(var i=0;i<pts.length;i++){var d=Math.min(Math.abs(i-a),6-Math.abs(i-a)),o=d===0?1:d===1?0.6:0.3,rad=d===0?A:b,c=document.createElementNS('http://www.w3.org/2000/svg','circle');c.setAttribute('cx',pts[i].x);c.setAttribute('cy',pts[i].y);c.setAttribute('r',rad);c.setAttribute('fill',c);c.setAttribute('opacity',o);e.appendChild(c)}}var v=document.getElementById('teros-shell-spinner');if(v){var a=0;r(v,a);setInterval(function(){a=(a+1)%6;r(v,a)},150)}var g=document.getElementById('teros-shell-error-logo');if(g){r(g,-99)}})()`,
          }}
        />

        {children}
      </body>
    </html>
  )
}
