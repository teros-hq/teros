/**
 * mca.make — run-scenario sub-renderer.
 *
 * KeyValueGrid with scenario id, execution id, status and run mode. When the
 * run was `responsive` and produced outputs, they render in a JSON CodeBlock.
 */

import type React from 'react';
import { YStack } from 'tamagui';
import { CodeBlock } from '../../CodeBlock';
import { Badge, ErrorBlock, KeyValueGrid, type KeyValueRow } from '../../primitives';
import type { ToolCallRendererProps, ToolStatus } from '../../types';
import { MakeToolShell, parseMakeOutput, type RunScenarioOutput } from './shared';

function buildRunRows(data: RunScenarioOutput): KeyValueRow[] {
  const rows: KeyValueRow[] = [{ key: 'scenario', value: `#${data.scenarioId}`, mono: true }];
  if (data.executionId) rows.push({ key: 'execution', value: data.executionId, mono: true });
  if (data.status) rows.push({ key: 'status', value: data.status });
  rows.push({ key: 'mode', value: data.responsive ? 'responsive (waited for outputs)' : 'queued' });
  return rows;
}

/** JSON text of the outputs, or '' when there's nothing meaningful to show. */
function runOutputsText(data: RunScenarioOutput): string {
  if (!data.responsive || data.outputs == null) return '';
  const text = JSON.stringify(data.outputs, null, 2);
  return text === '{}' || text === 'null' ? '' : text;
}

function runBadge(status: ToolStatus, data: RunScenarioOutput | null): React.ReactNode {
  if (status === 'failed') return <Badge text="failed" variant="error" />;
  if (!data) return undefined;
  return (
    <Badge
      text={data.responsive ? 'responsive' : 'queued'}
      variant={data.responsive ? 'success' : 'info'}
    />
  );
}

export function RunScenarioRenderer({
  input,
  status,
  output,
  error,
  appIcon,
}: ToolCallRendererProps): React.ReactNode {
  const data = parseMakeOutput<RunScenarioOutput>(output);
  const failed = status === 'failed';
  const scenarioId = data?.scenarioId || String(input?.scenarioId ?? '');
  const outputsText = data ? runOutputsText(data) : '';

  return (
    <MakeToolShell
      toolName="run-scenario"
      status={status}
      appIcon={appIcon}
      badge={runBadge(status, data)}
      defaultExpanded={!failed && Boolean(data)}
    >
      {failed ? (
        <ErrorBlock
          message={error || output || 'Failed to run scenario'}
          title="Run failed"
          hint={scenarioId ? `scenario #${scenarioId}` : undefined}
        />
      ) : data ? (
        <YStack gap={8}>
          <KeyValueGrid rows={buildRunRows(data)} />
          {outputsText ? <CodeBlock code={outputsText} language="json" maxHeight={220} /> : null}
        </YStack>
      ) : null}
    </MakeToolShell>
  );
}
