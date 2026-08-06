/**
 * Notion Renderer — File Uploads
 *
 * Renders the result of `upload-file` (3-step Notion v5 lifecycle). Backend
 * returns { fileUploadId, status, name, contentType, sizeBytes }. We surface:
 *  - filename + size + MIME badge
 *  - thumbnail when the upload is an image and the input came as a dataUrl
 *    (we do not echo the binary back from the server — saves wire traffic)
 *  - inline status badge
 */

import { File as FileIcon, FileText, Image as ImageIcon } from '@tamagui/lucide-icons';
import type React from 'react';
import { useState } from 'react';
import { Image, Text, XStack, YStack } from 'tamagui';

import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  colors,
  ErrorBlock,
  ExpandedBody,
  ExpandedContainer,
  HeaderRow,
  parseOutput,
  truncate,
  useNotionColors,
} from './shared';

interface UploadOutput {
  fileUploadId?: string;
  status?: string;
  name?: string;
  contentType?: string;
  sizeBytes?: number;
}

function formatBytes(bytes: number | undefined): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function UploadFileRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const c = useNotionColors();
  const [expanded, setExpanded] = useState(false);
  const parsed = output ? parseOutput<UploadOutput>(output) : null;
  const result =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as UploadOutput) : null;

  const name = result?.name ?? input?.name ?? null;
  const contentType = result?.contentType ?? input?.contentType ?? null;
  const sizeLabel = formatBytes(result?.sizeBytes);
  const isImage = contentType?.startsWith('image/') ?? false;
  const isPdf = contentType === 'application/pdf';

  // Thumbnail comes from the input dataUrl when available — backend doesn't
  // echo the binary back. Skipped on filePath uploads.
  const thumbnailUrl =
    isImage && typeof input?.dataUrl === 'string' ? input.dataUrl : null;

  const description = name ? `Upload ${truncate(name, 30)}` : 'Upload file';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text={result?.status ?? 'uploaded'} variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const headerProps = {
    status,
    description,
    duration,
    badge,
    expanded,
    onToggle: () => setExpanded(!expanded),
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack
          backgroundColor={c.bgInner}
          borderRadius={5}
          paddingVertical={10}
          paddingHorizontal={12}
          gap={8}
        >
          <XStack alignItems="center" gap={10}>
            {thumbnailUrl ? (
              <Image
                source={{ uri: thumbnailUrl }}
                width={48}
                height={48}
                borderRadius={4}
                resizeMode="contain"
              />
            ) : (
              <XStack
                width={48}
                height={48}
                borderRadius={4}
                backgroundColor={c.badgeGray.bg}
                alignItems="center"
                justifyContent="center"
              >
                {isImage ? (
                  <ImageIcon size={20} color={c.badgeGray.text} />
                ) : isPdf ? (
                  <FileText size={20} color={c.badgeGray.text} />
                ) : (
                  <FileIcon size={20} color={c.badgeGray.text} />
                )}
              </XStack>
            )}
            <YStack flex={1} gap={2}>
              <Text color={c.bright} fontSize={12} fontWeight="500" numberOfLines={1}>
                {name ?? 'unnamed'}
              </Text>
              <XStack gap={6} flexWrap="wrap">
                {contentType && (
                  <Text color={c.muted} fontSize={9} fontFamily="$mono">
                    {contentType}
                  </Text>
                )}
                {sizeLabel && (
                  <Text color={c.muted} fontSize={9} fontFamily="$mono">
                    · {sizeLabel}
                  </Text>
                )}
              </XStack>
            </YStack>
          </XStack>
          {result?.fileUploadId && (
            <Text color={c.muted} fontSize={9} fontFamily="$mono">
              upload id: {result.fileUploadId}
            </Text>
          )}
        </YStack>
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}
