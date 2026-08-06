#!/usr/bin/env tsx
/**
 * Generate tools.json for MCAs
 *
 * This script spawns MCA processes temporarily, calls listTools(),
 * and saves the result to tools.json in each MCA directory.
 *
 * Usage:
 *   bun scripts/generate-mca-tools.ts                    # All MCAs
 *   bun scripts/generate-mca-tools.ts mca.teros.bash     # Specific MCA
 *   bun scripts/generate-mca-tools.ts --help             # Help
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { mergeCuratedAnnotations } from './lib/tool-annotations.js';

// Permissive tools/list result schema. The SDK's `client.listTools()` validates
// against ToolAnnotationsSchema, a closed z.object that silently STRIPS the
// Teros policy flags (`irreversible`, `alwaysAsk`) declared in the tool source.
// Requesting with this raw schema keeps every annotation key intact.
const RawListToolsResultSchema = z
  .object({ tools: z.array(z.record(z.string(), z.unknown())) })
  .passthrough();

// Get current directory - handle both ESM and CJS contexts
let scriptDir: string;

// First, try __dirname (CJS context or tsx with CJS interop)
// @ts-ignore - __dirname may not be defined in pure ESM
if (typeof __dirname !== 'undefined' && __dirname) {
  scriptDir = __dirname;
}
// Then try import.meta.url (ESM context)
else if (typeof import.meta !== 'undefined' && import.meta.url && typeof import.meta.url === 'string') {
  scriptDir = dirname(fileURLToPath(import.meta.url));
}
// Fallback to process.cwd() + /scripts
else {
  scriptDir = join(process.cwd(), 'scripts');
}

const __dirname_resolved = scriptDir;

const MCAS_PATH = join(__dirname_resolved, '../mcas');
const SECRETS_PATH = join(__dirname_resolved, '../.secrets');

interface ManifestExecution {
  command: string;
  args: string[];
  cwd?: string;
}

interface Manifest {
  id: string;
  name: string;
  entrypoint: string;
  execution?: ManifestExecution;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  annotations?: Record<string, unknown>;
}

/**
 * Discover all MCAs in the mcas directory
 */
function discoverMcas(): string[] {
  const entries = readdirSync(MCAS_PATH, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('mca.'))
    .map((entry) => entry.name);
}

/**
 * Load manifest for an MCA
 */
function loadManifest(mcaId: string): Manifest | null {
  const manifestPath = join(MCAS_PATH, mcaId, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error(`  ❌ No manifest.json found for ${mcaId}`);
    return null;
  }

  try {
    const content = readFileSync(manifestPath, 'utf-8');
    return JSON.parse(content);
  } catch (error: any) {
    console.log(`  ⚠️  Failed to parse manifest for ${mcaId}: ${error.message}`);
    return null;
  }
}

/**
 * Load secrets for an MCA from .secrets/mcas/<mcaId>/credentials.json
 */
