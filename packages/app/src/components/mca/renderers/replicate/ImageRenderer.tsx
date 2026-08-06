/**
 * Replicate Renderer — Image generation tools.
 *
 * Handles FLUX Pro, FLUX Dev, FLUX 2 (pro/dev/flex). Each renderer
 * composes `<ToolCallCard>` + global primitives directly. Per-tool
 * differences live in the badges row above the prompt — everything
 * else is shared via `<ImageGenerationBody>`.
 */

import { Image } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import { Badge, colors, ErrorBlock, KeyValueGrid, ToolCallCard, useColors } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  extractMediaUrls,
  getShortToolName,
  LoadingPlaceholder,
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

// ─── Shared body for any image-generation flow ─────────────────────────────

interface ImageGenerationBodyProps {
  status: ToolCallRendererProps['status'];
  prompt: string;
  error?: string;
  imageUrls: string[];
  /** Per-tool settings chips (model, aspect ratio, …). */
  settings: React.ReactNode;
}

function ImageGenerationBody({
  status,
  prompt,
  error,
  imageUrls,
  settings,
}: ImageGenerationBodyProps) {
  const c = useColors()
  return (
    <>
      <XStack gap={6} flexWrap="wrap">
        {settings}
      </XStack>

      <YStack marginTop={6}>
        <KeyValueGrid rows={[{ key: 'Prompt', value: prompt || '(empty)' }]} />
      </YStack>

      <YStack marginTop={6}>
        {status === 'running' ? (
          <LoadingPlaceholder icon="image" />
        ) : status === 'failed' ? (
          <ErrorBlock error={error || 'Generation failed'} />
        ) : imageUrls.length > 0 ? (
          <ImagePreview urls={imageUrls} />
        ) : (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={10}>
            <Text color={c.text2} fontSize={10}>
              No images in output
            </Text>
          </YStack>
        )}
      </YStack>
    </>
  );
}

function imageBadge(status: ToolCallRendererProps['status'], imageUrls: string[], modelLabel: string) {
  if (status === 'failed') return <Badge {...replicateBadgeProps('failed', 'red')} />;
  if (imageUrls.length > 0) {
    return (
      <Badge
        {...replicateBadgeProps(
          `${imageUrls.length} image${imageUrls.length > 1 ? 's' : ''}`,
          'purple',
        )}
      />
    );
  }
  return <Badge {...replicateBadgeProps(modelLabel, 'white')} />;
}

// ─── FLUX Pro ──────────────────────────────────────────────────────────────

export function FluxProRenderer(props: ToolCallRendererProps) {
  const c = useColors()
  const { input, status, output, error } = props;
  const prompt = (input?.prompt as string | undefined) ?? '';
  const aspectRatio = (input?.aspect_ratio as string | undefined) ?? '16:9';
  const imageUrls = extractMediaUrls(parseOutput(output));

  return (
    <ToolCallCard
      status={status}
      description={truncate(prompt, 50) || 'FLUX Pro generation'}
      iconUri={REPLICATE_ICON}
      badge={imageBadge(status, imageUrls, 'flux-pro')}
      animateExpand
    >
      <ImageGenerationBody
        status={status}
        prompt={prompt}
        error={error}
        imageUrls={imageUrls}
        settings={
          <>
            <Badge {...replicateBadgeProps('flux-1.1-pro', 'white')} />
            <Badge {...replicateBadgeProps(aspectRatio, 'gray')} />
            {input?.output_format !== undefined && (
              <Badge {...replicateBadgeProps(String(input.output_format), 'gray')} />
            )}
            {input?.safety_tolerance !== undefined && (
              <Badge {...replicateBadgeProps(`safety: ${input.safety_tolerance}`, 'gray')} />
            )}
          </>
        }
      />
    </ToolCallCard>
  );
}

// ─── FLUX Dev ──────────────────────────────────────────────────────────────

export function FluxDevRenderer(props: ToolCallRendererProps) {
  const c = useColors()
  const { input, status, output, error } = props;
  const prompt = (input?.prompt as string | undefined) ?? '';
  const aspectRatio = (input?.aspect_ratio as string | undefined) ?? '16:9';
  const numOutputs = (input?.num_outputs as number | undefined) ?? 1;
  const imageUrls = extractMediaUrls(parseOutput(output));

  return (
    <ToolCallCard
      status={status}
      description={truncate(prompt, 50) || 'FLUX Dev generation'}
      iconUri={REPLICATE_ICON}
      badge={imageBadge(status, imageUrls, 'flux-dev')}
      animateExpand
    >
      <ImageGenerationBody
        status={status}
        prompt={prompt}
        error={error}
        imageUrls={imageUrls}
        settings={
          <>
            <Badge {...replicateBadgeProps('flux-dev', 'white')} />
            <Badge {...replicateBadgeProps(aspectRatio, 'gray')} />
            {numOutputs > 1 && (
              <Badge {...replicateBadgeProps(`${numOutputs} outputs`, 'gray')} />
            )}
            {input?.output_format !== undefined && (
              <Badge {...replicateBadgeProps(String(input.output_format), 'gray')} />
            )}
          </>
        }
      />
    </ToolCallCard>
  );
}

// ─── FLUX 2 (pro / dev / flex) ─────────────────────────────────────────────

export function Flux2Renderer(props: ToolCallRendererProps) {
  const c = useColors()
  const { toolName, input, status, output, error } = props;
  const shortName = getShortToolName(toolName);
  const flavor: 'pro' | 'flex' | 'dev' = shortName.includes('pro')
    ? 'pro'
    : shortName.includes('flex')
      ? 'flex'
      : 'dev';

  const prompt = (input?.prompt as string | undefined) ?? '';
  const width = (input?.width as number | undefined) ?? 1024;
  const height = (input?.height as number | undefined) ?? 1024;
  const imageUrls = extractMediaUrls(parseOutput(output));

  return (
    <ToolCallCard
      status={status}
      description={truncate(prompt, 50) || `FLUX 2 ${flavor} generation`}
      iconUri={REPLICATE_ICON}
      badge={imageBadge(status, imageUrls, `flux-2-${flavor}`)}
      animateExpand
    >
      <ImageGenerationBody
        status={status}
        prompt={prompt}
        error={error}
        imageUrls={imageUrls}
        settings={
          <>
            <Badge {...replicateBadgeProps(`flux-2-${flavor}`, 'white')} />
            <Badge {...replicateBadgeProps(`${width}x${height}`, 'gray')} />
            {input?.seed !== undefined && (
              <Badge {...replicateBadgeProps(`seed: ${input.seed}`, 'gray')} />
            )}
            {flavor === 'flex' && input?.steps !== undefined && (
              <Badge {...replicateBadgeProps(`${input.steps} steps`, 'gray')} />
            )}
            {flavor === 'flex' && input?.guidance !== undefined && (
              <Badge {...replicateBadgeProps(`guidance: ${input.guidance}`, 'gray')} />
            )}
          </>
        }
      />
    </ToolCallCard>
  );
}
