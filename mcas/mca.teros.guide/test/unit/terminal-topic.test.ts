/**
 * El topic `terminal-claude-code` es el playbook al que apuntan los core
 * prompts (`base-*-core.md` → "guide topic `terminal-claude-code`"). MUERDE:
 * si el id cambia, si search-guide deja de encontrarlo, o si se cae una de las
 * reglas que piden los prompts (proponer una vez, memoria, no instalar sin sí,
 * el volante, cerrar lo abierto), falla.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GUIDE_TOPICS } from '../../src/content/topics';
import { searchGuide, type SearchGuideOutput } from '../../src/tools/search-guide';

const topic = GUIDE_TOPICS.find((t) => t.id === 'terminal-claude-code');

// biome-ignore lint/suspicious/noExplicitAny: el handler no usa el ToolContext
const CTX: any = {};
const run = (query: string) => searchGuide.handler({ query }, CTX) as Promise<SearchGuideOutput>;

describe('topic terminal-claude-code', () => {
  test('existe y no se dispara de tamaño', () => {
    expect(topic).toBeDefined();
    expect(topic!.body.length).toBeLessThanOrEqual(4500);
  });

  test('los core prompts apuntan a este id', () => {
    const prompts = join(import.meta.dir, '../../../../packages/backend/src/prompts');
    for (const file of ['base-agent-core.md', 'base-super-agent-core.md']) {
      expect(readFileSync(join(prompts, file), 'utf8')).toContain('guide topic `terminal-claude-code`');
    }
  });

  test.each([
    ['claude code terminal'],
    ['open claude code with my subscription'],
    ['the wheel in the terminal'],
  ])('search-guide "%s" → top-1', async (query) => {
    const out = await run(query);
    expect(out.results[0]?.id).toBe('terminal-claude-code');
  });

  test.each([
    ['memoria antes de proponer', 'Check the remembered preference first'],
    ['categoría de memoria', '`user_preferences`'],
    ['una mención por conversación', 'At most one mention per conversation'],
    ['no insistir tras un no', 'After a no: no more mentions in this conversation'],
    ['nunca instalar sin sí', 'only after the user\'s explicit yes'],
    ['compartir el sign-in con los agentes', '"Share with this workspace\'s agents"'],
    ['respetar el volante', 'if the user has it, don\'t type'],
    ['cerrar lo que abrió', 'close the sessions you opened'],
  ])('cubre: %s', (_label, needle) => {
    expect(topic!.body).toContain(needle);
  });
});
