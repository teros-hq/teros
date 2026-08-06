import { After, AfterAll, Before, BeforeAll, Status } from '@cucumber/cucumber';
import { startTestServer, stopTestServer } from './server';
import type { CustomWorld } from './world';

BeforeAll(async () => {
  console.log('🚀 Starting embedded TestServer for Cucumber suite...');
  await startTestServer();
  console.log('✅ TestServer is ready');
});

AfterAll(async () => {
  console.log('🧹 Stopping TestServer...');
  await stopTestServer();
  console.log('✅ TestServer stopped');
});

Before(async function (this: CustomWorld) {
  // Fresh state for each scenario
  this.client = null;
  this.lastResponse = null;
  this.channelId = null;
  this.sessionToken = null;
  this.userId = null;
});

After(async function (this: CustomWorld, scenario) {
  // Cleanup after each scenario
  await this.cleanup();

  if (scenario.result?.status === Status.FAILED) {
    console.log('❌ Scenario failed:', scenario.pickle.name);
  }
});
