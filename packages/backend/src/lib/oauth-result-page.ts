/**
 * The OAuth return page — what the popup shows for the second it lives after
 * Google / Microsoft / GitHub (or an app's provider) hands the user back.
 *
 * One page for both flows (sign-in and app connection), drawn with the OS
 * design system rather than browser defaults: the page colour, one card
 * (radius 24, violet lift), the Teros wordmark, a Prody headline, Saans
 * body, and the status — a violet ring while the window closes itself, or
 * the red banner with a "Return to Teros" pill when something failed.
 * Light and dark follow `prefers-color-scheme`. Fonts are served from the
 * backend's own `/static/fonts` so the page needs nothing from the app.
 *
 * Every string that comes from outside (provider errors, URLs) is escaped;
 * the behaviour script is passed in by the caller as a plain string and is
 * never built from user input.
 */

import { randomBytes } from "crypto"

export interface OAuthResultPageOptions {
  /** <title> */
  title: string
  success: boolean
  /** Prody headline: "Signed in", "Connected", "Couldn't sign in"… */
  heading: string
  /** One Saans sentence under the headline. */
  lead: string
  /** Shown in the red banner when `success` is false. Escaped. */
  error?: string
  /** Where the "Return to Teros" pill goes (and the auto-redirect). */
  returnUrl: string
  returnLabel?: string
  /** Base URL of this backend's `/static` (for the fonts). */
  staticBaseUrl: string
  /** The flow's own JS (postMessage, close, redirect). Trusted, not escaped. */
  script: string
}

export interface OAuthResultPage {
  html: string
  contentSecurityPolicy: string
}

