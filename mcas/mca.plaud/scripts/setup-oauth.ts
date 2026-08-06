#!/usr/bin/env bun
/**
 * PLAUD OAuth Client Registration Script
 *
 * Registers a dynamic OAuth client with the Plaud MCP server and writes
 * the resulting CLIENT_ID to the Teros system secrets directory.
 *
 * Usage:
 *   bun scripts/setup-oauth.ts --domain <domain> [--output /path]
 *
 * Examples:
 *   bun scripts/setup-oauth.ts --domain be.teros.ai
 *   bun scripts/setup-oauth.ts --domain be.teros.ai --output ./credentials.json
 *   TEROS_DOMAIN=be.teros.ai bun scripts/setup-oauth.ts
 *
 * The script reads the Plaud manifest for OAuth metadata, then calls
 * Plaud's Dynamic Client Registration endpoint (RFC 7591) to obtain a
 * public PKCE client_id. The redirect_uri is built as:
 *   https://<domain>/auth/mca/callback
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'

// ---------------------------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------------------------

const DEFAULT_REGISTRATION_URL = 'https://mcp.plaud.ai/register'

interface RegistrationPayload {
  redirect_uris: string[]
  token_endpoint_auth_method: 'none'
  grant_types: string[]
  response_types: string[]
  client_name: string
  client_uri: string
}

interface RegistrationResponse {
  client_id: string
  client_id_issued_at?: number
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(): {
  domain: string
  appName: string
  outputPath: string
} {
  const args = process.argv.slice(2)

  // 1. Try env var first
  let domain = process.env.TEROS_DOMAIN || ''
  let appName = process.env.TEROS_APP_NAME || 'Teros'
  let outputPath = ''

  // 2. Override with CLI flags
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--domain' && args[i + 1]) {
      domain = args[i + 1]
      i++
    }
    if (args[i] === '--app-name' && args[i + 1]) {
      appName = args[i + 1]
      i++
    }
    if (args[i] === '--output' && args[i + 1]) {
      outputPath = args[i + 1]
      i++
    }
  }

  if (!domain) {
    console.error('\n❌ Error: --domain is required.')
    console.error('\nUsage:')
    console.error('  bun scripts/setup-oauth.ts --domain <domain> [--output <path>]')
    console.error('\nExamples:')
    console.error('  bun scripts/setup-oauth.ts --domain be.teros.ai')
    console.error('  bun scripts/setup-oauth.ts --domain be.teros.ai --app-name "Teros Prod"')
    console.error('\nOr set the environment variable:')
    console.error('  TEROS_DOMAIN=be.teros.ai bun scripts/setup-oauth.ts')
    console.error('')
    process.exit(1)
  }

  if (!outputPath) {
    const base = resolve(import.meta.dir, '../../../../.secrets/mcas/mca.plaud')
    outputPath = resolve(base, 'credentials.json')
  }

  return { domain, appName, outputPath }
}

// ---------------------------------------------------------------------------
// MANIFEST READER
// ---------------------------------------------------------------------------

function readManifest(): {
  authorizeUrl: string
  tokenUrl: string
  scopes: string[]
} {
  const manifestPath = resolve(import.meta.dir, '../manifest.json')
  const raw = readFileSync(manifestPath, 'utf-8')
  const manifest = JSON.parse(raw)

  const auth = manifest.layers?.auth
  if (!auth || auth.type !== 'oauth2') {
    throw new Error('Manifest does not declare oauth2 auth configuration')
  }

  return {
    authorizeUrl: auth.authorizeUrl,
    tokenUrl: auth.tokenUrl,
    scopes: auth.scopes || [],
  }
}

// ---------------------------------------------------------------------------
// REGISTRATION
// ---------------------------------------------------------------------------

async function registerClient(
  domain: string,
  appName: string,
): Promise<RegistrationResponse> {
  const redirectUri = `https://${domain}/auth/mca/callback`

  const payload: RegistrationPayload = {
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: appName,
    client_uri: 'https://teros.ai',
  }

  console.log(`\n🔄 Registering OAuth client with Plaud...`)
  console.log(`   Domain:         ${domain}`)
  console.log(`   Redirect URI:   ${redirectUri}`)
  console.log(`   App name:       ${appName}`)
  console.log(`   Endpoint:       ${DEFAULT_REGISTRATION_URL}`)

  const response = await fetch(DEFAULT_REGISTRATION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(
      `Registration failed (${response.status} ${response.statusText}): ${body}`,
    )
  }

  const data = (await response.json()) as RegistrationResponse

  if (!data.client_id || typeof data.client_id !== 'string') {
    throw new Error('Registration response missing client_id')
  }

  return data
}

// ---------------------------------------------------------------------------
// SECRET PERSISTENCE
// ---------------------------------------------------------------------------

async function writeCredentials(
  outputPath: string,
  clientId: string,
): Promise<void> {
  await Bun.write(
    outputPath,
    JSON.stringify({ CLIENT_ID: clientId }, null, 2) + '\n',
  )
  console.log(`\n✅ Credentials written to: ${outputPath}`)
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { domain, appName, outputPath } = parseArgs()

  // Verify manifest is readable
  const manifest = readManifest()
  console.log('\n📄 Manifest loaded:')
  console.log(`   Authorize URL: ${manifest.authorizeUrl}`)
  console.log(`   Token URL:     ${manifest.tokenUrl}`)
  console.log(`   Scopes:        ${manifest.scopes.join(' ')}`)

  // Register the client
  const registration = await registerClient(domain, appName)

  console.log('\n🔑 Registration successful:')
  console.log(`   client_id:        ${registration.client_id}`)
  if (registration.client_id_issued_at) {
    const issuedAt = new Date(registration.client_id_issued_at * 1000)
    console.log(`   client_id_issued_at: ${issuedAt.toISOString()}`)
  }

  // Persist
  await writeCredentials(outputPath, registration.client_id)

  console.log('\n📋 Next steps:')
  console.log('   1. Run sync-mcas:  bun packages/backend/src/scripts/sync-mcas.ts')
  console.log('   2. Restart backend: admin-restart-backend')
  console.log('   3. In the Teros UI, click "Conectar con Plaud" to authorize.')
  console.log('')
}

main().catch((error) => {
  console.error('\n❌ Error:', error.message)
  process.exit(1)
})
