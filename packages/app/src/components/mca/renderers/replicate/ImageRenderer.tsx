/**
 * Replicate Renderer - Image Generation Tools
 *
 * Handles FLUX and other image generation models.
 * Shows prompt, model info, and generated image preview.
 */

import { Image as ImageIcon } from '@tamagui/lucide-icons';
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
  getShortToolName,
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
// FLUX Pro Renderer
// ============================================================================

export function FluxProRenderer(props: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const { input, status, output, error, duration } = props;

  const prompt = input?.prompt || '';
  const aspectRatio = input?.aspect_ratio || '16:9';
  const parsedOutput = parseOutput(output);
  const imageUrls = extractMediaUrls(parsedOutput);

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : imageUrls.length > 0
        ? {
            text: `${imageUrls.length} image${imageUrls.length > 1 ? 's' : ''}`,
            variant: 'purple' as const,
          }
        : { text: 'flux-pro', variant: 'white' as const };

  const headerProps = {
    status,
    description: truncate(prompt, 50) || 'FLUX Pro generation',
    duration,
    badge,
    expanded,
    onToggle: () => setExpanded(!expanded),
    icon: 'image' as const,
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        {/* Settings */}
        <XStack gap={6} flexWrap="wrap">
          <Badge text="flux-1.1-pro" variant="white" />
          <Badge text={aspectRatio} variant="gray" />
          {input?.output_format && <Badge text={input.output_format} variant="gray" />}
          {input?.safety_tolerance && (
            <Badge text={`safety: ${input.safety_tolerance}`} variant="gray" />
          )}
        </XStack>

        {/* Prompt */}
        <InfoBlock label="Prompt" value={prompt} />

        {/* Output */}
        {status === 'running' ? (
          <LoadingPlaceholder icon="image" />
        ) : status === 'failed' ? (
          <ErrorBlock error={error || 'Generation failed'} />
        ) : imageUrls.length > 0 ? (
          <ImagePreview urls={imageUrls} />
        ) : (
          <YStack backgroundColor={colors.bgInner} borderRadius={5} padding={10}>
            <Text color={colors.secondary} fontSize={10}>
              No images in output
            </Text>
          </YStack>
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// ============================================================================
// FLUX Dev Renderer
// ============================================================================

export function FluxDevRenderer(props: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const { input, status, output, error, duration } = props;

  const prompt = input?.prompt || '';
  const aspectRatio = input?.aspect_ratio || '16:9';
  const numOutputs = input?.num_outputs || 1;
  const parsedOutput = parseOutput(output);
  const imageUrls = extractMediaUrls(parsedOutput);

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : imageUrls.length > 0
        ? {
            text: `${imageUrls.length} image${imageUrls.length > 1 ? 's' : ''}`,
            variant: 'purple' as const,
          }
        : { text: 'flux-dev', variant: 'white' as const };

  const headerProps = {
    status,
    description: truncate(prompt, 50) || 'FLUX Dev generation',
    duration,
    badge,
    expanded,
    onToggle: () => setExpanded(!expanded),
    icon: 'image' as const,
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        {/* Settings */}
        <XStack gap={6} flexWrap="wrap">
          <Badge text="flux-dev" variant="white" />
          <Badge text={aspectRatio} variant="gray" />
          {numOutputs > 1 && <Badge text={`${numOutputs} outputs`} variant="gray" />}
          {input?.output_format && <Badge text={input.output_format} variant="gray" />}
        </XStack>

        {/* Prompt */}
        <InfoBlock label="Prompt" value={prompt} />

        {/* Output */}
        {status === 'running' ? (
          <LoadingPlaceholder icon="image" />
        ) : status === 'failed' ? (
          <ErrorBlock error={error || 'Generation failed'} />
        ) : imageUrls.length > 0 ? (
          <ImagePreview urls={imageUrls} />
        ) : (
          <YStack backgroundColor={colors.bgInner} borderRadius={5} padding={10}>
            <Text color={colors.secondary} fontSize={10}>
              No images in output
            </Text>
          </YStack>
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// ============================================================================
// FLUX 2 Renderer (Pro, Dev, Flex)
// ============================================================================

export function Flux2Renderer(props: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const { toolName, input, status, output, error, duration } = props;

  const shortName = getShortToolName(toolName);
  const variant = shortName.includes('pro') ? 'pro' : shortName.includes('flex') ? 'flex' : 'dev';

  const prompt = input?.prompt || '';
  const width = input?.width || 1024;
  const height = input?.height || 1024;
  const parsedOutput = parseOutput(output);
  const imageUrls = extractMediaUrls(parsedOutput);

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : imageUrls.length > 0
        ? {
            text: `${imageUrls.length} image${imageUrls.length > 1 ? 's' : ''}`,
            variant: 'purple' as const,
          }
        : { text: `flux-2-${variant}`, variant: 'white' as const };

  const headerProps = {
    status,
    description: truncate(prompt, 50) || `FLUX 2 ${variant} generation`,
    duration,
    badge,
    expanded,
    onToggle: () => setExpanded(!expanded),
    icon: 'image' as const,
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        {/* Settings */}
        <XStack gap={6} flexWrap="wrap">
          <Badge text={`flux-2-${variant}`} variant="white" />
          <Badge text={`${width}x${height}`} variant="gray" />
          {input?.seed && <Badge text={`seed: ${input.seed}`} variant="gray" />}
          {variant === 'flex' && input?.steps && (
            <Badge text={`${input.steps} steps`} variant="gray" />
          )}
          {variant === 'flex' && input?.guidance && (
            <Badge text={`guidance: ${input.guidance}`} variant="gray" />
          )}
        </XStack>

        {/* Prompt */}
        <InfoBlock label="Prompt" value={prompt} />

        {/* Output */}
        {status === 'running' ? (
          <LoadingPlaceholder icon="image" />
        ) : status === 'failed' ? (
          <ErrorBlock error={error || 'Generation failed'} />
        ) : imageUrls.length > 0 ? (
          <ImagePreview urls={imageUrls} />
        ) : (
          <YStack backgroundColor={colors.bgInner} borderRadius={5} padding={10}>
            <Text color={colors.secondary} fontSize={10}>
              No images in output
            </Text>
          </YStack>
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}