function loadMcaSecrets(mcaId: string): Record<string, string> {
  const credentialsPath = join(SECRETS_PATH, 'mcas', mcaId, 'credentials.json');

  if (!existsSync(credentialsPath)) {
    return {};
  }

  try {
    const content = readFileSync(credentialsPath, 'utf-8');
    const secrets = JSON.parse(content);

    // Convert to SECRET_MCA_* env vars
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(secrets)) {
      if (value !== undefined && value !== null) {
        const envKey = `SECRET_MCA_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
        env[envKey] = String(value);
      }
    }
    return env;
  } catch (error: any) {
    console.warn(`  ⚠️  Failed to load secrets for ${mcaId}: ${error.message}`);
    return {};
  }
}

/**
 * Build execution config from manifest
 */
function buildExecutionConfig(
  mcaId: string,
  manifest: Manifest,
): { command: string; args: string[]; cwd: string } {
  const mcaPath = join(MCAS_PATH, mcaId);

  // If manifest has explicit execution config, use it
  if (manifest.execution) {
    return {
      command: manifest.execution.command,
      args: manifest.execution.args,
      cwd: manifest.execution.cwd ? join(MCAS_PATH, manifest.execution.cwd) : mcaPath,
    };
  }

  // Default: use tsx to run entrypoint
  return {
    command: 'tsx',
    args: [manifest.entrypoint],
    cwd: mcaPath,
  };
}

/**
 * Generate tools.json for a single MCA
 */
async function generateToolsForMca(mcaId: string): Promise<boolean> {
  console.log(`\n📦 Processing ${mcaId}...`);

  const manifest = loadManifest(mcaId);
  if (!manifest) return false;

  const { command, args, cwd } = buildExecutionConfig(mcaId, manifest);
  console.log(`  Command: ${command} ${args.join(' ')}`);
  console.log(`  CWD: ${cwd}`);

  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;

  try {
    // Load secrets for this MCA
    const secrets = loadMcaSecrets(mcaId);
    if (Object.keys(secrets).length > 0) {
      console.log(`  🔐 Loaded ${Object.keys(secrets).length} secret(s)`);
    }

    // Create transport with stderr captured to format as normal logs
    transport = new StdioClientTransport({
      command,
      args,
      cwd,
      stderr: 'pipe', // Capture stderr instead of inheriting
      env: {
        ...process.env,
        // Basic MCA env vars
        MCA_APP_ID: 'generate-tools',
        MCA_MCP_ID: mcaId,
        MCA_CWD: cwd,
        // Force stdio transport for tool discovery (MCAs may default to HTTP)
        MCA_TRANSPORT: 'stdio',
        // Inject secrets from .secrets/mcas/<mcaId>/credentials.json
        ...secrets,
      },
    });

    // Forward stderr to stdout (so it doesn't appear red in terminal)
    // The stderr getter returns a PassThrough stream immediately when stderr: 'pipe'
    const stderrStream = transport.stderr;
    if (stderrStream) {
      stderrStream.on('data', (data: Buffer) => {
        const lines = data.toString().trim().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            console.log(`  ${line}`);
          }
        }
      });
    }

    // Create client
    client = new Client({ name: 'generate-mca-tools', version: '1.0.0' }, { capabilities: {} });

    // Connect with timeout
    const connectPromise = client.connect(transport);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Connection timeout (10s)')), 10000),
    );

    await Promise.race([connectPromise, timeoutPromise]);
    console.log(`  ✅ Connected`);

    // Preserve author-curated catalog presentation (annotations.summary/group,
    // TER-538) from the existing tools.json: these aren't declared in code for
    // most MCAs, so a plain regen from listTools() would wipe them. We re-apply
    // them per tool unless the code already declares them.
    const toolsPath = join(MCAS_PATH, mcaId, 'tools.json');
    const curated: Record<string, { summary?: string; group?: string }> = {};
    try {
      if (existsSync(toolsPath)) {
        const prev = JSON.parse(readFileSync(toolsPath, 'utf-8')) as {
          tools?: Array<{ name: string; annotations?: { summary?: string; group?: string } }>;
        };
        for (const t of prev.tools ?? []) {
          const a = t.annotations;
          if (a && (a.summary || a.group)) curated[t.name] = { summary: a.summary, group: a.group };
        }
      }
    } catch {
      // Malformed previous tools.json — regen from scratch.
    }

    // List tools (raw schema — see RawListToolsResultSchema above)
    const toolsResponse = await client.request({ method: 'tools/list' }, RawListToolsResultSchema);
    const tools: ToolDefinition[] = toolsResponse.tools.map((tool) => {
      const def: ToolDefinition = {
        name: tool.name as string,
        description: (tool.description as string) || '',
        inputSchema: tool.inputSchema as ToolDefinition['inputSchema'],
      };
      const annotations = (tool as { annotations?: Record<string, unknown> }).annotations;
      const merged = mergeCuratedAnnotations(annotations, curated[tool.name]);
      if (merged) {
        def.annotations = merged;
      }
      return def;
    });

    console.log(`  📋 Found ${tools.length} tools:`);
    tools.forEach((t) => console.log(`     - ${t.name}`));

    // Write tools.json
    const output = {
      $schema: 'https://teros.ai/schemas/mca-tools.json',
      mcaId: manifest.id,
      tools,
    };

    writeFileSync(toolsPath, JSON.stringify(output, null, 2) + '\n');
    console.log(`  💾 Saved to tools.json`);

    return true;
  } catch (error: any) {
    console.error(`  ❌ Failed: ${error.message}`);
    return false;
  } finally {
    // Cleanup
    try {
      await client?.close();
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Generate tools for all MCAs (exported for programmatic use)
 */
async function generateMcaTools(
  mcaIds?: string[],
  options?: { quiet?: boolean },
): Promise<{ successful: string[]; failed: string[] }> {
  const quiet = options?.quiet ?? false;

  if (!quiet) console.log('🔧 MCA Tools Generator\n');

  // Determine which MCAs to process
  const idsToProcess = mcaIds?.length ? mcaIds : discoverMcas();

  if (!quiet) console.log(`Found ${idsToProcess.length} MCA(s) to process`);

  // Process each MCA
  const results: { mcaId: string; success: boolean }[] = [];

  for (const mcaId of idsToProcess) {
    const success = await generateToolsForMca(mcaId);
    results.push({ mcaId, success });
  }

  const successful = results.filter((r) => r.success).map((r) => r.mcaId);
  const failed = results.filter((r) => !r.success).map((r) => r.mcaId);

  if (!quiet) {
    console.log('\n' + '='.repeat(50));
    console.log('Summary:');
    console.log(`  ✅ Successful: ${successful.length}`);
    successful.forEach((id) => console.log(`     - ${id}`));

    if (failed.length > 0) {
      console.log(`  ❌ Failed: ${failed.length}`);
      failed.forEach((id) => console.log(`     - ${id}`));
    }
  }

  return { successful, failed };
}

/**
 * Main (CLI entry point)
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Generate tools.json for MCAs

Usage:
  bun scripts/generate-mca-tools.ts                    # All MCAs
  bun scripts/generate-mca-tools.ts mca.teros.bash     # Specific MCA
  bun scripts/generate-mca-tools.ts --help             # This help

This script spawns each MCA process, calls listTools(), and saves
the result to tools.json in the MCA directory.
`);
    process.exit(0);
  }

  if (args.length === 0) {
    console.error('❌ Error: specify at least one MCA ID');
    console.error('   Usage: tsx scripts/generate-mca-tools.ts mca.github');
    process.exit(1);
  }

  const { successful, failed } = await generateMcaTools(args);

  // Always exit 0 - failed MCAs are simply not included in the system
  // This allows the backend to start even if some MCAs are not implemented yet
  if (failed.length > 0) {
    console.log(`\n⚠️  ${failed.length} MCA(s) failed - they will not be available in the system`);
  }
  console.log(`\n✅ ${successful.length} MCA(s) ready\n`);

  process.exit(0);
}

// Run if called directly (works with both bun and tsx)
const isMain =
  typeof import.meta.main === 'boolean'
    ? import.meta.main // Bun
    : process.argv[1]?.endsWith('generate-mca-tools.ts') || // tsx direct
      process.argv[1]?.includes('generate-mca-tools'); // tsx via yarn

if (isMain) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { generateMcaTools, generateToolsForMca, discoverMcas };
