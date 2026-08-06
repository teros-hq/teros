#!/usr/bin/env node
/**
 * Aislated smoke for mca.teros.guide over the REAL MCP transport (stdio).
 * Spawns the MCA, connects an MCP client, and CALLS the three tools — closing
 * the loop the unit tests don't (serialization across the transport). Not part
 * of the unit suite; run manually: `node test/smoke-mcp.mjs` from the MCA dir.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'tsx',
  args: ['src/index.ts'],
  cwd: process.cwd(),
  stderr: 'ignore',
  env: { ...process.env, MCA_TRANSPORT: 'stdio', MCA_MCP_ID: 'mca.teros.guide' },
});

const client = new Client({ name: 'guide-smoke', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

function structured(res) {
  // Replicate exactly what the backend does: concatenate the text content
  // parts into the agent-visible output, then parse (mca-manager.tools.ts).
  const text = (res.content ?? [])
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text)
    .join('');
  return text ? JSON.parse(text) : null;
}

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? '✅' : '❌'} ${msg}`);
  if (!cond) failures++;
};

// 1) list-guide-topics
const list = structured(await client.callTool({ name: 'list-guide-topics', arguments: {} }));
check(list?.count === 13 && list.topics.length === 13, `list-guide-topics → ${list?.count} topics`);
check(list.topics.some((t) => t.id === 'profile'), 'index includes the new "profile" topic');
check(
  list.topics.every((t) => t.id && t.title && t.summary && t.body === undefined),
  'index entries have id+title+summary and NO body (cheap index)',
);

// 1b) search-guide
const search = structured(
  await client.callTool({ name: 'search-guide', arguments: { query: 'how do I create an agent' } }),
);
check(search?.results?.[0]?.id === 'agents', `search-guide('create agent') → top-1 ${search?.results?.[0]?.id}`);
check(
  typeof search?.results?.[0]?.snippet === 'string' && search.results[0].snippet.length > 0,
  'search result has a snippet',
);
const search2 = structured(
  await client.callTool({ name: 'search-guide', arguments: { query: 'connect gmail' } }),
);
check(search2?.results?.[0]?.id === 'apps-and-providers', `search-guide('connect gmail') → top-1 ${search2?.results?.[0]?.id}`);

// 2) get-guide-section (valid)
const agents = structured(
  await client.callTool({ name: 'get-guide-section', arguments: { topic: 'agents' } }),
);
check(agents?.id === 'agents', `get-guide-section('agents') → id=${agents?.id}`);
check(/Create Agent/.test(agents?.body ?? ''), 'agents body mentions the real "Create Agent" window');

// 3) get-guide-section (invalid → fail-loud error surfaced over the transport)
const bad = await client.callTool({ name: 'get-guide-section', arguments: { topic: 'nope' } });
const badText = JSON.stringify(bad);
check(bad.isError === true || /Unknown guide topic/.test(badText), 'invalid topic → error surfaced');
check(/agents/.test(badText), 'error lists the valid topics (fail-loud)');

// 4) -health-check
const health = structured(await client.callTool({ name: '-health-check', arguments: {} }));
check(health?.status === 'ready', `-health-check → status=${health?.status}`);
check(health?.version === '1.0.0' && typeof health?.uptime === 'number', 'health has version+uptime');

await client.close();
console.log(failures === 0 ? '\n✅ SMOKE PASS' : `\n❌ SMOKE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
