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
    expect(topic!.body.length).toBeLessThanOrEqual(5800);
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
    ['agent off switch in the terminal'],
    ['claude code login screen api key'],
  ])('search-guide "%s" → top-1', async (query) => {
    const out = await run(query);
    expect(out.results[0]?.id).toBe('terminal-claude-code');
  });

  test.each([
    ['memoria antes de proponer', 'Check the remembered preference first'],
    ['categoría de memoria', '`user_preferences`'],
    ['una mención por conversación', 'At most one mention per conversation'],
    ['un bug en un repo: en la primera respuesta', 'say it in your first reply, before you start'],
    ['no insistir tras un no', 'After a no: no more mentions in this conversation'],
    ['nunca instalar sin sí', 'only after the user\'s explicit yes'],
    ['[TW-AC-11] una persona escribiendo: no escribir', 'don\'t type: wait'],
    ['[TW-AC-13] pedir el control', '`terminal-request-control`'],
    ['cerrar lo que abrió', 'close the sessions you opened'],
    ['[SPACE-AC-26] un terminal compartido pide un Bash compartido', 'people open one only if **Bash** is shared'],
  ])('cubre: %s', (_label, needle) => {
    expect(topic!.body).toContain(needle);
  });

  test.each([
    ['dónde corre', "workspace's Linux machine"],
    ['lo ve en directo', 'live'],
    ['[TW-AC-9] el interruptor encendido', '**"Agent"**'],
    ['[TW-AC-9] el interruptor apagado', '**"Agent off"**'],
    ['[TW-AC-9] apagado en la sesión de una persona, encendido en la tuya', 'on in the sessions you open and off in the sessions a person opens'],
    ['[TW-AC-10] apagado: ni se lista ni se lee', "isn't in `terminal-list`"],
    ['[TW-AC-11] mientras escribes, sus teclas no se envían', 'while you type, their keys are not sent'],
    ['[TW-AC-12] en tu sesión vuelves a escribir tras 60 s', 'typed nothing for 60 s'],
    ['soltarlo', '`terminal-release-control`'],
    ['un clic no cambia nada', 'A click or scroll alone'],
    ['etiquetas en español', '"Agente" / "Agente off"'],
    ['[TW-AC-13] botones en español', '"Permitir" / "Mantener apagado"'],
    ['[TW-AC-2] una ventana, una sesión', 'One window, one session'],
    ['[TW-AC-4] la lista de sesiones', '"Sessions"'],
    ['[TW-AC-5] cerrar la ventana no termina la sesión', "Closing a window doesn't end the session"],
    ['[TW-AC-5] terminar la sesión', '"End session"'],
    ['[SPACE-AC-19] dos espacios: personal o compartido', 'is **Personal** (theirs'],
    ['[SPACE-AC-19] las tuyas son siempre compartidas', 'Sessions you open are always shared'],
    ['[SPACE-AC-15] dejar mirar es solo lectura', '"Let the workspace watch"'],
    ['[TW-AC-16] las de los agentes las ven los miembros', "visible to the workspace's members"],
    ['[TW-AC-17] solo tu workspace', 'sessions of your own workspace'],
  ])('lo que la persona ve: %s', (_label, needle) => {
    expect(topic!.body).toContain(needle);
  });

  test('[TW-AC-13] nombra los botones que la persona ve de verdad, nunca Approve / Deny', () => {
    expect(topic!.body).toContain('"Allow" / "Keep off"');
    expect(topic!.body).not.toMatch(/Approve|Deny/);
  });

  test('[TW-AC-23] Claude Code va con la clave de API del proveedor Anthropic del propietario del workspace', () => {
    expect(topic!.body).toContain("API key of the workspace owner's Anthropic provider");
    expect(topic!.body).toContain('**Providers**');
    expect(topic!.body).toContain('login screen');
    expect(topic!.body).toContain('their own Terminal and sign in there by themselves');
  });

  test('[TW-AC-22] Teros no gestiona ningún inicio de sesión de Claude: ni tool, ni tarjeta, ni volante', () => {
    expect(topic!.body).toContain('Teros never asks for, stores or shares a Claude sign-in');
    expect(topic!.body).not.toMatch(
      /request-sign-in|request-wheel|release-wheel|the wheel|Take the wheel|Give back to|Give it to|Keep it|volante|Share my Claude sign-in|Open Claude Code to sign in|\/login|floating|session's menu/i,
    );
  });

  test('[TW-AC-22] el changelog publicado tampoco nombra lo que ya no existe', () => {
    const root = join(import.meta.dir, '../..');
    for (const file of ['manifest.json', 'i18n/en.json']) {
      expect(readFileSync(join(root, file), 'utf8')).not.toMatch(
        /request-sign-in|request-wheel|release-wheel|Take the wheel|Give back to|Give it to|Keep it"/i,
      );
    }
  });
});
