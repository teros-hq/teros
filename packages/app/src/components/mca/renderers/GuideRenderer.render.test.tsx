/**
 * Render test for the Teros Guide renderer (TER-583).
 *
 * Mordedura: afirma que el header compone el tense correcto a partir del
 * `output` REAL del backend (los datos serializados como texto plano), tolera
 * además el wrapper legacy `{content, structuredContent}`, y pinta el
 * badge/health correctos. El parsing del output es la clase de bug que importa
 * (cambio de significado del shape). El body expandido (EntityRows /
 * MarkdownContent) lo valida el smoke en vivo.
 *
 * `MarkdownContent` se mockea: arrastra react-native-webview y no aporta nada
 * al header bajo test.
 */

import { describe, expect, it, vi } from 'vitest';
import { Text } from 'tamagui';
import { renderWithTamagui } from '../../../test/renderWithTamagui';
import type { ToolCallRendererProps } from '../types';

vi.mock('../../chat/bubbles/MarkdownContent', () => ({
  MarkdownContent: ({ text }: { text: string }) => <Text>{text}</Text>,
}));

// Imported AFTER the mock is registered.
const { GuideToolCallRenderer } = await import('./GuideRenderer');

/** Production output: the backend serializes the handler's plain data object. */
function out(data: unknown): string {
  return JSON.stringify(data);
}

/** Legacy wrapper shape `{content, structuredContent}` — `unwrap` must tolerate it. */
function wrapped(structuredContent: unknown): string {
  return JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  });
}

function renderTool(props: Partial<ToolCallRendererProps>) {
  return renderWithTamagui(
    <GuideToolCallRenderer
      toolCallId="tc1"
      toolName={props.toolName ?? 'list-guide-topics'}
      status={props.status ?? 'completed'}
      {...props}
    />,
  );
}

describe('GuideRenderer — list-guide-topics', () => {
  it('composes the past tense with the parsed count (plain output)', () => {
    const topics = Array.from({ length: 12 }, (_v, i) => ({
      id: `t${i}`,
      title: `Topic ${i}`,
      summary: `Summary ${i}`,
    }));
    const { getByText } = renderTool({
      toolName: 'list-guide-topics',
      status: 'completed',
      output: out({ topics, count: 12 }),
    });
    expect(getByText('Listed 12 guide topics')).toBeTruthy();
  });

  it('tolerates the legacy {content, structuredContent} wrapper — defensive parsing', () => {
    const { getByText } = renderTool({
      toolName: 'list-guide-topics',
      status: 'completed',
      output: wrapped({ topics: [{ id: 'a', title: 'A', summary: 's' }], count: 1 }),
    });
    expect(getByText('Listed 1 guide topics')).toBeTruthy();
  });

  it('running state shows the present tense, no crash without output', () => {
    const { getByText } = renderTool({ toolName: 'list-guide-topics', status: 'running' });
    // present tense appends an ellipsis ("…"), so match by substring
    expect(getByText(/Reading the guide index/)).toBeTruthy();
  });
});

describe('GuideRenderer — search-guide', () => {
  it('shows the query in the header and renders results', () => {
    const { getByText } = renderTool({
      toolName: 'search-guide',
      status: 'completed',
      input: { query: 'create an agent' },
      output: out({
        query: 'create an agent',
        results: [
          { id: 'agents', title: 'Agents', summary: 's', score: 38, snippet: 'Open the Create Agent window…' },
        ],
        count: 1,
      }),
    });
    expect(getByText('Guide search: "create an agent"')).toBeTruthy();
  });

  it('running state shows the present tense', () => {
    const { getByText } = renderTool({ toolName: 'search-guide', status: 'running' });
    expect(getByText(/Searching the guide/)).toBeTruthy();
  });
});

describe('GuideRenderer — get-guide-section', () => {
  it('shows the section title in the header on completed', () => {
    const { getByText } = renderTool({
      toolName: 'get-guide-section',
      status: 'completed',
      input: { topic: 'agents' },
      output: out({
        id: 'agents',
        title: 'Agents',
        summary: 'How to create and edit agents.',
        body: '# Agents\n\nOpen **Create Agent**.',
        related: [],
      }),
    });
    expect(getByText('Guide: Agents')).toBeTruthy();
  });

  it('failed state composes the failure tense', () => {
    const { getByText } = renderTool({
      toolName: 'get-guide-section',
      status: 'failed',
      input: { topic: 'agents' },
      error: 'boom',
    });
    expect(getByText(/Failed to open the guide section/)).toBeTruthy();
  });
});

describe('GuideRenderer — -health-check', () => {
  it('shows a healthy badge when status is ready and no issues', () => {
    const { getByText } = renderTool({
      toolName: '-health-check',
      status: 'completed',
      output: out({ status: 'ready', version: '1.0.0' }),
    });
    expect(getByText('healthy')).toBeTruthy();
  });

  it('shows degraded when the result reports issues', () => {
    const { getByText } = renderTool({
      toolName: '-health-check',
      status: 'completed',
      output: out({
        status: 'not_ready',
        issues: [{ code: 'DEPENDENCY_UNAVAILABLE', message: 'empty' }],
      }),
    });
    expect(getByText('degraded')).toBeTruthy();
  });
});
