/**
 * Google Drive - Sharing Renderers
 *
 * Renderers for sharing operations:
 * - share-file
 */

import { User } from '../../primitives';
import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, XStack, YStack } from 'tamagui';

import { Badge, ErrorBlock, ExpandedBody, ExpandedContainer, HeaderRow, SuccessBlock, ToolCallCard } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { useDriveColors, parseOutput, truncate } from './shared';

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
  appIcon,
  input,
}: ToolCallRendererProps) {
  const c = useDriveColors();
  const { t } = useTranslation();
  const colors = useDriveColors();
  const [expanded, setExpanded] = useState(false);

  const parsed = parseOutput<ShareResult>(output || '');
  const result = typeof parsed === 'object' ? parsed : null;
  const isSuccess = result?.success || result?.permission;

  // Get input params
  const inputParsed =
    typeof input === 'string'
      ? parseOutput<{ emailAddress?: string; role?: string }>(input)
      : input;
  const email = (typeof inputParsed === 'object' && inputParsed !== null ? inputParsed.emailAddress : undefined) || result?.permission?.emailAddress || '';
  const role = (typeof inputParsed === 'object' && inputParsed !== null ? inputParsed.role : undefined) || result?.permission?.role || 'reader';

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

  return (
    <ExpandedContainer>
      <HeaderRow
        status={status}
        description={description}
        badge={badge}
        expanded={true}
        onToggle={() => setExpanded(false)}
        isInContainer
      />
      <ExpandedBody>
        {(status === 'failed' || result?.error) && (
          <ErrorBlock error={result?.error || output || t('errors.drive.shareFailed')} />
        )}

      {status === 'completed' && isSuccess && (
        <YStack gap={4}>
          <SuccessBlock message={result?.message || 'File shared successfully'} />

          <XStack
            gap={8}
            alignItems="center"
            paddingVertical={6}
            paddingHorizontal={8}
            backgroundColor={c.bgInner}
            borderRadius={5}
          >
            <User size={12} color={colors.driveBlue} />
            <YStack flex={1}>
              <Text color={c.text} fontSize={10}>
                {email}
              </Text>
              <Text color={c.text3} fontSize={9} textTransform="capitalize">
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
