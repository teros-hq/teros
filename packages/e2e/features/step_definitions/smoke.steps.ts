/**
 * Step definitions for smoke.feature
 *
 * These steps are intentionally minimal — they validate that the embedded
 * TestServer starts correctly and that the auth flow works end-to-end through
 * the Cucumber infrastructure.
 */

import { Then } from '@cucumber/cucumber';
import { expect } from 'chai';
import type { CustomWorld } from '../support/world';

function getHttpUrl(): string {
  return process.env.E2E_HTTP_URL || 'http://localhost:3002';
}

Then('the HTTP health endpoint should return OK', async function (this: CustomWorld) {
  const url = `${getHttpUrl()}/health`;
  const response = await fetch(url);
  expect(response.ok, `GET ${url} returned ${response.status}`).to.be.true;
});
