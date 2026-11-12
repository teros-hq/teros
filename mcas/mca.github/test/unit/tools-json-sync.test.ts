import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as tools from '../../src/tools';
import { REST_TOOLS } from '../../src/tools/rest-tools';

const toolsJson = JSON.parse(readFileSync(resolve(import.meta.dir, '../../tools.json'), 'utf8')) as {
  tools: Array<{ name: string; description: string; inputSchema: unknown }>;
};

const camel = (name: string) => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function codeTool(name: string): { description: string; parameters: unknown } | undefined {
  return (REST_TOOLS[name] ?? (tools as Record<string, unknown>)[camel(name)]) as
    | { description: string; parameters: unknown }
    | undefined;
}

describe('tools.json matches the code the model is described from', () => {
  for (const entry of toolsJson.tools.filter((t) => !t.name.startsWith('-'))) {
    it(`${entry.name}: description and input schema`, () => {
      const tool = codeTool(entry.name);
      expect(tool, `${entry.name} is in tools.json but not in the code`).toBeDefined();
      expect(entry.description).toBe(tool!.description);
      expect(entry.inputSchema).toEqual(JSON.parse(JSON.stringify(tool!.parameters)));
    });
  }
});
