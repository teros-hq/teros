#!/usr/bin/env npx tsx

import { readFileSync, writeFileSync } from 'fs';
import { google } from 'googleapis';
import { join } from 'path';
import readline from 'readline';

// Credentials are shared across agents in .secrets/
// Tokens are per-agent in mca-apps/
const CREDENTIALS_PATH = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '.secrets',
  'google-drive',
  'credentials.json',
);
const TOKEN_PATH = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'mca-apps',
  'google-drive-alice',
  'token.json',
);

// Scopes needed for Drive, Sheets, Slides, and Docs
const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/documents',
];

async function authorize() {
  const credentials = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
  const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;

  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });

  console.log('\n🔐 Google Drive Authorization\n');
  console.log('📌 Open this URL in your browser:\n');
  console.log(authUrl);
  console.log("\n📋 After authorization, you'll be redirected to a URL like:");
  console.log('http://localhost/?code=XXXX&scope=...\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const code = await new Promise<string>((resolve) => {
    rl.question('Enter the authorization code: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  console.log('\n🔄 Exchanging code for token...');

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

    console.log('\n✅ Token saved to:', TOKEN_PATH);
    console.log('\n🎉 You can now use Google Drive MCA!');
  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

authorize();
