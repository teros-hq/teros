#!/usr/bin/env bun

/**
 * Claude OAuth Login Script
 *
 * Authenticates with Claude Max subscription using OAuth 2.0 + PKCE flow.
 * This allows using your Claude Max subscription instead of API keys.
 *
 * Usage:
 *   bun src/scripts/claude-oauth-login.ts
 *
 * Or with yarn:
 *   yarn workspace @teros/backend oauth:login
 */

import {
  CLAUDE_4_5,
  exchangeCodeForTokens,
  generateAuthorizationUrl,
  hasOAuthTokens,
  LLMClientFactory,
  loadOAuthTokens,
} from '@teros/core';
import * as readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function main() {
  console.log('🔐 Claude Max OAuth Authentication');
  console.log('='.repeat(50));
  console.log('');
  console.log('This will authenticate with your Claude Max subscription');
  console.log('to use Claude without API keys.');
  console.log('');

  // Check existing tokens
  if (hasOAuthTokens()) {
    const tokens = await loadOAuthTokens();
    if (tokens) {
      const expiresAt = new Date(tokens.expiresAt);
      const isExpired = expiresAt < new Date();

      console.log('📋 Existing tokens found:');
      console.log(
        `   Expires: ${expiresAt.toISOString()} ${isExpired ? '(EXPIRED ⚠️)' : '(valid ✅)'}`,
      );
      console.log('');

      if (!isExpired) {
        const answer = await question('Tokens are still valid. Re-authenticate anyway? (y/N): ');
        if (answer.toLowerCase() !== 'y') {
          console.log('\n✅ Using existing tokens.');
          rl.close();
          return;
        }
      }
    }
  }

  // Generate authorization URL
  console.log('📝 Step 1: Generating authorization URL...');
  const { url, verifier } = generateAuthorizationUrl();

  console.log('');
  console.log('🌐 Step 2: Open this URL in your browser:');
  console.log('');
  console.log(`   ${url}`);
  console.log('');
  console.log('📋 Step 3: After logging in:');
  console.log('   1. You will be redirected to a page');
  console.log('   2. Copy the FULL URL from your browser address bar');
  console.log('   3. Paste it below');
  console.log('');

  // Try to open browser automatically
  try {
    const { exec } = await import('child_process');
    const platform = process.platform;

    if (platform === 'darwin') {
      exec(`open "${url}"`);
      console.log('   (Browser opened automatically on macOS)');
    } else if (platform === 'linux') {
      exec(`xdg-open "${url}"`);
      console.log('   (Browser opened automatically on Linux)');
    } else if (platform === 'win32') {
      exec(`start "${url}"`);
      console.log('   (Browser opened automatically on Windows)');
    }
  } catch {
    // Ignore if can't open browser
  }

  console.log('');
  const callbackUrl = await question('Callback URL: ');

  if (!callbackUrl.trim()) {
    console.log('\n❌ No URL provided. Authentication cancelled.');
    rl.close();
    return;
  }

  // Exchange code for tokens
  console.log('');
  console.log('🔄 Step 4: Exchanging authorization code for tokens...');

  const tokens = await exchangeCodeForTokens(callbackUrl.trim(), verifier);

  if (!tokens) {
    console.log('\n❌ Authentication failed. Please try again.');
    rl.close();
    return;
  }

  console.log('');
  console.log('✅ Authentication successful!');
  console.log('');
  console.log(`   Access Token: ${tokens.accessToken.slice(0, 30)}...`);
  console.log(`   Refresh Token: ${tokens.refreshToken.slice(0, 20)}...`);
  console.log(`   Expires At: ${new Date(tokens.expiresAt).toISOString()}`);
  console.log('');
  console.log('   Tokens saved to: ~/.claude-oauth/tokens.json');
  console.log('');

  // Test the tokens
  console.log('🧪 Step 5: Testing authentication...');

  try {
    const info = await LLMClientFactory.getCredentialsInfo();
    console.log(`   Available: ${info.available.join(', ')}`);
    console.log(`   Recommended: ${info.recommended}`);

    // Try creating a client
    const client = await LLMClientFactory.create({
      provider: 'anthropic',
      anthropic: {
        model: CLAUDE_4_5.SONNET,
      },
    });

    const providerInfo = client.getProviderInfo();
    console.log(`   Provider: ${providerInfo.name}`);
    console.log(`   Model: ${providerInfo.model}`);
    console.log('');
    console.log('✅ Ready to use Claude!');
  } catch (error: any) {
    console.log(`   ⚠️ Test failed: ${error.message}`);
  }

  console.log('');
  console.log('='.repeat(50));
  rl.close();
}

main().catch((error) => {
  console.error('Error:', error);
  rl.close();
  process.exit(1);
});
