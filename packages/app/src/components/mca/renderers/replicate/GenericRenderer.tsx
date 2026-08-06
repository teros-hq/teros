/**
 * Replicate Renderer — Generic tools (replicate-run, get-prediction).
 *
 * Post Follow-up E migration: composes global primitives directly. No
 * local HeaderRow / ExpandedContainer / Badge — each rendered card is a
 * `<ToolCallCard>` with body composed inline.
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import { Badge, colors, ErrorBlock, formatOutput, KeyValueGrid, ToolCallCard, useColors } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  extractMediaUrls,
  getModelDisplayName,
  parseOutput,
  REPLICATE_ICON,
  replicateBadgeProps,
  truncate,
} from './shared';

// ─── Image preview ─────────────────────────────────────────────────────────

function ImagePreview({ urls }: { urls: string[] }) {
  const c = useColors()
  if (urls.length === 0) return null;
  return (
    <YStack gap={6}>
      {urls.map((url) => (
        <YStack key={url} backgroundColor={c.bgInner} borderRadius={6} overflow="hidden">
          <Image
            source={{ uri: url }}
            style={{ width: '100%', height: 200, resizeMode: 'contain' }}
          />
        </YStack>
      ))}
    </YStack>
  );
}

// ─── Generic Run Renderer (replicate-run) ─────────────────────────────────

interface GenericRunOutput {
  output?: unknown;
  url?: string;
  status?: string;
  metrics?: { predict_time?: number };
  model?: string;
  error?: string;
}

export function GenericRunRenderer(props: ToolCallRendererProps) {
  const c = useColors()
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { input, status, output, error, duration } = props;

  const model = (input?.model as string | undefined) ?? 'unknown';
  const modelDisplay = getModelDisplayName(model);
  const prompt = (input?.input as Record<string, unknown> | undefined)?.prompt as string | undefined;
  const parsedOutput = parseOutput<GenericRunOutput>(output);
  const mediaUrls = extractMediaUrls(parsedOutput);

  const isImage =
    model.includes('flux') ||
    model.includes('stable') ||
    model.includes('sdxl') ||
    mediaUrls.some((url) => /\.(png|jpe?g|webp)$/i.test(url));

  const badge =
    status === 'failed'
      ? <Badge {...replicateBadgeProps('failed', 'red')} />
      : mediaUrls.length > 0
        ? <Badge {...replicateBadgeProps(`${mediaUrls.length} output${mediaUrls.length > 1 ? 's' : ''}`, 'purple')} />
        : <Badge {...replicateBadgeProps(modelDisplay, 'white')} />;

  const description = prompt ? truncate(prompt, 40) : `Run ${modelDisplay}`;

  // Filter out 'prompt' from input.input — we already show it as a row.
  const inputParams = (input?.input as Record<string, unknown> | undefined) ?? {};
  const paramRows = Object.entries(inputParams)
    .filter(([key]) => key !== 'prompt')
    .map(([key, value]) => ({
      key,
      // Renderer UX Guide §0: objects → `{…}`, arrays → `[…N]`.
      value:
        value === null
          ? 'null'
          : Array.isArray(value)
            ? value.length === 0 ? '[]' : `[…${value.length}]`
            : typeof value === 'object'
              ? '{…}'
              : String(value),
    }));

  return (
    <ToolCallCard
      status={status}
      description={description}
      iconUri={REPLICATE_ICON}
      badge={badge}
      animateExpand
    >
      <KeyValueGrid
        rows={[
          { key: 'Model', value: model, mono: true },
          ...(prompt ? [{ key: 'Prompt', value: prompt }] : []),
        ]}
      />

      {paramRows.length > 0 && (
        <YStack
          backgroundColor={c.bgInner}
          borderRadius={5}
          padding={8}
          paddingHorizontal={10}
          marginTop={6}
        >
          <Text color={c.text3} fontSize={9} marginBottom={4}>
            Parameters
          </Text>
          <XStack gap={6} flexWrap="wrap">
            {paramRows.map((p) => (
              <Badge
                key={p.key}
                {...replicateBadgeProps(`${p.key}: ${truncate(p.value, 20)}`, 'gray')}
              />
            ))}
          </XStack>
        </YStack>
      )}

      {status === 'running' ? (
        <YStack backgroundColor={c.bgInner} borderRadius={5} padding={10} gap={6} marginTop={6}>
          {[100, 95, 88, 60].map((width) => (
            <YStack
              key={width}
              backgroundColor={c.border}
              height={10}
              width={`${width}%`}
              borderRadius={4}
            />
          ))}
        </YStack>
      ) : status === 'failed' ? (
        <ErrorBlock error={error || 'Execution failed'} />
      ) : mediaUrls.length > 0 && isImage ? (
        <ImagePreview urls={mediaUrls} />
      ) : mediaUrls.length > 0 ? (
        <YStack backgroundColor={c.bgInner} borderRadius={5} padding={10} gap={4} marginTop={6}>
          <Text color={c.text3} fontSize={9}>
            Output URLs
          </Text>
          {mediaUrls.map((url) => (
            <Text key={url} color={c.text2} fontSize={9} fontFamily="$mono" numberOfLines={1}>
              {url}
            </Text>
          ))}
        </YStack>
      ) : parsedOutput ? (
        <YStack backgroundColor={c.bgInner} borderRadius={5} padding={10} marginTop={6}>
          <Text color={c.text2} fontSize={10} numberOfLines={10}>
            {typeof parsedOutput === 'string'
              ? parsedOutput
              : formatOutput(JSON.stringify(parsedOutput))}
          </Text>
        </YStack>
      ) : null}
    </ToolCallCard>
  );
}

// ─── Get Prediction Renderer ──────────────────────────────────────────────

export function GetPredictionRenderer(props: ToolCallRendererProps) {
  const c = useColors()
  const { input, status, output, error } = props;

  const predictionId = (input?.predictionId as string | undefined) ?? '';
  const parsedOutput = parseOutput<GenericRunOutput>(output);
  const predictionStatus = parsedOutput?.status;

  const badge =
    status === 'failed'
      ? <Badge {...replicateBadgeProps('failed', 'red')} />
      : predictionStatus === 'succeeded'
        ? <Badge {...replicateBadgeProps('succeeded', 'success')} />
        : predictionStatus === 'failed'
          ? <Badge {...replicateBadgeProps('pred failed', 'red')} />
          : <Badge {...replicateBadgeProps('status', 'gray')} />;

  const description = `Get prediction ${truncate(predictionId, 20)}`;

  return (
    <ToolCallCard
      status={status}
      description={description}
      iconUri={REPLICATE_ICON}
      badge={badge}
      animateExpand
    >
      <KeyValueGrid
        rows={[
          { key: 'Prediction ID', value: predictionId, mono: true },
          ...(parsedOutput?.model ? [{ key: 'Model', value: parsedOutput.model, mono: true }] : []),
        ]}
      />

      {status === 'completed' && parsedOutput?.status && (
        <XStack gap={6} marginTop={6}>
          <Badge
            {...replicateBadgeProps(
              parsedOutput.status,
              parsedOutput.status === 'succeeded'
                ? 'success'
                : parsedOutput.status === 'failed'
                  ? 'red'
                  : 'gray',
            )}
          />
          {parsedOutput.metrics?.predict_time !== undefined && (
            <Badge
              {...replicateBadgeProps(
                `${parsedOutput.metrics.predict_time.toFixed(2)}s`,
                'gray',
              )}
            />
          )}
        </XStack>
      )}

      {status === 'completed' && parsedOutput?.output != null && (
        <YStack backgroundColor={c.bgInner} borderRadius={5} padding={10} marginTop={6}>
          <Text color={c.text3} fontSize={9} marginBottom={4}>
            Output
          </Text>
          <Text color={c.text2} fontSize={10} numberOfLines={5}>
            {typeof parsedOutput.output === 'string'
              ? parsedOutput.output
              : formatOutput(JSON.stringify(parsedOutput.output))}
          </Text>
        </YStack>
      )}

      {parsedOutput?.error && <ErrorBlock error={parsedOutput.error} />}

      {status === 'failed' && <ErrorBlock error={error || 'Prediction failed'} />}
    </ToolCallCard>
  );
}
