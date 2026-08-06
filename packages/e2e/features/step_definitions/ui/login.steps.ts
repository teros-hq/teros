import { Given, Then, When } from '@cucumber/cucumber';
import { expect } from 'chai';
import type { UIWorld } from '../../support/world.ui';

// ── Given ─────────────────────────────────────────────────────────────────────

Given('the frontend is reachable', async function (this: UIWorld) {
  const url = `${this.getFrontendUrl()}/health`;
  const response = await fetch(url);
  expect(response.ok, `GET ${url} returned ${response.status}`).to.be.true;
});

Given('I open the login page', async function (this: UIWorld) {
  await this.page!.goto(this.getFrontendUrl());
  // Wait for the login screen to be ready (logo is always present)
  await this.page!.waitForSelector('text=TEROS', { timeout: 15000 });
});

// ── When ──────────────────────────────────────────────────────────────────────

When('I navigate to the email login form', async function (this: UIWorld) {
  await this.page!.click('text=Sign in with email');
  // Wait for the email input to appear
  await this.page!.waitForSelector('input[autocomplete="email"]', { timeout: 10000 });
});

When('I fill in the email {string}', async function (this: UIWorld, email: string) {
  await this.page!.fill('input[autocomplete="email"]', email);
});

When('I fill in the password {string}', async function (this: UIWorld, password: string) {
  await this.page!.fill('input[autocomplete="current-password"]', password);
});

When('I click the sign in button', async function (this: UIWorld) {
  await this.page!.click('text=Sign in');
});

// ── Then ──────────────────────────────────────────────────────────────────────

Then('I should be redirected to the workspace', async function (this: UIWorld) {
  // After a successful login the app replaces the route with "/"
  // and renders the workspace. We wait for the URL to leave the auth section.
  await this.page!.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });
  const url = this.page!.url();
  expect(url).to.not.include('/login');
});

Then('I should see a login error message', async function (this: UIWorld) {
  // The email login screen renders an error XStack when auth fails.
  // We wait for the red error text to appear.
  await this.page!.waitForSelector('[style*="rgb(239, 68, 68)"], text=Incorrect, text=failed', {
    timeout: 10000,
  });
  // Confirm we are still on the login page
  expect(this.page!.url()).to.include('/login');
});
