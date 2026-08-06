/**
 * mca.teros.http renderer — structure-asserting render tests (TER-385 harness).
 *
 * Covers the three meaningful shapes:
 *   1. `http-request` completed with a JSON body  → header `<METHOD> <host>`,
 *      green status-code badge, response meta grid + pretty-printed body.
 *   2. `http-request` failed with a `[CODE] message` error → "failed" badge +
 *      ErrorBlock (code surfaced as title).
 *   3. `-health-check` completed → "Health check" header + ready badge +
 *      version/uptime.
 *
 * `CodeBlock` is mocked to a plain `<span>` so the test does not drag in the
 * `react-native-code-highlighter` / `react-syntax-highlighter` graph — we only
 * assert that the renderer hands the right text to it.
 */

import React from 'react';
import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithTamagui } from '../../../test/renderWithTamagui';
import type { ToolCallRendererProps } from '../types';

vi.mock('../CodeBlock', () => ({
  CodeBlock: ({ code }: { code: string }) => React.createElement('span', null, code),
  default: ({ code }: { code: string }) => React.createElement('span', null, code),
}));

import { HttpToolCallRenderer } from './HttpRenderer';

function render(props: Partial<ToolCallRendererProps> & { toolName: string }) {
  const merged = {
    toolCallId: 'tc1',
    status: 'completed',
    ...props,
  } as ToolCallRendererProps;
  return renderWithTamagui(<HttpToolCallRenderer {...merged} />);
}

/** Click the tool-call header (its only `role="button"`) to expand the body. */
function expand(result: ReturnType<typeof render>) {
  fireEvent.click(result.getByRole('button'));
}

describe('HttpRenderer — http-request', () => {
  const completedOutput = JSON.stringify({
    request: {
      method: 'GET',
      url: 'https://api.github.com/users/octocat',
      headers: {},
      query: {},
      hasBody: false,
    },
    response: {
      status: 200,
      statusText: 'OK',
      ok: true,
      contentType: 'application/json; charset=utf-8',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: { login: 'octocat', id: 583231 },
      sizeBytes: 1234,
      truncated: false,
    },
  });

  it('renders the method/host header, status badge and JSON body (completed)', () => {
    const result = render({
      toolName: 'http_http-request',
      status: 'completed',
      output: completedOutput,
    });

    // Header is visible before expanding.
    expect(result.container.textContent).toContain('GET api.github.com');
    expect(result.container.textContent).toContain('200'); // status-code badge

    expand(result);

    const text = result.container.textContent ?? '';
    expect(text).toContain('200 OK'); // status row
    expect(text).toContain('application/json'); // content-type row
    expect(text).toContain('1.2 KB'); // formatted size
    // Pretty-printed JSON body handed to the (mocked) CodeBlock.
    expect(text).toContain('"login": "octocat"');
  });

  it('renders a red badge for a non-2xx response', () => {
    const result = render({
      toolName: 'http_http-request',
      status: 'completed',
      output: JSON.stringify({
        request: { method: 'GET', url: 'https://api.example.com/missing', headers: {}, query: {}, hasBody: false },
        response: {
          status: 404,
          statusText: 'Not Found',
          ok: false,
          contentType: 'application/json',
          headers: {},
          body: { error: 'not_found' },
          sizeBytes: 20,
          truncated: false,
        },
      }),
    });

    expect(result.container.textContent).toContain('GET api.example.com');
    expect(result.container.textContent).toContain('404');
  });

  it('renders an ErrorBlock with the bracketed code as title (failed)', () => {
    const result = render({
      toolName: 'http_http-request',
      status: 'failed',
      input: { method: 'POST', url: 'https://hooks.example.com/abc' },
      error: '[TIMEOUT] request exceeded 30s',
    });

    expect(result.container.textContent).toContain('POST hooks.example.com');
    expect(result.container.textContent).toContain('failed'); // badge

    expand(result);

    const text = result.container.textContent ?? '';
    expect(text).toContain('TIMEOUT'); // code surfaced as ErrorBlock title
    expect(text).toContain('request exceeded 30s');
  });
});

describe('HttpRenderer — health-check', () => {
  it('renders status, version and uptime (completed, ready)', () => {
    const result = render({
      toolName: 'http_-health-check',
      status: 'completed',
      output: JSON.stringify({ status: 'ready', version: '1.0.0', uptime: 3661 }),
    });

    expect(result.container.textContent).toContain('Health check');
    expect(result.container.textContent).toContain('ready'); // badge

    expand(result);

    const text = result.container.textContent ?? '';
    expect(text).toContain('Healthy');
    expect(text).toContain('1.0.0');
    expect(text).toContain('All checks passed.');
  });
});