export function scriptJson(value: unknown): string {
  return JSON.stringify(value ?? null).replace(
    /[<>&\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
}

function fontOrigin(staticBaseUrl: string): string {
  try {
    return new URL(staticBaseUrl).origin
  } catch {
    return "'self'"
  }
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** The prototype's `logo-full`: six dots + the wordmark as one vector. */
const WORDMARK_SVG = `<svg width="90" height="25" viewBox="0 0 101 28" fill="none" role="img" aria-label="Teros">
<circle cx="12.4886" cy="2.72395" r="2.72395" fill="#6F27FF"/><circle cx="22.2537" cy="8.36197" r="2.72395" fill="#6F27FF"/><circle cx="22.2537" cy="19.638" r="2.72395" fill="#6F27FF"/><circle cx="12.4886" cy="25.276" r="2.72395" fill="#6F27FF"/><circle cx="2.72395" cy="19.638" r="2.72395" fill="#6F27FF"/><circle cx="2.72395" cy="8.36197" r="2.72395" fill="#6F27FF"/>
<path fill="currentColor" d="M94.9458 24.2148C91.4428 24.2148 89.1728 22.0289 89.0327 19.2546H91.1906C91.3027 20.8799 92.6758 22.2812 94.9458 22.2812C96.8794 22.2812 98.1685 21.2443 98.1685 19.9832C98.1685 18.666 97.2438 18.0495 95.9266 17.7132L93.2924 17.0126C91.3587 16.5082 89.6773 15.5834 89.6773 13.1453C89.6773 10.8753 91.695 9.22192 94.6375 9.22192C97.6081 9.22192 99.7379 10.9034 100.13 13.5096H97.9444C97.7482 12.0524 96.4311 11.0995 94.6375 11.0995C92.9841 11.0995 91.8912 11.8842 91.8912 13.1453C91.8912 14.1261 92.6478 14.7707 93.8528 15.079L96.4871 15.7515C98.5889 16.284 100.41 17.0967 100.41 19.9832C100.41 22.5053 98.2246 24.2148 94.9458 24.2148Z"/>
<path fill="currentColor" d="M80.2273 24.2148C76.0797 24.2148 73.1372 21.0761 73.1372 16.7044C73.1372 12.3606 76.0797 9.22192 80.2273 9.22192C84.3468 9.22192 87.3454 12.3326 87.3454 16.7044C87.3454 21.1041 84.3468 24.2148 80.2273 24.2148ZM80.2273 22.2812C83.1138 22.2812 85.1315 19.9552 85.1315 16.7044C85.1315 13.4536 83.0857 11.1556 80.2273 11.1556C77.3128 11.1556 75.3791 13.4816 75.3791 16.7044C75.3791 19.9552 77.3128 22.2812 80.2273 22.2812Z"/>
<path fill="currentColor" d="M72.7463 11.3798C72.438 11.2957 71.9336 11.1836 71.233 11.1836C68.879 11.1836 66.8893 13.5657 66.8893 18.4138V23.9906H64.7314V9.44612H66.8893V12.4447C67.5899 10.5951 69.5516 9.22192 71.4852 9.22192C72.1578 9.22192 72.4661 9.27797 72.7463 9.33402V11.3798Z"/>
<path fill="currentColor" d="M50.5843 16.9846C50.6964 20.3195 52.602 22.3092 55.4044 22.3092C57.5343 22.3092 59.3278 21.2723 59.6641 19.3947H61.7379C61.2054 22.5614 58.5992 24.2148 55.4044 24.2148C51.1168 24.2148 48.3984 20.936 48.3984 16.7044C48.3984 12.5007 51.0607 9.22192 55.3484 9.22192C59.3558 9.22192 61.878 12.1645 61.85 16.0038C61.85 16.4521 61.7939 16.8445 61.7939 16.9846H50.5843ZM55.3484 11.0715C52.8543 11.0715 51.1728 12.6689 50.7244 15.163H59.552C59.3839 12.809 57.8986 11.0715 55.3484 11.0715Z"/>
<path fill="currentColor" d="M41.722 23.9906V5.85897H35.1924V3.78519H50.4935V5.85897H44.0199V23.9906H41.722Z"/>
</svg>`

export function renderOAuthResultPage(o: OAuthResultPageOptions): OAuthResultPage {
  const nonce = randomBytes(16).toString("base64")
  const contentSecurityPolicy = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    `font-src ${fontOrigin(o.staticBaseUrl)}`,
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ")
  const fonts = escapeHtml(o.staticBaseUrl.replace(/\/$/, ""))
  const returnUrl = escapeHtml(o.returnUrl)
  const returnLabel = escapeHtml(o.returnLabel ?? "Return to Teros")
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#F2F0F7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#201C27" media="(prefers-color-scheme: dark)">
<title>${escapeHtml(o.title)}</title>
<style>
  @font-face { font-family: "Saans"; src: url("${fonts}/fonts/Saans-Regular.otf") format("opentype"); font-weight: 400; font-display: swap; }
  @font-face { font-family: "Prody"; src: url("${fonts}/fonts/Prody-Regular.otf") format("opentype"); font-weight: 400; font-display: swap; }
  :root {
    --page: #F2F0F7; --card: #FFFFFF; --text: #342F3D; --text2: #575263; --text3: #968FA7;
    --accent: #6F27FF; --border: rgba(229,223,239,0.55); --wash: rgba(207,197,226,0.18);
    --r-bg: #FEE2E2; --r-tx: #EF4444; --r-bd: rgba(239,68,68,0.2);
    --lift: 0 24px 50px -30px rgba(111,39,255,0.30), 0 0 10px -7px rgba(52,47,61,0.16);
    --blob: .55;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --page: #201C27; --card: #17131E; --text: #FAF9FC; --text2: #CFC5E2; --text3: #968FA7;
      --accent: #9C6BFF; --border: rgba(250,249,252,0.04); --wash: rgba(250,249,252,0.04);
      --r-bg: rgba(239,68,68,0.09); --r-tx: #FEE2E2; --r-bd: rgba(239,68,68,0.3);
      --lift: 0 24px 50px -30px rgba(111,39,255,0.42), 0 0 10px -7px rgba(0,0,0,0.4);
      --blob: .32;
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: "Saans", system-ui, -apple-system, sans-serif; font-weight: 400;
    color: var(--text); background: var(--page);
    -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    min-height: 100%; padding: 24px 16px; position: relative; overflow: hidden;
  }
  .blob { position: absolute; border-radius: 999px; filter: blur(60px); opacity: var(--blob); pointer-events: none; }
  .blob.a { width: 260px; height: 420px; left: -80px; top: 10%; background: #1EFFCE; }
  .blob.b { width: 280px; height: 460px; right: -100px; bottom: 6%; background: #6F27FF; }
  .card {
    position: relative; width: 100%; max-width: 416px; padding: 36px 36px 28px;
    border-radius: 24px; background: var(--card); box-shadow: var(--lift);
  }
  .brand { color: var(--text); display: flex; margin-bottom: 26px; }
  h1 { font-family: "Prody", Georgia, serif; font-weight: 400; font-size: 30px; line-height: 34px; letter-spacing: -0.45px; }
  .lead { margin-top: 10px; font-size: 14px; line-height: 19px; color: var(--text2); }
  .status { margin-top: 24px; display: flex; align-items: center; gap: 12px; font-size: 13px; color: var(--text3); }
  .ring {
    width: 18px; height: 18px; border-radius: 50%; flex: none;
    border: 2px solid rgba(111,39,255,0.18); border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .banner {
    margin-top: 22px; display: flex; gap: 10px; align-items: flex-start;
    padding: 12px 14px; border-radius: 10px; background: var(--r-bg); border: 1px solid var(--r-bd);
    color: var(--r-tx); font-size: 14px; line-height: 19px; overflow-wrap: anywhere;
  }
  .banner svg { flex: none; margin-top: 1px; }
  .pill {
    margin-top: 18px; display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    width: 100%; height: 44px; padding: 0 20px; border-radius: 100px;
    background: #6F27FF; color: #FFFFFF; text-decoration: none; font-size: 15px;
    transition: filter .2s, transform .2s;
  }
  .pill:hover { filter: brightness(1.08); }
  .pill:active { transform: scale(.98); }
  .foot { margin-top: 20px; font-size: 12px; color: var(--text3); text-align: center; }
  @media (prefers-reduced-motion: reduce) { .ring { animation: none; } }
</style>
</head>
<body>
  <div class="blob a" aria-hidden="true"></div>
  <div class="blob b" aria-hidden="true"></div>
  <main class="card" role="status" aria-live="polite">
    <div class="brand">${WORDMARK_SVG}</div>
    <h1>${escapeHtml(o.heading)}</h1>
    <p class="lead">${escapeHtml(o.lead)}</p>
    ${
      o.success
        ? `<div class="status"><span class="ring" aria-hidden="true"></span><span>This window closes by itself.</span></div>`
        : `<div class="banner"><svg width="16" height="16" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M128 24a104 104 0 1 0 104 104A104.11 104.11 0 0 0 128 24Zm0 192a88 88 0 1 1 88-88 88.1 88.1 0 0 1-88 88Zm-8-80V80a8 8 0 0 1 16 0v56a8 8 0 0 1-16 0Zm20 36a12 12 0 1 1-12-12 12 12 0 0 1 12 12Z"/></svg><span>${escapeHtml(o.error || "Something went wrong.")}</span></div>
           <a class="pill" href="${returnUrl}">${returnLabel}</a>`
    }
  </main>
  <p class="foot">Teros · private alpha</p>
  <script nonce="${nonce}">${o.script}</script>
</body>
</html>`
  return { html, contentSecurityPolicy }
}
