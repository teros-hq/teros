#!/usr/bin/env npx tsx

/**
 * mca.make — Make.com automation integration.
 *
 * Tools:
 *   - trigger-webhook        : POST a payload to a Make webhook URL (no token needed)
 *   - list-scenarios         : list account scenarios (requires MAKE_API_TOKEN)
 *   - run-scenario           : run a scenario on demand (requires MAKE_API_TOKEN)
 *   - create-scenario        : create a new scenario (requires MAKE_API_TOKEN)
 *   - get-scenario           : read a scenario (requires MAKE_API_TOKEN)
 *   - get-scenario-blueprint : read a scenario blueprint (requires MAKE_API_TOKEN)
 *   - update-scenario        : update a scenario (requires MAKE_API_TOKEN)
 *   - delete-scenario        : delete a scenario (requires MAKE_API_TOKEN)
 *   - clone-scenario         : clone a scenario (requires MAKE_API_TOKEN)
 *   - start-scenario         : activate a scenario (requires MAKE_API_TOKEN)
 *   - stop-scenario          : pause a scenario (requires MAKE_API_TOKEN)
 *   - -health-check          : SDK health contract
 *
 * Uses McaServer from @teros/mca-sdk for automatic transport detection.
 */

import { McaServer } from '@teros/mca-sdk';
import {
  cloneScenarioTool,
  createScenarioTool,
  deleteScenarioTool,
  getScenarioBlueprintTool,
  getScenarioTool,
  healthCheck,
  listScenariosTool,
  runScenarioTool,
  startScenarioTool,
  stopScenarioTool,
  triggerWebhookTool,
  updateScenarioTool,
} from './tools';

export function createMakeServer(): McaServer {
  const server = new McaServer({
    id: 'mca.make',
    name: 'Make',
    version: '2.0.0',
  });

  server.tool('-health-check', healthCheck);
  server.tool('trigger-webhook', triggerWebhookTool);
  server.tool('list-scenarios', listScenariosTool);
  server.tool('run-scenario', runScenarioTool);
  server.tool('create-scenario', createScenarioTool);
  server.tool('get-scenario', getScenarioTool);
  server.tool('get-scenario-blueprint', getScenarioBlueprintTool);
  server.tool('update-scenario', updateScenarioTool);
  server.tool('delete-scenario', deleteScenarioTool);
  server.tool('clone-scenario', cloneScenarioTool);
  server.tool('start-scenario', startScenarioTool);
  server.tool('stop-scenario', stopScenarioTool);

  return server;
}

const isDirectEntry = import.meta.url === `file://${process.argv[1]}`;
if (isDirectEntry) {
  const server = createMakeServer();
  server
    .start()
    .then(() => {
      console.error('Make MCA server running');
    })
    .catch((err) => {
      console.error('Failed to start Make MCA:', err);
      process.exit(1);
    });
}
