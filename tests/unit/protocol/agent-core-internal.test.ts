/**
 * Invariant: the agent core is internal. No user-facing input surface accepts
 * a coreId — neither the WS protocol schemas nor the mca.teros.core tools.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CreateAgentMessageSchema,
  GenerateAgentProfileMessageSchema,
} from '../../../packages/shared/src/protocol';

describe('protocol schemas do not accept coreId', () => {
  it('CreateAgentMessageSchema drops coreId', () => {
    const parsed = CreateAgentMessageSchema.parse({
      type: 'create_agent',
      data: { coreId: 'super-agent', name: 'a', fullName: 'b', role: 'c', intro: 'd' },
    });
    expect('coreId' in parsed.data).toBe(false);
  });

  it('GenerateAgentProfileMessageSchema drops coreId', () => {
    const parsed = GenerateAgentProfileMessageSchema.parse({
      type: 'generate_agent_profile',
      data: { coreId: 'agent', excludeNames: [] },
    });
    expect('coreId' in parsed.data).toBe(false);
  });
});

describe('mca.teros.core tools do not expose cores', () => {
  const toolsPath = join(import.meta.dir, '../../../mcas/mca.teros.core/tools.json');
  const tools = JSON.parse(readFileSync(toolsPath, 'utf-8')).tools as Array<{
    name: string;
    inputSchema: { properties: Record<string, unknown>; required?: string[] };
  }>;

  it('create-agent has no coreId parameter', () => {
    const create = tools.find((t) => t.name === 'create-agent');
    expect(create).toBeDefined();
    expect(create?.inputSchema.properties.coreId).toBeUndefined();
    expect(create?.inputSchema.required ?? []).not.toContain('coreId');
  });

  it('list-agent-cores tool is removed', () => {
    expect(tools.find((t) => t.name === 'list-agent-cores')).toBeUndefined();
  });
});
