import type { HttpToolConfig } from '@teros/mca-sdk';
import { createSession, initNetworkTracking } from '../lib/index.js';

export const sessionCreate: HttpToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a new Browserbase cloud browser session. Returns a sessionId to use with all other tools, and opens a Live View window so you can watch the browser in real time.',
  parameters: {
    type: 'object',
    properties: {
      proxies: {
        type: 'boolean',
        description: 'Enable residential proxies for stealth (default: false)',
      },
      proxyCountry: {
        type: 'string',
        description: 'ISO 3166-1 alpha-2 country code for proxy geolocation (e.g. "ES" for Spain, "US" for USA). Only used when proxies is true.',
      },
      proxyCity: {
        type: 'string',
        description: 'City name for proxy geolocation (e.g. "Madrid", "New York"). Only used when proxies is true.',
      },
      stealth: {
        type: 'boolean',
        description: 'Enable stealth mode to bypass bot detection (default: false)',
      },
      advancedStealth: {
        type: 'boolean',
        description: 'Enable advanced stealth mode for stronger bot detection bypass (default: false)',
      },
      blockAds: {
        type: 'boolean',
        description: 'Block ads in the browser (default: false)',
      },
      solveCaptchas: {
        type: 'boolean',
        description: 'Automatically solve CAPTCHAs (default: true)',
      },
      os: {
        type: 'string',
        enum: ['windows', 'mac', 'linux', 'mobile', 'tablet'],
        description: 'Operating system to simulate for stealth mode',
      },
      region: {
        type: 'string',
        enum: ['us-west-2', 'us-east-1', 'eu-central-1', 'ap-southeast-1'],
        description: 'Server region where the session runs (default: us-west-2)',
      },
      keepAlive: {
        type: 'boolean',
        description: 'Keep session alive after disconnections (requires Hobby plan or above)',
      },
      timeout: {
        type: 'number',
        description: 'Session timeout in seconds (default: 3600)',
      },
      contextId: {
        type: 'string',
        description: 'Reuse a saved browser context ID (cookies, localStorage, etc.)',
      },
      persistContext: {
        type: 'boolean',
        description: 'Persist the context after the session ends (default: false). Only used when contextId is provided.',
      },
    },
  },
  handler: async (args, context) => {
    const secrets = await context.getUserSecrets();
    const apiKey = secrets.BROWSERBASE_API_KEY;
    const projectId = secrets.BROWSERBASE_PROJECT_ID;

    if (!apiKey || !projectId) {
      throw new Error('BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID must be configured in app settings.');
    }

    const session = await createSession(apiKey, projectId, {
      proxies: args.proxies as boolean | undefined,
      proxyCountry: args.proxyCountry as string | undefined,
      proxyCity: args.proxyCity as string | undefined,
      stealth: args.stealth as boolean | undefined,
      advancedStealth: args.advancedStealth as boolean | undefined,
      blockAds: args.blockAds as boolean | undefined,
      solveCaptchas: args.solveCaptchas as boolean | undefined,
      os: args.os as 'windows' | 'mac' | 'linux' | 'mobile' | 'tablet' | undefined,
      region: args.region as 'us-west-2' | 'us-east-1' | 'eu-central-1' | 'ap-southeast-1' | undefined,
      keepAlive: args.keepAlive as boolean | undefined,
      timeout: args.timeout as number | undefined,
      contextId: args.contextId as string | undefined,
      persistContext: args.persistContext as boolean | undefined,
    });

    // Start tracking network requests for this session
    initNetworkTracking(session.sessionId, session.page);

    return {
      success: true,
      sessionId: session.sessionId,
      liveViewUrl: session.liveViewUrl,
      createdAt: session.createdAt,
      // Special Teros message to open the Live View window in the UI
      __teros_message__: {
        type: 'browser_live_view',
        sessionId: session.sessionId,
        url: session.liveViewUrl,
        caption: `Browserbase Session — ${session.sessionId.slice(0, 8)}...`,
      },
      description: `Session created: ${session.sessionId}. Live View is now open.`,
    };
  },
};
