import { Given } from '@cucumber/cucumber';
import { expect } from 'chai';
import { getHttpUrl } from '../support/real-server';
import type { CustomWorld } from '../support/world';

Given('the backend is reachable', async function (this: CustomWorld) {
  const url = `${getHttpUrl()}/health`;
  const response = await fetch(url);
  expect(response.ok, `GET ${url} returned ${response.status}`).to.be.true;
});
