/**
 * Replicate Renderer - Generic Tools
 *
 * Handles replicate-run (any model) and replicate-get-prediction.
 * Shows model info, inputs, and outputs with smart detection.
 */

import { Image as ImageIcon, Play, Search, Video } from '@tamagui/lucide-icons';
import React, { useState } from 'react';
import { Image } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  colors,
  ErrorBlock,
  ExpandedBody,
  ExpandedContainer,
  extractMediaUrls,
  getModelDisplayName,
  HeaderRow,
  InfoBlock,
  LoadingPlaceholder,
  parseOutput,
  truncate,
} from './shared';

// ============================================================================
// Image Preview Component
// ============================================================================

interface ImagePreviewProps {
  urls: string[];
}

function ImagePreview({ urls }: ImagePreviewProps) {
  if (urls.length === 0) return null;

  return (
    <YStack gap={6}>
      {urls.map((url, idx) => (
        <YStack key={idx} backgroundColor={colors.bgInner} borderRadius={6} overflow="hidden">
          <Image
            source={{ uri: url }}
            style={{
              width: '100%',
              height: 200,
              resizeMode: 'contain',
            }}
          />
        </YStack>
      ))}
    </YStack>
  );
}

// ============================================================================
// Generic Run Renderer
// ============================================================================

export function GenericRunRenderer(props: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const { input, status, output, error, duration } = props;

  const model = input?.model || 'unknown';
  const modelDisplay = getModelDisplayName(model);
  const prompt = input?.input?.prompt || '';
  const parsedOutput = parseOutput(output);
  const mediaUrls = extractMediaUrls(parsedOutput);

  // Detect if it's likely an image or video model
  const isVideo = model.includes('video') || model.includes('minimax') || model.includes('veo');
  const isImage =
    model.includes('flux') ||
    model.includes('stable') ||
    model.includes('sdxl') ||
    mediaUrls.some((url) => url.includes('.png') || url.includes('.jpg') || url.includes('.webp'));

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : mediaUrls.length > 0
        ? {
            text: `${mediaUrls.length} output${mediaUrls.length > 1 ? 's' : ''}`,
            variant: 'purple' as const,
          }
        : { text: modelDisplay, variant: 'white' as const };

  const headerProps = {
    status,
    description: prompt ? truncate(prompt, 40) : `Run ${modelDisplay}`,
    duration,
    badge,
    expanded,
    onToggle: () => setExpanded(!expanded),
    icon: isVideo ? ('video' as const) : isImage ? ('image' as const) : undefined,
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        {/* Model */}
        <InfoBlock label="Model" value={model} mono />

        {/* Prompt if present */}
        {prompt && <InfoBlock label="Prompt" value={prompt} />}

        {/* Other input params */}
        {input?.input && Object.keys(input.input).length > 0 && (
          <YStack
            backgroundColor={colors.bgInnerDark}
            borderRadius={5}
            padding={8}
            paddingHorizontal={10}
          >
            <Text color={colors.muted} fontSize={9} marginBottom={4}>
              Parameters
            </Text>
            <XStack gap={6} flexWrap="wrap">
              {Object.entries(input.input).map(([key, value]) => {
                if (key === 'prompt') return null;
                const displayValue =
                  typeof value === 'object' ? JSON.stringify(value) : String(value);
                return (
                  <React.Fragment key={key}>
                    <Badge text={`${key}: ${truncate(displayValue, 20)}`} variant="gray" />
                  </React.Fragment>
                );
              })}
            </XStack>
          </YStack>
        )}

        {/* Output */}
        {status === 'running' ? (
          <YStack backgroundColor={colors.bgInner} borderRadius={5} padding={10} gap={6}>
            {[100, 95, 88, 60].map((width, idx) => (
              <YStack
                key={idx}
                backgroundColor="rgba(255,255,255,0.04)"
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
          <YStack backgroundColor={colors.bgInner} borderRadius={5} padding={10} gap={4}>
            <Text color={colors.muted} fontSize={9}>
              Output URLs
            </Text>
            {mediaUrls.map((url, idx) => (
              <Text
                key={idx}
                color={colors.secondary}
                fontSize={9}
                fontFamily="$mono"
                numberOfLines={1}
              >
                {url}
              </Text>
            ))}
          </YStack>
        ) : parsedOutput ? (
          <YStack backgroundColor={colors.bgInner} borderRadius={5} padding={10}>
            <Text color={colors.secondary} fontSize={10} numberOfLines={10}>
              {typeof parsedOutput === 'string'
                ? parsedOutput
                : JSON.stringify(parsedOutput, null, 2)}
            </Text>
          </YStack>
        ) : null}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// ============================================================================
// Get Prediction Renderer
// ============================================================================

export function GetPredictionRenderer(props: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const { input, status, output, error, duration } = props;

  const predictionId = input?.predictionId || '';
  const parsedOutput = parseOutput(output);
  const predictionStatus = parsedOutput?.status;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : predictionStatus === 'succeeded'
        ? { text: 'succeeded', variant: 'success' as const }
        : predictionStatus === 'failed'
          ? { text: 'pred failed', variant: 'red' as const }
          : { text: 'status', variant: 'gray' as const };

  const headerProps = {
    status,
    description: `Get prediction ${truncate(predictionId, 20)}`,
    duration,
    badge,
    expanded,
    onToggle: () => setExpanded(!expanded),
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        {/* Prediction ID */}
        <InfoBlock label="Prediction ID" value={predictionId} mono />

        {/* Prediction details */}
        {status === 'completed' && parsedOutput && (
          <>
            {parsedOutput.model && <InfoBlock label="Model" value={parsedOutput.model} mono />}

            {parsedOutput.status && (
              <XStack gap={6}>
                <Badge
                  text={parsedOutput.status}
                  variant={
                    parsedOutput.status === 'succeeded'
                      ? 'success'
                      : parsedOutput.status === 'failed'
                        ? 'red'
                        : 'gray'
                  }
                />
                {parsedOutput.metrics?.predict_time && (
                  <Badge text={`${parsedOutput.metrics.predict_time.toFixed(2)}s`} variant="gray" />
                )}
              </XStack>
            )}

            {/* Output URLs */}
            {parsedOutput.output && (
              <YStack backgroundColor={colors.bgInner} borderRadius={5} padding={10}>
                <Text color={colors.muted} fontSize={9} marginBottom={4}>
                  Output
                </Text>
                <Text color={colors.secondary} fontSize={10} numberOfLines={5}>
                  {typeof parsedOutput.output === 'string'
                    ? parsedOutput.output
                    : JSON.stringify(parsedOutput.output, null, 2)}
                </Text>
              </YStack>
            )}

            {parsedOutput.error && <ErrorBlock error={parsedOutput.error} />}
          </>
        )}

        {status === 'failed' && <ErrorBlock error={error || 'Failed to get prediction'} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}
