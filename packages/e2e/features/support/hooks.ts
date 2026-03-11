import { After, AfterAll, Before, BeforeAll, Status } from '@cucumber/cucumber';
import { closeDb, waitForBackend } from '../../src/utils/setup';
import type { CustomWorld } from './world';

BeforeAll(async () => {
  console.log('🚀 Starting E2E test suite...');
  await waitForBackend();
  console.log('✅ Backend is ready');
});

AfterAll(async () => {
  console.log('🧹 Cleaning up E2E test suite...');
  await closeDb();
  console.log('✅ Cleanup complete');
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
