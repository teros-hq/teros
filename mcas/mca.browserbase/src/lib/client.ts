/**
 * Browserbase API Client
 *
 * Thin wrapper over the Browserbase REST API and SDK.
 * Handles session lifecycle and CDP connection management.
 */

import Browserbase from '@browserbasehq/sdk';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

// =============================================================================
// TYPES
// =============================================================================

export interface BrowserbaseSession {
  id: string;
  status: string;
  createdAt: string;
  liveViewUrl: string;
  connectUrl: string;
}

export interface ActiveSession {
  sessionId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  liveViewUrl: string;
  createdAt: string;
}

// =============================================================================
// SESSION STORE (in-memory, per MCA instance)
// =============================================================================

const activeSessions = new Map<string, ActiveSession>();

export function getActiveSession(sessionId: string): ActiveSession | undefined {
  return activeSessions.get(sessionId);
}

export function getActiveSessions(): ActiveSession[] {
  return Array.from(activeSessions.values());
}

export function removeSession(sessionId: string): void {
  activeSessions.delete(sessionId);
}

// =============================================================================
// SESSION MANAGEMENT
// =============================================================================

/**
 * Create a new Browserbase session and connect to it via CDP
 */
export async function createSession(
  apiKey: string,
  projectId: string,
  options: {
    proxies?: boolean;
    proxyCountry?: string;
    proxyCity?: string;
    stealth?: boolean;
    advancedStealth?: boolean;
    blockAds?: boolean;
    solveCaptchas?: boolean;
    os?: 'windows' | 'mac' | 'linux' | 'mobile' | 'tablet';
    viewport?: { width: number; height: number };
    region?: 'us-west-2' | 'us-east-1' | 'eu-central-1' | 'ap-southeast-1';
    keepAlive?: boolean;
    timeout?: number;
    contextId?: string;
    persistContext?: boolean;
  } = {},
): Promise<ActiveSession> {
  const bb = new Browserbase({ apiKey });

  // Build proxies config — if a country is specified, use geolocation proxy
  let proxiesConfig: boolean | Array<{ type: string; geolocation?: { country: string; city?: string } }> = options.proxies ?? false;
  if (options.proxies && (options.proxyCountry || options.proxyCity)) {
    proxiesConfig = [{
      type: 'browserbase',
      geolocation: {
        country: (options.proxyCountry ?? 'US').toUpperCase(),
        ...(options.proxyCity ? { city: options.proxyCity } : {}),
      },
    }];
  }

  // Create session via SDK
  const session = await bb.sessions.create({
    projectId,
    proxies: proxiesConfig as any,
    ...(options.region ? { region: options.region } : {}),
    ...(options.keepAlive !== undefined ? { keepAlive: options.keepAlive } : {}),
    browserSettings: {
      stealth: options.stealth ?? false,
      advancedStealth: options.advancedStealth ?? false,
      blockAds: options.blockAds ?? false,
      solveCaptchas: options.solveCaptchas ?? true,
      ...(options.os ? { os: options.os } : {}),
      viewport: options.viewport ?? { width: 1280, height: 720 },
      ...(options.contextId ? { context: { id: options.contextId, persist: options.persistContext ?? false } } : {}),
    },
    timeout: options.timeout ?? 3600,
  });

  // Get debug connection info (includes liveViewUrl)
  const debugInfo = await bb.sessions.debug(session.id);

  // Connect Playwright to the remote CDP session
  const browser = await chromium.connectOverCDP(debugInfo.wsUrl);
  const contexts = browser.contexts();
  const ctx = contexts[0] ?? (await browser.newContext());
  const pages = ctx.pages();
  const page = pages[0] ?? (await ctx.newPage());

  // Build the compiled Live View URL with properly encoded wss param
  // The wss value must be URL-encoded (slashes → %2F, etc.) for the viewer to work
  const originalUrl = debugInfo.debuggerFullscreenUrl;
  const wssMatch = originalUrl.match(/[?&]wss=(.+)$/);
  const wssRaw = wssMatch ? decodeURIComponent(wssMatch[1]) : '';
  const liveViewUrl = `https://www.browserbase.com/devtools-fullscreen-compiled/index.html?wss=${wssRaw.replace(/\//g, '%2F').replace(/\?/g, '%3F').replace(/=/g, '%3D').replace(/&/g, '%26')}`;

  const active: ActiveSession = {
    sessionId: session.id,
    browser,
    context: ctx,
    page,
    liveViewUrl,
    createdAt: new Date().toISOString(),
  };

  activeSessions.set(session.id, active);
  return active;
}

/**
 * Close a Browserbase session and clean up local state
 */
export async function closeSession(
  apiKey: string,
  sessionId: string,
): Promise<void> {
  const active = activeSessions.get(sessionId);

  if (active) {
    try {
      await active.browser.close();
    } catch {
      // ignore — session may already be gone
    }
    activeSessions.delete(sessionId);
  }

  // Also close on Browserbase side
  const bb = new Browserbase({ apiKey });
  try {
    await bb.sessions.update(sessionId, { status: 'REQUEST_RELEASE' });
  } catch {
    // ignore
  }
}

/**
 * Get or throw an active session
 */
export function requireSession(sessionId: string): ActiveSession {
  const session = activeSessions.get(sessionId);
  if (!session) {
    throw new Error(
      `No active session with id "${sessionId}". Use session-create first.`,
    );
  }
  return session;
}

// =============================================================================
// NETWORK REQUESTS (per session)
// =============================================================================

export interface NetworkRequest {
  url: string;
  method: string;
  status?: number;
  resourceType: string;
  timestamp: Date;
}

const networkRequestsMap = new Map<string, NetworkRequest[]>();

export function getNetworkRequests(sessionId: string): NetworkRequest[] {
  return networkRequestsMap.get(sessionId) ?? [];
}

export function initNetworkTracking(sessionId: string, page: Page): void {
  const requests: NetworkRequest[] = [];
  networkRequestsMap.set(sessionId, requests);

  page.on('request', (req) => {
    requests.push({
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      timestamp: new Date(),
    });
    if (requests.length > 500) requests.shift();
  });

  page.on('response', (res) => {
    const req = requests.findLast((r) => r.url === res.url() && !r.status);
    if (req) req.status = res.status();
  });
}

export function clearNetworkRequests(sessionId: string): void {
  networkRequestsMap.delete(sessionId);
}
