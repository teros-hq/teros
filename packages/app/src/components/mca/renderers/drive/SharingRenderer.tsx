/**
 * Google Drive - Sharing Renderers
 *
 * Renderers for sharing operations:
 * - share-file
 */

import { Share2, User } from '@tamagui/lucide-icons';
import type React from 'react';
import { useState } from 'react';
import { Text, XStack, YStack } from 'tamagui';

import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  colors,
  ErrorBlock,
  ExpandedBody,
  ExpandedContainer,
  getShortToolName,
  HeaderRow,
  parseOutput,
  SuccessBlock,
  truncate,
} from './shared';

// ============================================================================
// Share File Renderer
// ============================================================================

interface ShareResult {
  success?: boolean;
  message?: string;
  permission?: {
    id?: string;
    type?: string;
    role?: string;
    emailAddress?: string;
  };
  error?: string;
}

export function ShareFileRenderer({
  toolName,
  status,
  output,
  duration,
  input,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const parsed = parseOutput<ShareResult>(output || '');
  const result = typeof parsed === 'object' ? parsed : null;
  const isSuccess = result?.success || result?.permission;

  // Get input params
  const inputParsed =
    typeof input === 'string'
      ? parseOutput<{ emailAddress?: string; role?: string }>(input)
      : input;
  const email = inputParsed?.emailAddress || result?.permission?.emailAddress || '';
  const role = inputParsed?.role || result?.permission?.role || 'reader';

  // Badge
  let badge: React.ReactNode = null;
  if (status === 'completed' && isSuccess) {
    badge = <Badge text="shared" variant="success" />;
  } else if (status === 'failed' || result?.error) {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description =
    status === 'running'
      ? `Share file`
      : email
        ? `Share file → ${truncate(email, 20)}`
        : 'Share file';

  if (!expanded) {
    return (
      <HeaderRow
        status={status}
        description={description}
        duration={duration}
        badge={badge}
        expanded={false}
        onToggle={() => setExpanded(true)}
      />
    );
  }

  return (
    <ExpandedContainer>
      <HeaderRow
        status={status}
        description={description}
        duration={duration}
        badge={badge}
        expanded={true}
        onToggle={() => setExpanded(false)}
        isInContainer
      />
      <ExpandedBody>
        {(status === 'failed' || result?.error) && (
          <ErrorBlock error={result?.error || output || 'Failed to share file'} />
        )}

        {status === 'completed' && isSuccess && (
          <YStack gap={4}>
            <SuccessBlock message={result?.message || 'File shared successfully'} />

            <XStack
              gap={8}
              alignItems="center"
              paddingVertical={6}
              paddingHorizontal={8}
              backgroundColor={colors.bgInner}
              borderRadius={5}
            >
              <User size={12} color={colors.driveBlue} />
              <YStack flex={1}>
                <Text color={colors.primary} fontSize={10}>
                  {email}
                </Text>
                <Text color={colors.muted} fontSize={9} textTransform="capitalize">
                  {role}
                </Text>
              </YStack>
            </XStack>
          </YStack>
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}
