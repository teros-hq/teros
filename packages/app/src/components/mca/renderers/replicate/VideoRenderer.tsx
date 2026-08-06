/**
 * Replicate Renderer — Video generation tools (Minimax, Veo).
 *
 * Same migration pattern as ImageRenderer: composes `<ToolCallCard>` +
 * global primitives. Per-model body differences live inside the renderer;
 * the play-button preview is shared via `<VideoPreview>`.
 */

import { ExternalLink, Play } from '../../primitives';
import { Text, XStack, YStack } from 'tamagui';

import { Badge, colors, ErrorBlock, KeyValueGrid, ToolCallCard, useColors } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  extractMediaUrls,
  LoadingPlaceholder,
  parseOutput,
  REPLICATE_ICON,
  replicateBadgeProps,
  truncate,
} from './shared';

// ─── Video preview ─────────────────────────────────────────────────────────

function VideoPreview({ url }: { url: string }) {
  const c = useColors()
  return (
    <YStack
      backgroundColor={c.bgInner}
      borderRadius={6}
      overflow="hidden"
      gap={8}
      padding={10}
    >
      <YStack
        backgroundColor={c.bgInner}
        borderRadius={4}
        height={120}
        alignItems="center"
        justifyContent="center"
      >
        <XStack backgroundColor="rgba(139,92,246,0.2)" borderRadius={999} padding={12}>
          <Play size={24} color={colors.violet} weight="fill" />
        </XStack>
      </YStack>

      <XStack alignItems="center" gap={6}>
        <ExternalLink size={10} color={c.text3} />
        <Text color={c.text2} fontSize={9} fontFamily="$mono" numberOfLines={1} flex={1}>
          {url}
        </Text>
      </XStack>
    </YStack>
  );
}

function videoBadge(
  status: ToolCallRendererProps['status'],
  videoUrls: string[],
  fallbackLabel: string,
) {
  if (status === 'failed') return <Badge {...replicateBadgeProps('failed', 'red')} />;
  if (videoUrls.length > 0) return <Badge {...replicateBadgeProps('ready', 'blue')} />;
  return <Badge {...replicateBadgeProps(fallbackLabel, 'white')} />;
}

interface VideoBodyProps {
  status: ToolCallRendererProps['status'];
  prompt: string;
  error?: string;
  videoUrls: string[];
  /** Per-model rows (settings chips). */
  settings: React.ReactNode;
  /** Optional KeyValueGrid rows below the prompt (references, negative prompt, …). */
  extraRows?: { key: string; value: string; mono?: boolean }[];
}

function VideoBody({ status, prompt, error, videoUrls, settings, extraRows }: VideoBodyProps) {
  const c = useColors()
  return (
    <>
      <XStack gap={6} flexWrap="wrap">
        {settings}
      </XStack>

      <YStack marginTop={6}>
        <KeyValueGrid
          rows={[
            { key: 'Prompt', value: prompt || '(empty)' },
            ...(extraRows ?? []),
          ]}
        />
      </YStack>

      <YStack marginTop={6}>
        {status === 'running' ? (
          <LoadingPlaceholder icon="video" />
        ) : status === 'failed' ? (
          <ErrorBlock error={error || 'Generation failed'} />
        ) : videoUrls.length > 0 ? (
          <VideoPreview url={videoUrls[0]} />
        ) : (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={10}>
            <Text color={c.text2} fontSize={10}>
              No video in output
            </Text>
          </YStack>
        )}
      </YStack>
    </>
  );
}

// ─── Minimax video ─────────────────────────────────────────────────────────

export function MinimaxVideoRenderer(props: ToolCallRendererProps) {
  const c = useColors()
  const { input, status, output, error } = props;
  const prompt = (input?.prompt as string | undefined) ?? '';
  const firstFrame = input?.first_frame_image as string | undefined;
  const subjectRef = input?.subject_reference as string | undefined;
  const mode: 'I2V' | 'S2V' | 'T2V' = firstFrame ? 'I2V' : subjectRef ? 'S2V' : 'T2V';

  const videoUrls = extractMediaUrls(parseOutput(output));

  return (
    <ToolCallCard
      status={status}
      description={truncate(prompt, 50) || 'Minimax video generation'}
      iconUri={REPLICATE_ICON}
      badge={videoBadge(status, videoUrls, mode)}
      animateExpand
    >
      <VideoBody
        status={status}
        prompt={prompt}
        error={error}
        videoUrls={videoUrls}
        settings={
          <>
            <Badge {...replicateBadgeProps('minimax-video-01', 'white')} />
            <Badge {...replicateBadgeProps(mode, 'purple')} />
            {input?.prompt_optimizer ? <Badge {...replicateBadgeProps('optimizer', 'gray')} /> : null}
          </>
        }
        extraRows={[
          ...(firstFrame ? [{ key: 'First Frame (I2V)', value: firstFrame, mono: true }] : []),
          ...(subjectRef ? [{ key: 'Subject Reference (S2V)', value: subjectRef, mono: true }] : []),
        ]}
      />
    </ToolCallCard>
  );
}

// ─── Veo ───────────────────────────────────────────────────────────────────

export function VeoVideoRenderer(props: ToolCallRendererProps) {
  const c = useColors()
  const { input, status, output, error } = props;
  const prompt = (input?.prompt as string | undefined) ?? '';
  const videoDuration = (input?.duration as number | undefined) ?? 8;
  const resolution = (input?.resolution as string | undefined) ?? '1080p';
  const aspectRatio = (input?.aspect_ratio as string | undefined) ?? '16:9';
  const generateAudio = input?.generate_audio !== false;

  const videoUrls = extractMediaUrls(parseOutput(output));

  return (
    <ToolCallCard
      status={status}
      description={truncate(prompt, 50) || 'Veo video generation'}
      iconUri={REPLICATE_ICON}
      badge={videoBadge(status, videoUrls, 'veo-3.1')}
      animateExpand
    >
      <VideoBody
        status={status}
        prompt={prompt}
        error={error}
        videoUrls={videoUrls}
        settings={
          <>
            <Badge {...replicateBadgeProps('veo-3.1', 'white')} />
            <Badge {...replicateBadgeProps(`${videoDuration}s`, 'gray')} />
            <Badge {...replicateBadgeProps(resolution, 'gray')} />
            <Badge {...replicateBadgeProps(aspectRatio, 'gray')} />
            {generateAudio ? <Badge {...replicateBadgeProps('audio', 'blue')} /> : null}
          </>
        }
        extraRows={[
          ...(input?.negative_prompt
            ? [{ key: 'Negative Prompt', value: String(input.negative_prompt) }]
            : []),
          ...(input?.image ? [{ key: 'Input Image', value: String(input.image), mono: true }] : []),
          ...(input?.last_frame
            ? [{ key: 'Last Frame', value: String(input.last_frame), mono: true }]
            : []),
        ]}
      />
    </ToolCallCard>
  );
}
