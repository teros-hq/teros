import { type IWorldOptions, setWorldConstructor } from '@cucumber/cucumber';
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { CustomWorld } from './world';

export class UIWorld extends CustomWorld {
  browser: Browser | null = null;
  context: BrowserContext | null = null;
  page: Page | null = null;

  constructor(options: IWorldOptions) {
    super(options);
  }

  async openBrowser(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
  }

  async closeBrowser(): Promise<void> {
    await this.page?.close();
    await this.context?.close();
    await this.browser?.close();
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  getFrontendUrl(): string {
    return process.env.E2E_FRONTEND_URL || 'http://localhost:3000';
  }
}

setWorldConstructor(UIWorld);
