/**
 * mca.teros.http — `http-request` sub-renderer.
 *
 * Header: `<METHOD> <host>` (e.g. "GET api.hunter.io") + a status-code badge
 * (green when `response.ok`, red otherwise). Body (on expand): the request /
 * response metadata as a `KeyValueGrid` and the raw response body in a
 * `CodeBlock` (pretty-printed when JSON). Errors render an `ErrorBlock`;
 * running / pending render just the header.
 *
 * The backend returns data only (status, headers, body) — never UI strings —
 * so the renderer composes every phrase locally.
 */

import type React from 'react';
import { Text, YStack } from 'tamagui';
import { CodeBlock } from '../../CodeBlock';
import {
  Badge,
  colors,
  ErrorBlock,
  KeyValueGrid,
  type KeyValueRow,
  ToolCallCard,
  useColors,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  bodyToCode,
  formatBytes,
  getHostFromUrl,
  type HttpRequestOutput,
  parseErrorCode,
  parseHttpOutput,
} from './shared';

// ── Meta rows ───────────────────────────────────────────────────────────────

/** Minimal request rows from the input args (no output yet: error / approval). */
function metaRowsFromInput(method: string, rawUrl: string): KeyValueRow[] {
  const rows: KeyValueRow[] = [{ key: 'method', value: method }];
  if (rawUrl) rows.push({ key: 'url', value: rawUrl, mono: true });
  return rows;
}

/** Full request + response rows from a completed call. */
function metaRowsFromResponse(o: HttpRequestOutput): KeyValueRow[] {
  const rows: KeyValueRow[] = [
    { key: 'method', value: o.request.method },
    { key: 'url', value: o.request.url, mono: true },
    { key: 'status', value: `${o.response.status} ${o.response.statusText}`.trim() },
  ];
  if (o.response.contentType) {
    rows.push({ key: 'content-type', value: o.response.contentType, mono: true });
  }
  rows.push({
    key: 'size',
    value: `${formatBytes(o.response.sizeBytes)}${o.response.truncated ? ' (truncated)' : ''}`,
  });
  return rows;
}

// ── Body ──────────────────────────────────────────────────────────────────--

function renderRequestBody(args: {
  status: ToolCallRendererProps['status'];
  error?: string;
  parsed: HttpRequestOutput | null;
  method: string;
  rawUrl: string;
  text3: string;
}): React.ReactNode {
  const { status, error, parsed, method, rawUrl, text3 } = args;

  // Failed → error (with the failing request for context).
  if (status === 'failed' && error) {
    const { title, message } = parseErrorCode(error);
    const rows = metaRowsFromInput(method, rawUrl);
    return (
      <>
        {rows.length > 0 && <KeyValueGrid rows={rows} />}
        <ErrorBlock title={title} message={message} />
      </>
    );
  }

  // Completed → response metadata + raw body.
  if (parsed) {
    const code = bodyToCode(parsed.response.body, parsed.response.contentType);
    return (
      <>
        <KeyValueGrid rows={metaRowsFromResponse(parsed)} />
        {code && (
          <YStack gap={4}>
            <Text color={text3} fontSize={9} fontFamily="$mono" textTransform="uppercase">
              body
            </Text>
            <CodeBlock code={code.code} language={code.language} maxHeight={360} />
          </YStack>
        )}
      </>
    );
  }

  // Awaiting permission → preview what will be sent (informed approval).
  if (status === 'pending_permission') {
    return <KeyValueGrid rows={metaRowsFromInput(method, rawUrl)} />;
  }

  // Running / pending (no output yet) → header only.
  return null;
}

// ── Renderer ────────────────────────────────────────────────────────────────

export function RequestRenderer({
  status,
  input,
  output,
  error,
  appIcon,
}: ToolCallRendererProps) {
  const c = useColors();
  const parsed = parseHttpOutput(output);

  // Description prefers the completed output, falling back to the input args so
  // running / pending / permission cards still read "<METHOD> <host>".
  const method = String(
    parsed?.request.method ?? (typeof input?.method === 'string' ? input.method : 'GET'),
  ).toUpperCase();
  const rawUrl = parsed?.request.url ?? (typeof input?.url === 'string' ? input.url : '');
  const host = getHostFromUrl(rawUrl);
  const description = host ? `${method} ${host}` : method;

  // Badge: HTTP status code (green / red) once completed; "failed" on error.
  let badge: React.ReactNode = null;
  if (parsed) {
    badge = (
      <Badge
        text={String(parsed.response.status)}
        variant={parsed.response.ok ? 'success' : 'error'}
      />
    );
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
      {renderRequestBody({ status, error, parsed, method, rawUrl, text3: c.text3 })}
    </ToolCallCard>
  );
}
