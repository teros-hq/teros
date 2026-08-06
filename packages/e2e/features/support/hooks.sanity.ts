import { After, Before, Status } from '@cucumber/cucumber';
import type { CustomWorld } from './world';

Before(async function (this: CustomWorld) {
  this.client = null;
  this.lastResponse = null;
  this.channelId = null;
  this.sessionToken = null;
  this.userId = null;
});

After(async function (this: CustomWorld, scenario) {
  await this.cleanup();
  if (scenario.result?.status === Status.FAILED) {
    console.log('❌ Scenario failed:', scenario.pickle.name);
  }
});
