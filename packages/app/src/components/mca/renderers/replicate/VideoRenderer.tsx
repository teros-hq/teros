/**
 * Replicate Renderer - Video Generation Tools
 *
 * Handles Minimax, Veo, and other video generation models.
 * Shows prompt, model info, and video preview/URL.
 */

import { ExternalLink, Play, Video } from '@tamagui/lucide-icons';
import React, { useState } from 'react';
import { Text, XStack, YStack } from 'tamagui';

import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  colors,
  ErrorBlock,
  ExpandedBody,
  ExpandedContainer,
  extractMediaUrls,
  HeaderRow,
  InfoBlock,
  LoadingPlaceholder,
  parseOutput,
  truncate,
} from './shared';

// ============================================================================
// Video Preview Component
// ============================================================================

interface VideoPreviewProps {
  url: string;
}

function VideoPreview({ url }: VideoPreviewProps) {
  return (
    <YStack
      backgroundColor={colors.bgInner}
      borderRadius={6}
      overflow="hidden"
      gap={8}
      padding={10}
    >
      {/* Video placeholder with play icon */}
      <YStack
        backgroundColor="rgba(0,0,0,0.3)"
        borderRadius={4}
        height={120}
        alignItems="center"
        justifyContent="center"
      >
        <XStack backgroundColor="rgba(139,92,246,0.2)" borderRadius={999} padding={12}>
          <Play size={24} color={colors.badgePurple.text} fill={colors.badgePurple.text} />
        </XStack>
      </YStack>

      {/* URL */}
      <XStack alignItems="center" gap={6}>
        <ExternalLink size={10} color={colors.muted} />
        <Text color={colors.secondary} fontSize={9} fontFamily="$mono" numberOfLines={1} flex={1}>
          {url}
        </Text>
      </XStack>
    </YStack>
  );
}

// ============================================================================
// Minimax Video Renderer
// ============================================================================

export function MinimaxVideoRenderer(props: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const { input, status, output, error, duration } = props;

  const prompt = input?.prompt || '';
  const hasFirstFrame = !!input?.first_frame_image;
  const hasSubjectRef = !!input?.subject_reference;
  const mode = hasFirstFrame ? 'I2V' : hasSubjectRef ? 'S2V' : 'T2V';

  const parsedOutput = parseOutput(output);
  const videoUrls = extractMediaUrls(parsedOutput);

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : videoUrls.length > 0
        ? { text: 'ready', variant: 'blue' as const }
        : { text: mode, variant: 'white' as const };

  const headerProps = {
    status,
    description: truncate(prompt, 50) || 'Minimax video generation',
    duration,
    badge,
    expanded,
    onToggle: () => setExpanded(!expanded),
    icon: 'video' as const,
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
          <Badge text="minimax-video-01" variant="white" />
          <Badge text={mode} variant="purple" />
          {input?.prompt_optimizer && <Badge text="optimizer" variant="gray" />}
        </XStack>

        {/* Prompt */}
        <InfoBlock label="Prompt" value={prompt} />

        {/* Reference images if present */}
        {hasFirstFrame && (
          <InfoBlock label="First Frame (I2V)" value={input.first_frame_image} mono />
        )}
        {hasSubjectRef && (
          <InfoBlock label="Subject Reference (S2V)" value={input.subject_reference} mono />
        )}

        {/* Output */}
        {status === 'running' ? (
          <LoadingPlaceholder icon="video" />
        ) : status === 'failed' ? (
          <ErrorBlock error={error || 'Generation failed'} />
        ) : videoUrls.length > 0 ? (
          <VideoPreview url={videoUrls[0]} />
        ) : (
          <YStack backgroundColor={colors.bgInner} borderRadius={5} padding={10}>
            <Text color={colors.secondary} fontSize={10}>
              No video in output
            </Text>
          </YStack>
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// ============================================================================
// Veo Video Renderer
// ============================================================================

export function VeoVideoRenderer(props: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const { input, status, output, error, duration } = props;

  const prompt = input?.prompt || '';
  const videoDuration = input?.duration || 8;
  const resolution = input?.resolution || '1080p';
  const aspectRatio = input?.aspect_ratio || '16:9';
  const generateAudio = input?.generate_audio !== false;

  const parsedOutput = parseOutput(output);
  const videoUrls = extractMediaUrls(parsedOutput);

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : videoUrls.length > 0
        ? { text: 'ready', variant: 'blue' as const }
        : { text: 'veo-3.1', variant: 'white' as const };

  const headerProps = {
    status,
    description: truncate(prompt, 50) || 'Veo video generation',
    duration,
    badge,
    expanded,
    onToggle: () => setExpanded(!expanded),
    icon: 'video' as const,
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
          <Badge text="veo-3.1" variant="white" />
          <Badge text={`${videoDuration}s`} variant="gray" />
          <Badge text={resolution} variant="gray" />
          <Badge text={aspectRatio} variant="gray" />
          {generateAudio && <Badge text="audio" variant="blue" />}
        </XStack>

        {/* Prompt */}
        <InfoBlock label="Prompt" value={prompt} />

        {/* Negative prompt if present */}
        {input?.negative_prompt && (
          <InfoBlock label="Negative Prompt" value={input.negative_prompt} />
        )}

        {/* Reference images if present */}
        {input?.image && <InfoBlock label="Input Image" value={input.image} mono />}
        {input?.last_frame && <InfoBlock label="Last Frame" value={input.last_frame} mono />}

        {/* Output */}
        {status === 'running' ? (
          <LoadingPlaceholder icon="video" />
        ) : status === 'failed' ? (
          <ErrorBlock error={error || 'Generation failed'} />
        ) : videoUrls.length > 0 ? (
          <VideoPreview url={videoUrls[0]} />
        ) : (
          <YStack backgroundColor={colors.bgInner} borderRadius={5} padding={10}>
            <Text color={colors.secondary} fontSize={10}>
              No video in output
            </Text>
          </YStack>
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}
