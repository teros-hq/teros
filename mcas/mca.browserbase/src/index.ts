#!/usr/bin/env bun

/**
 * Browserbase MCA v0.1.0
 *
 * Cloud browser automation at scale via Browserbase.
 * Supports session management, CDP-based navigation, and Live View streaming.
 *
 * The session-create tool emits a __teros_message__ of type "browser_live_view"
 * which the frontend intercepts to open the BrowserbaseWindow with the Live View iframe.
 */

import { McaServer } from '@teros/mca-sdk';
import {
  healthCheck,
  sessionCreate,
  sessionList,
  sessionClose,
  navigate,
  navigateBack,
  snapshot,
  getContent,
  click,
  type,
  fillForm,
  evaluate,
  pressKey,
  waitFor,
  takeScreenshot,
  networkRequests,
} from './tools/index.js';

// =============================================================================
// SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.browserbase',
  name: 'Browserbase',
  version: '0.1.0',
});

// =============================================================================
// TOOLS
// =============================================================================

server.tool('-health-check', healthCheck);

// Session management
server.tool('session-create', sessionCreate);
server.tool('session-list', sessionList);
server.tool('session-close', sessionClose);

// Navigation
server.tool('navigate', navigate);
server.tool('navigate-back', navigateBack);

// Page inspection
server.tool('snapshot', snapshot);
server.tool('get-content', getContent);
server.tool('take-screenshot', takeScreenshot);
server.tool('network-requests', networkRequests);

// Interaction
server.tool('click', click);
server.tool('type', type);
server.tool('fill-form', fillForm);
server.tool('evaluate', evaluate);
server.tool('press-key', pressKey);
server.tool('wait-for', waitFor);

// =============================================================================
// START
// =============================================================================

server.start().catch((error) => {
  console.error('[Browserbase MCA] Fatal error:', error);
  process.exit(1);
});
